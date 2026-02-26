import path from "path";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_VARIANT = "public";
const IMAGE_ID_REGEX = /^[a-zA-Z0-9._-]{6,255}$/;
const IMAGE_URL_CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.CLOUDFLARE_IMAGE_URL_CACHE_TTL_MS ?? 5 * 60 * 1000) ||
    5 * 60 * 1000
);
const IMAGE_URL_CACHE_MAX_ITEMS = Math.max(
  100,
  Number(process.env.CLOUDFLARE_IMAGE_URL_CACHE_MAX_ITEMS ?? 5000) || 5000
);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const getCloudflareAccountId = () =>
  String(process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();

const getImagesToken = () =>
  String(
    process.env.CLOUDFLARE_IMAGES_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();

const getVariant = () =>
  String(process.env.CLOUDFLARE_IMAGES_VARIANT ?? DEFAULT_VARIANT).trim() ||
  DEFAULT_VARIANT;

const resolveMimeType = (mimeType?: string, filename?: string) => {
  const normalizedMime = String(mimeType ?? "").trim().toLowerCase();
  if (normalizedMime.startsWith("image/")) return normalizedMime;

  const ext = path.extname(String(filename ?? "")).toLowerCase();
  const byExt = MIME_BY_EXT[ext];
  if (byExt) return byExt;

  return "application/octet-stream";
};

const extractErrorMessage = (payload: any, fallback: string) => {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors
        .map((entry: any) => String(entry?.message ?? "").trim())
        .filter(Boolean)
    : [];
  if (messages.length) return messages.join(" | ");

  const apiMessage = String(payload?.message ?? "").trim();
  if (apiMessage) return apiMessage;

  return fallback;
};

const pickVariantUrl = (variants: string[], variant: string) => {
  const preferred = variants.find((url) => url.endsWith(`/${variant}`));
  return preferred ?? variants[0] ?? null;
};

type ImageUrlCacheEntry = {
  url: string;
  expiresAt: number;
};

const imageUrlByIdCache = new Map<string, ImageUrlCacheEntry>();

const normalizeImageId = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (!IMAGE_ID_REGEX.test(normalized)) return null;
  return normalized;
};

const getCachedImageUrlById = (imageId: string): string | null => {
  const cached = imageUrlByIdCache.get(imageId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    imageUrlByIdCache.delete(imageId);
    return null;
  }
  return cached.url;
};

const setCachedImageUrlById = (imageId: string, url: string) => {
  const now = Date.now();

  if (imageUrlByIdCache.size >= IMAGE_URL_CACHE_MAX_ITEMS) {
    for (const [key, value] of imageUrlByIdCache.entries()) {
      if (value.expiresAt <= now) {
        imageUrlByIdCache.delete(key);
      }
    }
  }

  while (imageUrlByIdCache.size >= IMAGE_URL_CACHE_MAX_ITEMS) {
    const oldestKey = imageUrlByIdCache.keys().next().value;
    if (!oldestKey) break;
    imageUrlByIdCache.delete(oldestKey);
  }

  imageUrlByIdCache.set(imageId, {
    url,
    expiresAt: now + IMAGE_URL_CACHE_TTL_MS,
  });
};

export const normalizeRemoteHttpUrl = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (!/^https?:\/\//i.test(normalized)) return null;
  return normalized;
};

export const resolveCloudflareImageUrlById = async (
  imageIdRaw: any
): Promise<string | null> => {
  const imageId = normalizeImageId(imageIdRaw);
  if (!imageId) return null;

  const cached = getCachedImageUrlById(imageId);
  if (cached) return cached;

  const accountId = getCloudflareAccountId();
  const token = getImagesToken();
  if (!accountId || !token) return null;

  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/images/v1/${encodeURIComponent(
        imageId
      )}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const payload: any = await response.json();
    if (!response.ok || !payload?.success) return null;

    const result = payload?.result ?? {};
    const variants = Array.isArray(result?.variants) ? result.variants : [];
    const resolved = pickVariantUrl(variants, getVariant());
    if (!resolved) return null;

    const resolvedUrl = String(resolved).trim();
    if (!resolvedUrl) return null;

    setCachedImageUrlById(imageId, resolvedUrl);
    return resolvedUrl;
  } catch {
    return null;
  }
};

export const uploadImageBufferToCloudflare = async ({
  buffer,
  filename,
  mimeType,
  metadata,
}: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  metadata?: Record<string, any>;
}) => {
  const accountId = getCloudflareAccountId();
  const token = getImagesToken();
  const variant = getVariant();

  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured");
  if (!token) throw new Error("CLOUDFLARE_IMAGES_API_TOKEN is not configured");
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("image buffer is empty");
  }

  const safeMime = resolveMimeType(mimeType, filename);
  const safeFilename = String(filename ?? "upload-image");
  const formData = new FormData();
  formData.append("requireSignedURLs", "false");

  if (metadata && Object.keys(metadata).length) {
    formData.append("metadata", JSON.stringify(metadata));
  }

  formData.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: safeMime }),
    safeFilename
  );

  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${accountId}/images/v1`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    }
  );

  const payload: any = await response.json();
  if (!response.ok || !payload?.success) {
    throw new Error(
      extractErrorMessage(payload, `cloudflare upload failed (${response.status})`)
    );
  }

  const result = payload?.result ?? {};
  const variants = Array.isArray(result?.variants) ? result.variants : [];
  const url = pickVariantUrl(variants, variant);
  if (!url) throw new Error("cloudflare response has no variants");

  return {
    imageId: result?.id ? String(result.id) : null,
    url: String(url),
    variants,
    variant,
  };
};
