export type AppLocale = "en" | "es";

const toStringArray = (value: any): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
};

export const normalizeLocale = (raw: any): AppLocale | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return null;

  // Compatibilidad con IDs de catálogo de idioma usados por algunos clientes.
  // 1 = English, 4 = Spanish.
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (numeric === 4) return "es";
    if (numeric === 1) return "en";
  }

  if (
    normalized.startsWith("es") ||
    normalized.includes("spanish") ||
    normalized.includes("espanol") ||
    normalized.includes("español")
  ) {
    return "es";
  }

  if (
    normalized.startsWith("en") ||
    normalized.includes("english") ||
    normalized.includes("ingles") ||
    normalized.includes("inglés")
  ) {
    return "en";
  }

  return null;
};

const detectFirstLocale = (values: any[]): AppLocale | null => {
  for (const value of values) {
    const detected = normalizeLocale(value);
    if (detected) return detected;
  }
  return null;
};

const parseAcceptLanguage = (raw: any): string[] => {
  const value = String(raw ?? "").trim();
  if (!value) return [];

  return value
    .split(",")
    .map((entry) => entry.trim().split(";")[0].trim())
    .filter(Boolean);
};

export const resolveLocale = (params: {
  preferredLanguage?: any;
  storedLanguage?: any;
  storedLanguageCodes?: any;
  storedLanguageNames?: any;
  acceptLanguage?: any;
  fallback?: AppLocale;
}): AppLocale => {
  const fallback = params.fallback ?? "en";

  const fromPreferred = detectFirstLocale([params.preferredLanguage]);
  if (fromPreferred) return fromPreferred;

  const fromStored = detectFirstLocale([
    params.storedLanguage,
    ...toStringArray(params.storedLanguageCodes),
    ...toStringArray(params.storedLanguageNames),
  ]);
  if (fromStored) return fromStored;

  const fromAcceptLanguage = detectFirstLocale(parseAcceptLanguage(params.acceptLanguage));
  if (fromAcceptLanguage) return fromAcceptLanguage;

  return fallback;
};
