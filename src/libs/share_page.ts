import fs from "fs/promises";
import path from "path";
import type { Request } from "express";

const TEMPLATE_PATH = path.resolve(process.cwd(), "src/public/html/share/share.html");
const DEFAULT_ANDROID_FALLBACK =
  "https://play.google.com/store/apps/details?id=aud.minhoo.io";
const DEFAULT_IOS_FALLBACK = "https://apps.apple.com/app/6748967902";
const DEFAULT_OG_IMAGE =
  "https://imagedelivery.net/byMb3jxLYxr0Esz1Tf7NcQ/ff67a5c9-2984-45be-9502-925d46939100/public";

let templatePromise: Promise<string> | null = null;

type ShareLandingPageData = {
  pageTitle: string;
  metaDescription: string;
  metaImageUrl?: string | null;
  canonicalUrl: string;
  deepLink: string;
  fallbackUrl: string;
  ogType?: string;
  headline?: string;
  bodyText?: string;
  subText?: string;
  openAppLabel?: string;
  downloadAppLabel?: string;
};

const getTemplate = async () => {
  if (!templatePromise) {
    templatePromise = fs.readFile(TEMPLATE_PATH, "utf8");
  }
  return templatePromise;
};

const normalizeWhitespace = (value: any) => String(value ?? "").replace(/\s+/g, " ").trim();

const truncateText = (value: string, max: number) => {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const replaceAllTokens = (template: string, replacements: Record<string, string>) => {
  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  return html;
};

const forwardedHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "")
    .split(",")[0]
    .trim();
};

export const getShareOrigin = (req: Request) => {
  const explicitBase = normalizeWhitespace(
    process.env.SHARE_PUBLIC_BASE_URL ??
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_SHARE_BASE_URL ??
      ""
  );
  if (explicitBase) return explicitBase.replace(/\/+$/, "");

  const protocol =
    forwardedHeaderValue(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host =
    forwardedHeaderValue(req.headers["x-forwarded-host"]) ||
    normalizeWhitespace(req.get("host")) ||
    "api.minhoo.xyz";

  return `${protocol}://${host}`;
};

export const buildCanonicalShareUrl = (req: Request) =>
  `${getShareOrigin(req)}${req.originalUrl}`;

export const resolveShareAssetUrl = (req: Request, rawValue: any): string | null => {
  const value = normalizeWhitespace(rawValue);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;

  const origin = getShareOrigin(req);
  if (value.startsWith("/")) return `${origin}${value}`;
  return `${origin}/${value.replace(/^\/+/, "")}`;
};

export const resolveStoreFallback = (req: Request) => {
  const userAgent = normalizeWhitespace(req.headers["user-agent"]);
  return /android/i.test(userAgent) ? DEFAULT_ANDROID_FALLBACK : DEFAULT_IOS_FALLBACK;
};

export const buildDisplayName = (source: any) => {
  const firstName = normalizeWhitespace(source?.name);
  const lastName = normalizeWhitespace(source?.last_name);
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;

  const username = normalizeWhitespace(source?.username);
  if (username) return username.startsWith("@") ? username : `@${username}`;

  return "Someone";
};

export const buildShortText = (rawValue: any, fallback: string, max = 160) => {
  const normalized = normalizeWhitespace(rawValue);
  return truncateText(normalized || fallback, max);
};

export const renderShareLandingPage = async (data: ShareLandingPageData) => {
  const template = await getTemplate();
  const pageTitle = buildShortText(data.pageTitle, "Open in Minhoo", 90);
  const metaDescription = buildShortText(
    data.metaDescription,
    "Open this content in Minhoo.",
    180
  );
  const metaImageUrl = normalizeWhitespace(data.metaImageUrl) || DEFAULT_OG_IMAGE;
  const canonicalUrl = normalizeWhitespace(data.canonicalUrl);
  const headline = buildShortText(
    data.headline,
    "Check out what was shared with you!",
    90
  );
  const bodyText = buildShortText(
    data.bodyText,
    "To view this content, you'll need the Minhoo app.",
    180
  );
  const subText = buildShortText(
    data.subText,
    "Open the app if you already have it, or install it to continue.",
    220
  );
  const ogType = normalizeWhitespace(data.ogType) || "website";
  const openAppLabel = normalizeWhitespace(data.openAppLabel) || "Open the app";
  const downloadAppLabel =
    normalizeWhitespace(data.downloadAppLabel) || "Download the app";

  return replaceAllTokens(template, {
    "{{pageTitle}}": escapeHtml(pageTitle),
    "{{metaDescription}}": escapeHtml(metaDescription),
    "{{canonicalUrl}}": escapeHtml(canonicalUrl),
    "{{ogType}}": escapeHtml(ogType),
    "{{ogTitle}}": escapeHtml(pageTitle),
    "{{ogDescription}}": escapeHtml(metaDescription),
    "{{ogImage}}": escapeHtml(metaImageUrl),
    "{{ogImageAlt}}": escapeHtml(pageTitle),
    "{{headline}}": escapeHtml(headline),
    "{{bodyText}}": escapeHtml(bodyText),
    "{{subText}}": escapeHtml(subText),
    "{{openAppLabel}}": escapeHtml(openAppLabel),
    "{{downloadAppLabel}}": escapeHtml(downloadAppLabel),
    "{{deepLinkJson}}": JSON.stringify(String(data.deepLink ?? "")),
    "{{fallbackJson}}": JSON.stringify(String(data.fallbackUrl ?? "")),
  });
};
