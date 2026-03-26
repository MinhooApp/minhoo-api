import fs from "fs";
import path from "path";
import dotenv from "dotenv";

let didBootstrapEnv = false;

const toBool = (value: any, fallback = false): boolean => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const normalizeSecretValue = (value: string): string => {
  return value.replace(/\r/g, "").trim();
};

const assignSecret = (key: string, value: string, override: boolean) => {
  const current = String(process.env[key] ?? "").trim();
  if (!override && current) return;
  process.env[key] = normalizeSecretValue(value);
};

const loadDotenvFile = (filePathRaw: string, override: boolean) => {
  const filePath = path.resolve(filePathRaw);
  if (!fs.existsSync(filePath)) return;
  dotenv.config({ path: filePath, override });
};

const loadEnvFiles = () => {
  dotenv.config();

  const extraFiles = [
    process.env.ENV_FILE,
    process.env.SECRETS_ENV_FILE,
    process.env.MINHOO_SECRETS_FILE,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const override = toBool(process.env.SECRETS_ENV_OVERRIDE, true);
  extraFiles.forEach((filePath) => loadDotenvFile(filePath, override));
};

const loadJsonSecretsFile = () => {
  const filePathRaw = String(
    process.env.SECRETS_JSON_FILE ??
    process.env.SECRET_MANAGER_JSON_FILE ??
    ""
  ).trim();
  if (!filePathRaw) return;

  const filePath = path.resolve(filePathRaw);
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return;

    const override = toBool(process.env.SECRETS_JSON_OVERRIDE, true);
    for (const [key, value] of Object.entries(parsed)) {
      if (!key) continue;
      if (value === null || value === undefined) continue;
      assignSecret(key, String(value), override);
    }
  } catch (error) {
    console.warn("[env] failed to load SECRETS_JSON_FILE", error);
  }
};

const loadFileBackedSecrets = () => {
  const suffix = "_FILE";
  const override = toBool(process.env.SECRETS_FILE_OVERRIDE, true);
  const allowCreateMissingTargets = toBool(
    process.env.SECRETS_FILE_CREATE_MISSING_TARGETS,
    false
  );

  const keys = Object.keys(process.env);
  keys.forEach((envKey) => {
    if (!envKey.endsWith(suffix)) return;
    const targetKey = envKey.slice(0, -suffix.length).trim();
    const filePathRaw = String(process.env[envKey] ?? "").trim();
    if (!targetKey || !filePathRaw) return;
    const hasTargetKey = Object.prototype.hasOwnProperty.call(process.env, targetKey);
    if (!hasTargetKey && !allowCreateMissingTargets) return;

    const filePath = path.resolve(filePathRaw);
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, "utf8");
      assignSecret(targetKey, content, override);
    } catch (error) {
      console.warn(`[env] failed to read ${envKey} from file`, error);
    }
  });
};

export const bootstrapEnv = () => {
  if (didBootstrapEnv) return;
  didBootstrapEnv = true;

  loadEnvFiles();
  loadJsonSecretsFile();
  loadFileBackedSecrets();
};

bootstrapEnv();

export default bootstrapEnv;
