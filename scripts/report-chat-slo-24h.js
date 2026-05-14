#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const { execSync } = require("child_process");

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const toNonNegativeInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const parseArgs = () => {
  const parsed = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || "");
    if (!current.startsWith("--")) continue;
    const eq = current.indexOf("=");
    if (eq > 2) {
      parsed[current.slice(2, eq).trim()] = current.slice(eq + 1).trim();
      continue;
    }
    const key = current.slice(2).trim();
    const next = String(argv[index + 1] || "");
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "1";
    }
  }
  return parsed;
};

const runJournal = ({ service, lookbackHours }) => {
  const cmd = `journalctl -u ${service} --since "${lookbackHours} hours ago" --no-pager -o cat`;
  try {
    return String(execSync(cmd, { encoding: "utf8" }));
  } catch (error) {
    const stderr = String(error?.stderr || "");
    const stdout = String(error?.stdout || "");
    const message = `${stdout}${stderr}`.trim() || String(error?.message || error);
    throw new Error(`journalctl failed: ${message}`);
  }
};

const percentile = (values, p) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length))
  );
  return Number(sorted[index] || 0);
};

const average = (values) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return total / values.length;
};

const parseGlobalMetrics = (line) => {
  const regex =
    /\[chat-slo\] global req=(\d+) p95=([0-9.]+)ms p99=([0-9.]+)ms 4xx=([0-9.]+)% 5xx=([0-9.]+)% 429=([0-9.]+)%/;
  const match = line.match(regex);
  if (!match) return null;
  return {
    requests: Number(match[1] || 0),
    p95_ms: Number(match[2] || 0),
    p99_ms: Number(match[3] || 0),
    rate_4xx_percent: Number(match[4] || 0),
    rate_5xx_percent: Number(match[5] || 0),
    rate_429_percent: Number(match[6] || 0),
  };
};

const parseRouteCheck = (line) => {
  const regex = /\[chat-slo\] (OK|WARNING|FAIL) (.+?): (.+)$/;
  const match = line.match(regex);
  if (!match) return null;
  return {
    status: String(match[1] || "").trim().toLowerCase(),
    label: String(match[2] || "").trim(),
    reason: String(match[3] || "").trim(),
  };
};

const normalizeLabelKey = (label) => String(label || "").trim().toLowerCase();

