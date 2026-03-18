import { readFileSync } from "fs";

type FirebaseServiceAccount = {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
};

const parseJsonObject = (raw: string): FirebaseServiceAccount | null => {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FirebaseServiceAccount;
  } catch {
    return null;
  }
};

const normalizePrivateKey = (value: any): string => {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .trim();
};

const sanitizeAccount = (account: FirebaseServiceAccount): FirebaseServiceAccount => ({
  type: String(account.type ?? "service_account").trim() || "service_account",
  project_id: String(account.project_id ?? "").trim(),
  private_key_id: String(account.private_key_id ?? "").trim(),
  private_key: normalizePrivateKey(account.private_key),
  client_email: String(account.client_email ?? "").trim(),
  client_id: String(account.client_id ?? "").trim(),
  auth_uri:
    String(account.auth_uri ?? "").trim() || "https://accounts.google.com/o/oauth2/auth",
  token_uri:
    String(account.token_uri ?? "").trim() || "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url:
    String(account.auth_provider_x509_cert_url ?? "").trim() ||
    "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: String(account.client_x509_cert_url ?? "").trim(),
  universe_domain: String(account.universe_domain ?? "").trim() || "googleapis.com",
});

const isCompleteAccount = (account: FirebaseServiceAccount | null): boolean => {
  if (!account) return false;
  const normalized = sanitizeAccount(account);
  return Boolean(
    normalized.project_id && normalized.client_email && normalized.private_key
  );
};

const loadFromJsonEnv = (): FirebaseServiceAccount | null => {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (!raw) return null;
  return parseJsonObject(raw);
};

const loadFromBase64Env = (): FirebaseServiceAccount | null => {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "").trim();
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return parseJsonObject(decoded);
  } catch {
    return null;
  }
};

const loadFromFileEnv = (): FirebaseServiceAccount | null => {
  const filePath = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ??
      process.env.GOOGLE_APPLICATION_CREDENTIALS ??
      ""
  ).trim();
  if (!filePath) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseJsonObject(raw);
  } catch {
    return null;
  }
};

const loadFromDiscreteEnv = (): FirebaseServiceAccount | null => {
  const projectId = String(process.env.FIREBASE_PROJECT_ID ?? "").trim();
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL ?? "").trim();
  const privateKeyId = String(process.env.FIREBASE_PRIVATE_KEY_ID ?? "").trim();
  const clientId = String(process.env.FIREBASE_CLIENT_ID ?? "").trim();
  const clientX509 = String(process.env.FIREBASE_CLIENT_X509_CERT_URL ?? "").trim();
  if (!projectId || !privateKey || !clientEmail) return null;

  return {
    type: "service_account",
    project_id: projectId,
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: clientId,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: clientX509,
    universe_domain: "googleapis.com",
  };
};

const providers: Array<{ source: string; value: FirebaseServiceAccount | null }> = [
  { source: "FIREBASE_SERVICE_ACCOUNT_JSON", value: loadFromJsonEnv() },
  { source: "FIREBASE_SERVICE_ACCOUNT_BASE64", value: loadFromBase64Env() },
  { source: "FIREBASE_SERVICE_ACCOUNT_FILE", value: loadFromFileEnv() },
  { source: "FIREBASE_* variables", value: loadFromDiscreteEnv() },
];

const resolvedProvider = providers.find((entry) => isCompleteAccount(entry.value)) ?? null;

export const firebase_key = resolvedProvider
  ? sanitizeAccount(resolvedProvider.value as FirebaseServiceAccount)
  : null;

export const hasFirebaseCredentials = Boolean(firebase_key);
export const firebaseCredentialsSource = resolvedProvider?.source ?? null;
