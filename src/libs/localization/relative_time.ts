import { AppLocale } from "./locale";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

const toDate = (value: any): Date | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const toJustNow = (locale: AppLocale) => (locale === "es" ? "justo ahora" : "just now");

const getRtf = (locale: AppLocale) => {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  } catch {
    return new Intl.RelativeTimeFormat("en", { numeric: "always" });
  }
};

export const formatRelativeTime = (
  value: any,
  locale: AppLocale = "en",
  nowRaw?: any
): string | null => {
  const date = toDate(value);
  if (!date) return null;

  const now = toDate(nowRaw) ?? new Date();
  const diffMs = date.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 45 * SECOND_MS) return toJustNow(locale);

  const rtf = getRtf(locale);

  if (absMs < 45 * MINUTE_MS) {
    return rtf.format(Math.round(diffMs / MINUTE_MS), "minute");
  }
  if (absMs < 22 * HOUR_MS) {
    return rtf.format(Math.round(diffMs / HOUR_MS), "hour");
  }
  if (absMs < 6 * DAY_MS) {
    return rtf.format(Math.round(diffMs / DAY_MS), "day");
  }
  if (absMs < 4 * WEEK_MS) {
    return rtf.format(Math.round(diffMs / WEEK_MS), "week");
  }
  if (absMs < YEAR_MS) {
    return rtf.format(Math.round(diffMs / MONTH_MS), "month");
  }

  return rtf.format(Math.round(diffMs / YEAR_MS), "year");
};