const summarize = (rawLogs) => {
  const lines = String(rawLogs || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const runs = [];
  const globals = [];
  const routeChecks = new Map();

  let currentRun = null;
  const ensureCurrentRun = () => {
    if (!currentRun) {
      currentRun = {
        at: null,
        global: null,
        checks: [],
        has_fail: false,
        has_warning: false,
        healthy: false,
      };
    }
    return currentRun;
  };
  const pushRunIfCompleted = () => {
    if (!currentRun) return;
    const done = Boolean(currentRun.global || currentRun.at || currentRun.checks.length > 0);
    if (done) runs.push(currentRun);
    currentRun = null;
  };

  for (const line of lines) {
    if (line.startsWith("[chat-slo] at=")) {
      pushRunIfCompleted();
      const run = ensureCurrentRun();
      run.at = String(line.replace("[chat-slo] at=", "")).trim();
      continue;
    }

    const global = parseGlobalMetrics(line);
    if (global) {
      const run = ensureCurrentRun();
      run.global = global;
      globals.push(global);
      continue;
    }

    const check = parseRouteCheck(line);
    if (check) {
      const run = ensureCurrentRun();
      run.checks.push(check);
      if (check.status === "fail") run.has_fail = true;
      if (check.status === "warning") run.has_warning = true;

      const key = normalizeLabelKey(check.label);
      const aggregate =
        routeChecks.get(key) ||
        {
          label: check.label,
          ok: 0,
          warning: 0,
          fail: 0,
        };
      if (check.status === "ok") aggregate.ok += 1;
      else if (check.status === "warning") aggregate.warning += 1;
      else if (check.status === "fail") aggregate.fail += 1;
      routeChecks.set(key, aggregate);
      continue;
    }

    if (line.includes("[chat-slo] healthy")) {
      const run = ensureCurrentRun();
      run.healthy = true;
      continue;
    }
  }
  pushRunIfCompleted();

  const healthyRuns = runs.filter((run) => run.healthy && !run.has_fail).length;
  const failRuns = runs.filter((run) => run.has_fail).length;
  const warningRuns = runs.filter((run) => run.has_warning).length;

  const requestsValues = globals.map((entry) => Number(entry.requests || 0));
  const p95Values = globals.map((entry) => Number(entry.p95_ms || 0));
  const p99Values = globals.map((entry) => Number(entry.p99_ms || 0));
  const rate5xxValues = globals.map((entry) => Number(entry.rate_5xx_percent || 0));
  const rate429Values = globals.map((entry) => Number(entry.rate_429_percent || 0));
  const rate4xxValues = globals.map((entry) => Number(entry.rate_4xx_percent || 0));

  return {
    lines_total: lines.length,
    runs_total: runs.length,
    runs_healthy: healthyRuns,
    runs_with_fail: failRuns,
    runs_with_warning: warningRuns,
    aggregates: {
      requests_avg: round2(average(requestsValues)),
      requests_p95: round2(percentile(requestsValues, 95)),
      p95_ms_avg: round2(average(p95Values)),
      p95_ms_p95: round2(percentile(p95Values, 95)),
      p99_ms_avg: round2(average(p99Values)),
      rate_5xx_avg_percent: round2(average(rate5xxValues)),
      rate_5xx_p95_percent: round2(percentile(rate5xxValues, 95)),
      rate_429_avg_percent: round2(average(rate429Values)),
      rate_429_p95_percent: round2(percentile(rate429Values, 95)),
      rate_4xx_avg_percent: round2(average(rate4xxValues)),
      rate_4xx_p95_percent: round2(percentile(rate4xxValues, 95)),
    },
    route_checks: Array.from(routeChecks.values()).sort((a, b) =>
      String(a.label || "").localeCompare(String(b.label || ""))
    ),
  };
};

const buildThresholds = (argv) => ({
  minRuns: toPositiveInt(
    argv["min-runs"] || process.env.CHAT_SLO_REPORT_MIN_RUNS || 200,
    200
  ),
  maxFailRuns: toNonNegativeInt(
    argv["max-fail-runs"] || process.env.CHAT_SLO_REPORT_MAX_FAIL_RUNS || 0,
    0
  ),
  maxWarningRuns: toNonNegativeInt(
    argv["max-warning-runs"] || process.env.CHAT_SLO_REPORT_MAX_WARNING_RUNS || 20,
    20
  ),
  maxP95MsP95: toPositiveInt(
    argv["max-p95-ms-p95"] || process.env.CHAT_SLO_REPORT_MAX_P95_MS_P95 || 260,
    260
  ),
  maxRate5xxP95Pct: Number(
    argv["max-5xx-p95-pct"] || process.env.CHAT_SLO_REPORT_MAX_5XX_P95_PERCENT || 1
  ),
  maxRate429P95Pct: Number(
    argv["max-429-p95-pct"] || process.env.CHAT_SLO_REPORT_MAX_429_P95_PERCENT || 6
  ),
});

const evaluate = ({ summary, thresholds }) => {
  const checks = [];
  const failures = [];
  const warnings = [];

  const check = (status, label, reason) => {
    const entry = { status, label, reason };
    checks.push(entry);
    if (status === "fail") failures.push(`${label}: ${reason}`);
    else if (status === "warn") warnings.push(`${label}: ${reason}`);
  };

  if (summary.runs_total < thresholds.minRuns) {
    check(
      "warn",
      "runs_total",
      `insufficient runs (${summary.runs_total}/${thresholds.minRuns})`
    );
  } else {
    check("ok", "runs_total", `runs=${summary.runs_total}`);
  }

  if (summary.runs_with_fail > thresholds.maxFailRuns) {
    check(
      "fail",
      "runs_with_fail",
      `runs_with_fail=${summary.runs_with_fail} > max_fail_runs=${thresholds.maxFailRuns}`
    );
  } else {
    check("ok", "runs_with_fail", `runs_with_fail=${summary.runs_with_fail}`);
  }

  if (summary.runs_with_warning > thresholds.maxWarningRuns) {
    check(
      "warn",
      "runs_with_warning",
      `runs_with_warning=${summary.runs_with_warning} > max_warning_runs=${thresholds.maxWarningRuns}`
    );
  } else {
    check("ok", "runs_with_warning", `runs_with_warning=${summary.runs_with_warning}`);
  }

  if (summary.aggregates.p95_ms_p95 > thresholds.maxP95MsP95) {
    check(
      "fail",
      "p95_ms_p95",
      `p95_ms_p95=${summary.aggregates.p95_ms_p95} > max=${thresholds.maxP95MsP95}`
    );
  } else {
    check("ok", "p95_ms_p95", `p95_ms_p95=${summary.aggregates.p95_ms_p95}`);
  }

  if (summary.aggregates.rate_5xx_p95_percent > thresholds.maxRate5xxP95Pct) {
    check(
      "fail",
      "rate_5xx_p95_percent",
      `rate_5xx_p95_percent=${summary.aggregates.rate_5xx_p95_percent} > max=${thresholds.maxRate5xxP95Pct}`
    );
  } else {
    check(
      "ok",
      "rate_5xx_p95_percent",
      `rate_5xx_p95_percent=${summary.aggregates.rate_5xx_p95_percent}`
    );
  }

  if (summary.aggregates.rate_429_p95_percent > thresholds.maxRate429P95Pct) {
    check(
      "warn",
      "rate_429_p95_percent",
      `rate_429_p95_percent=${summary.aggregates.rate_429_p95_percent} > max=${thresholds.maxRate429P95Pct}`
    );
  } else {
    check(
      "ok",
      "rate_429_p95_percent",
      `rate_429_p95_percent=${summary.aggregates.rate_429_p95_percent}`
    );
  }

  return { checks, failures, warnings };
};

const printHuman = ({ at, service, lookbackHours, summary, thresholds, result }) => {
  console.log(`[chat-slo-24h] at=${at}`);
  console.log(`[chat-slo-24h] service=${service} lookback_hours=${lookbackHours}`);
  console.log(
    `[chat-slo-24h] runs total=${summary.runs_total} healthy=${summary.runs_healthy} warning=${summary.runs_with_warning} fail=${summary.runs_with_fail}`
  );
  console.log(
    `[chat-slo-24h] agg p95_ms_p95=${summary.aggregates.p95_ms_p95} 5xx_p95=${summary.aggregates.rate_5xx_p95_percent}% 429_p95=${summary.aggregates.rate_429_p95_percent}%`
  );
  console.log(
    `[chat-slo-24h] thresholds minRuns=${thresholds.minRuns} maxFailRuns=${thresholds.maxFailRuns} maxWarningRuns=${thresholds.maxWarningRuns} maxP95msP95=${thresholds.maxP95MsP95}`
  );
  for (const check of result.checks) {
    console.log(`[chat-slo-24h] ${String(check.status).toUpperCase()} ${check.label}: ${check.reason}`);
  }
  if (result.failures.length === 0 && result.warnings.length === 0) {
    console.log("[chat-slo-24h] healthy");
  }
};

const main = () => {
  const argv = parseArgs();
  const asJson = isTruthy(argv.json || process.env.CHAT_SLO_REPORT_JSON || "0");
  const strict = isTruthy(argv.strict || process.env.CHAT_SLO_REPORT_STRICT || "1");
  const lookbackHours = toPositiveInt(
    argv.hours || process.env.CHAT_SLO_REPORT_LOOKBACK_HOURS || 24,
    24
  );
  const service = String(
    argv.service || process.env.CHAT_SLO_REPORT_SERVICE || "minhoo-chat-slo-monitor.service"
  ).trim();
  const at = new Date().toISOString();

  try {
    const logs = runJournal({ service, lookbackHours });
    const summary = summarize(logs);
    const thresholds = buildThresholds(argv);
    const result = evaluate({ summary, thresholds });
    const ok = result.failures.length === 0;

    const payload = {
      ok,
      strict,
      at,
      service,
      lookback_hours: lookbackHours,
      thresholds,
      summary,
      checks: result.checks,
      failures: result.failures,
      warnings: result.warnings,
    };

    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else printHuman({ at, service, lookbackHours, summary, thresholds, result });

    if (strict && !ok) process.exit(1);
  } catch (error) {
    const message = String(error?.message || error);
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            strict,
            at,
            service,
            lookback_hours: lookbackHours,
            failures: [message],
          },
          null,
          2
        )
      );
    } else {
      console.error(`[chat-slo-24h][FAIL] ${message}`);
    }
    process.exit(1);
  }
};

main();
