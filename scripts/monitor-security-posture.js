#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const { execSync } = require("child_process");

const toInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
};

const run = (cmd) => {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return { ok: true, out: String(out || "") };
  } catch (error) {
    return {
      ok: false,
      out: String(error?.stdout || ""),
      err: String(error?.stderr || error?.message || "unknown error"),
    };
  }
};

const findings = [];
const notes = [];
const BIN = {
  ss: "/usr/bin/ss",
  ufw: "/usr/sbin/ufw",
  sshd: "/usr/sbin/sshd",
  fail2ban: "/usr/bin/fail2ban-client",
  journalctl: "/usr/bin/journalctl",
  curl: "/usr/bin/curl",
};

const addFinding = (severity, check, message, details = "") => {
  findings.push({ severity, check, message, details });
};

const checkApiPortExposure = () => {
  const res = run(`${BIN.ss} -tuln`);
  if (!res.ok) {
    addFinding("medium", "api_ports", "Could not inspect API listening ports", res.err);
    return;
  }

  const lines = res.out.split("\n");
  [3000, 3001, 3002].forEach((port) => {
    const hit = lines.find((line) => line.includes(`:${port}`));
    if (!hit) {
      addFinding("medium", "api_ports", `Port ${port} is not listening (service down?)`);
      return;
    }

    const isLocal = hit.includes(`127.0.0.1:${port}`) || hit.includes(`[::1]:${port}`);
    if (!isLocal) {
      addFinding("high", "api_ports", `Port ${port} is not localhost-bound`, hit.trim());
    }
  });
};

const checkUfwSshScope = () => {
  const res = run(`${BIN.ufw} status`);
  if (!res.ok) {
    addFinding("medium", "ufw", "Could not read UFW status", res.err);
    return;
  }

  const openAnywhere = /22\/tcp\s+ALLOW IN\s+Anywhere(\s|$)/.test(res.out);
  const openAnywhereV6 = /22\/tcp\s*\(v6\)\s+ALLOW IN\s+Anywhere \(v6\)/.test(res.out);

  if (openAnywhere || openAnywhereV6) {
    addFinding(
      "high",
      "ufw_ssh",
      "SSH is open to Anywhere; expected admin IP/VPN allowlist only"
    );
  }
};

const checkSshEffectiveConfig = () => {
  const res = run(`${BIN.sshd} -T`);
  if (!res.ok) {
    addFinding("medium", "sshd", "Could not read effective sshd config", res.err);
    return;
  }

  const lines = res.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const readValue = (key) => {
    const line = lines.find((entry) => entry.startsWith(`${key} `));
    return line ? line.slice(key.length + 1).trim() : "";
  };

  const permitRootLogin = readValue("permitrootlogin");
  const passwordAuth = readValue("passwordauthentication");
  const maxAuthTries = toInt(readValue("maxauthtries"), 6);

  if (permitRootLogin !== "no") {
    addFinding("high", "sshd", "PermitRootLogin should be 'no'", `actual=${permitRootLogin}`);
  }
  if (passwordAuth !== "no") {
    addFinding("high", "sshd", "PasswordAuthentication should be 'no'", `actual=${passwordAuth}`);
  }
  if (maxAuthTries > 5) {
    addFinding("medium", "sshd", "MaxAuthTries is too high", `actual=${maxAuthTries}`);
  }
};

const checkFail2banJail = ({ jail, noteKey, thresholdEnv, thresholdDefault, warningMessage }) => {
  const res = run(`${BIN.fail2ban} status ${jail}`);
  if (!res.ok) {
    addFinding("medium", "fail2ban", `Could not read fail2ban ${jail} status`, res.err);
    return;
  }

  const failed = toInt((res.out.match(/Currently failed:\s*(\d+)/i) || [])[1], 0);
  const banned = toInt((res.out.match(/Currently banned:\s*(\d+)/i) || [])[1], 0);
  notes.push(`${noteKey} failed=${failed} banned=${banned}`);

  const maxFailed = toInt(process.env[thresholdEnv], thresholdDefault);
  if (failed > maxFailed) {
    addFinding("medium", "fail2ban", warningMessage, `jail=${jail} failed=${failed} threshold=${maxFailed}`);
  }
};

