"use strict";

const fs = require("fs");
const path = require("path");

const PLACEHOLDER_RE = /^__USE_.*_FILE__$/;

const resolveContent = (filePathRaw, baseDir) => {
  const candidate = String(filePathRaw || "").trim();
  if (!candidate) return null;
  const absolutePath = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(baseDir || process.cwd(), candidate);
  if (!fs.existsSync(absolutePath)) return null;
  return String(fs.readFileSync(absolutePath, "utf8"))
    .replace(/\r/g, "")
    .trim();
};

const shouldOverride = (currentValue, forceOverride) => {
  if (forceOverride) return true;
  const current = String(currentValue || "").trim();
  return !current || PLACEHOLDER_RE.test(current);
};

const applyFileBackedSecrets = (targetEnv = process.env, options = {}) => {
  const forceOverride = options.forceOverride === true;
  const allowCreateMissingTargets = options.allowCreateMissingTargets === true;
  const baseDir = options.baseDir || process.cwd();
  const keys = Object.keys(targetEnv);

  for (const key of keys) {
    if (!key.endsWith("_FILE")) continue;
    const targetKey = key.slice(0, -5).trim();
    if (!targetKey) continue;
    const hasTargetKey = Object.prototype.hasOwnProperty.call(targetEnv, targetKey);
    if (!hasTargetKey && !allowCreateMissingTargets) continue;

    const content = resolveContent(targetEnv[key], baseDir);
    if (content === null) continue;
    if (!shouldOverride(targetEnv[targetKey], forceOverride)) continue;

    targetEnv[targetKey] = content;
  }

  return targetEnv;
};

module.exports = {
  applyFileBackedSecrets,
};
