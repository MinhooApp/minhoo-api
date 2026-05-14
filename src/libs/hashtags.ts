import { Response } from "express";

export type HashtagErrorCode =
  | "HASHTAG_INVALID"
  | "HASHTAG_LIMIT_EXCEEDED"
  | "HASHTAG_NOT_FOUND";

export type HashtagEntry = {
  tag: string;
  display: string;
};

export const HASHTAG_MIN_LENGTH = 2;
export const HASHTAG_MAX_LENGTH = 50;
export const HASHTAG_MAX_PER_CONTENT = 20;
const HASHTAG_TOKEN_REGEX = new RegExp(
  `^[A-Za-z0-9_]{${HASHTAG_MIN_LENGTH},${HASHTAG_MAX_LENGTH}}$`
);
const HASHTAG_EXTRACT_REGEX = /(^|[^A-Za-z0-9_])#([A-Za-z0-9_]{2,50})/g;

export class HashtagValidationError extends Error {
  code: HashtagErrorCode;
  status: number;

  constructor(code: HashtagErrorCode, message: string, status = 400) {
    super(message);
    this.name = "HashtagValidationError";
    this.code = code;
    this.status = status;
  }
}

const parseArrayLikeInput = (value: any): any[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      } catch {
        // Fall back to tokenized string path.
      }
    }
    return trimmed
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  if (typeof value === "object") return [value];
  return [value];
};

const normalizeHashtagToken = (value: any): string | null => {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
  return normalized || null;
};

const validateTagTokenOrThrow = (tag: string) => {
  if (!HASHTAG_TOKEN_REGEX.test(tag)) {
    throw new HashtagValidationError(
      "HASHTAG_INVALID",
      `invalid hashtag: ${tag}`
    );
  }
};

const appendUniqueTag = (buffer: string[], seen: Set<string>, tag: string) => {
  if (seen.has(tag)) return;
  seen.add(tag);
  buffer.push(tag);
};

export const normalizeHashtagInputOrThrow = (value: any): string[] => {
  const entries = parseArrayLikeInput(value);
  const normalized: string[] = [];
  const seen = new Set<string>();

  entries.forEach((entry) => {
    const candidate =
      typeof entry === "object" && entry !== null
        ? entry.tag ?? entry.hashtag ?? entry.display
        : entry;
    const tag = normalizeHashtagToken(candidate);
    if (!tag) return;
    validateTagTokenOrThrow(tag);
    appendUniqueTag(normalized, seen, tag);
  });

  return normalized;
};

export const extractHashtagsFromText = (value: any): string[] => {
  const text = String(value ?? "");
  if (!text) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HASHTAG_EXTRACT_REGEX)) {
    const rawTag = normalizeHashtagToken(match?.[2]);
    if (!rawTag) continue;
    validateTagTokenOrThrow(rawTag);
    appendUniqueTag(normalized, seen, rawTag);
  }
  return normalized;
};

export const collectContentHashtagsOrThrow = (params: {
  text?: any;
  hashtagsRaw?: any;
  maxPerContent?: number;
}) => {
  const maxPerContent = Number(params.maxPerContent ?? HASHTAG_MAX_PER_CONTENT);
  const fromText = extractHashtagsFromText(params.text);
  const fromPayload = normalizeHashtagInputOrThrow(params.hashtagsRaw);

  const merged: string[] = [];
  const seen = new Set<string>();
  [...fromText, ...fromPayload].forEach((tag) => appendUniqueTag(merged, seen, tag));

  if (merged.length > maxPerContent) {
    throw new HashtagValidationError(
      "HASHTAG_LIMIT_EXCEEDED",
      `too many hashtags: max ${maxPerContent}`,
      400
    );
  }

  return merged;
};

export const normalizePathTagOrThrow = (value: any): string => {
  const normalized = normalizeHashtagToken(value);
  if (!normalized) {
    throw new HashtagValidationError("HASHTAG_INVALID", "hashtag tag is required");
  }
  validateTagTokenOrThrow(normalized);
  return normalized;
};

export const toHashtagEntries = (tags: string[]): HashtagEntry[] =>
  (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => ({ tag, display: `#${tag}` }));

export const parseHashtagEntries = (value: any): HashtagEntry[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: HashtagEntry[] = [];
  value.forEach((entry: any) => {
    const tag = normalizeHashtagToken(entry?.tag ?? entry?.display ?? entry);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    out.push({ tag, display: `#${tag}` });
  });
  return out;
};

const requestIsAuthenticated = (res: Response): boolean => {
  const reqAny: any = (res as any)?.req ?? {};
  const userId = Number(reqAny?.userId ?? 0);
  return Boolean(reqAny?.authenticated) || (Number.isFinite(userId) && userId > 0);
};

export const sendHashtagError = (
  res: Response,
  status: number,
  code: HashtagErrorCode,
  message: string
) => {
  return res.status(status).json({
    success: false,
    code,
    message,
    header: {
      success: false,
      authenticated: requestIsAuthenticated(res),
      messages: [code, message],
    },
    messages: [code, message],
    error: {
      code,
      message,
    },
  });
};

export const isHashtagValidationError = (
  error: any
): error is HashtagValidationError => error instanceof HashtagValidationError;