const checkFail2ban = () => {
  checkFail2banJail({
    jail: "sshd",
    noteKey: "fail2ban.sshd",
    thresholdEnv: "SECURITY_MONITOR_MAX_FAIL2BAN_FAILED",
    thresholdDefault: 200,
    warningMessage: "High amount of currently failed SSH attempts",
  });

  checkFail2banJail({
    jail: "nginx-minhoo-auth",
    noteKey: "fail2ban.nginx_auth",
    thresholdEnv: "SECURITY_MONITOR_MAX_FAIL2BAN_NGINX_AUTH_FAILED",
    thresholdDefault: 400,
    warningMessage: "High amount of currently failed auth attempts",
  });
};

const checkAuthLogAnomalies = () => {
  const res = run(
    `${BIN.journalctl} -u minhoo-api.service -u minhoo-api-green.service -u minhoo-api-3.service --since '-5 min' --no-pager --output=cat`
  );
  if (!res.ok) {
    addFinding("medium", "auth_logs", "Could not read API journals", res.err);
    return;
  }

  const text = res.out;
  const loginFail = (text.match(/User and\/or Password not valid\./g) || []).length;
  const authErr = (text.match(/AUTH_TOKEN_(INVALID|EXPIRED|MALFORMED|REVOKED|REQUIRED)/g) || []).length;

  notes.push(`auth.logs.5m login_fail=${loginFail} token_errors=${authErr}`);

  const maxLoginFail = toInt(process.env.SECURITY_MONITOR_MAX_LOGIN_FAIL_5M, 60);
  const maxAuthErr = toInt(process.env.SECURITY_MONITOR_MAX_AUTH_ERR_5M, 500);

  if (loginFail > maxLoginFail) {
    addFinding("medium", "auth_logs", "High login failure rate in last 5 minutes", `count=${loginFail} threshold=${maxLoginFail}`);
  }

  if (authErr > maxAuthErr) {
    addFinding("medium", "auth_logs", "High token/auth error volume in last 5 minutes", `count=${authErr} threshold=${maxAuthErr}`);
  }
};

const checkPoweredByLeak = () => {
  const baseUrl = String(process.env.SECURITY_MONITOR_BASE_URL || "https://api.minhoo.xyz").trim();
  const url = `${baseUrl}/api/v1/auth/session/ping`;
  const res = run(`${BIN.curl} -sSI --max-time 8 '${url}'`);
  if (!res.ok) {
    addFinding("medium", "headers", "Could not fetch auth endpoint headers", res.err);
    return;
  }

  if (/^x-powered-by\s*:/im.test(res.out)) {
    addFinding("medium", "headers", "X-Powered-By header is exposed", url);
  }
};

const runChecks = () => {
  checkApiPortExposure();
  checkUfwSshScope();
  checkSshEffectiveConfig();
  checkFail2ban();
  checkAuthLogAnomalies();
  checkPoweredByLeak();
};

runChecks();

const high = findings.filter((finding) => finding.severity === "high");
const medium = findings.filter((finding) => finding.severity === "medium");
const low = findings.filter((finding) => finding.severity === "low");

const status = high.length ? "FAILED" : medium.length ? "WARN" : "OK";
console.log(
  `[security-monitor] status=${status} high=${high.length} medium=${medium.length} low=${low.length}`
);
if (notes.length) {
  for (const note of notes) {
    console.log(`[security-monitor][note] ${note}`);
  }
}
if (findings.length) {
  for (const finding of findings) {
    const details = finding.details ? ` details=${finding.details}` : "";
    console.log(
      `[security-monitor][${finding.severity.toUpperCase()}] ${finding.check}: ${finding.message}${details}`
    );
  }
}

if (high.length) {
  process.exit(2);
}
if (medium.length) {
  process.exit(1);
}
process.exit(0);
