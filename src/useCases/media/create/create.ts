import {
  Request,
  Response,
  formatResponse,
  axios,
} from "../_module/module";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_RESOLUTION = 2048;
const IMAGE_FEED_WIDTH = 1080;
const IMAGE_OUTPUT_FORMAT = "webp";
const IMAGE_OUTPUT_QUALITY = 80;

const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_MAX_DURATION_SECONDS = 60;
const VIDEO_OUTPUT_RESOLUTION = "720p";
const VIDEO_OUTPUT_CODEC = "H.264 MP4";
const VIDEO_STREAMING = "HLS";

const parsePositiveInt = (value: any): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
};

const parseCsv = (value: any): string[] => {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

const getMediaToken = () =>
  String(
    process.env.CLOUDFLARE_MEDIA_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();

const getImageVariant = () =>
  String(process.env.CLOUDFLARE_IMAGES_VARIANT ?? "public").trim() || "public";

const cloudflareHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const extractCloudflareError = (error: any) => {
  const errors = error?.response?.data?.errors;
  if (Array.isArray(errors) && errors.length) {
    const messages = errors
      .map((entry: any) => String(entry?.message ?? "").trim())
      .filter(Boolean);
    if (messages.length) return messages.join(" | ");
  }

  const message =
    error?.response?.data?.message ??
    error?.response?.statusText ??
    error?.message ??
    "cloudflare request failed";

  return String(message);
};

const ensureCloudflareConfig = (kind: "images" | "media") => {
  const accountId = getCloudflareAccountId();
  const token = kind === "images" ? getImagesToken() : getMediaToken();

  if (!accountId) {
    return {
      ok: false,
      message: "CLOUDFLARE_ACCOUNT_ID is not configured",
      accountId: "",
      token: "",
    };
  }
  if (!token) {
    const key =
      kind === "images"
        ? "CLOUDFLARE_IMAGES_API_TOKEN"
        : "CLOUDFLARE_MEDIA_API_TOKEN";
    return {
      ok: false,
      message: `${key} is not configured`,
      accountId,
      token: "",
    };
  }
  return { ok: true, message: "", accountId, token };
};

const mediaRules = {
  image: {
    max_size_bytes: IMAGE_MAX_BYTES,
    max_resolution_px: IMAGE_MAX_RESOLUTION,
    feed_width_px: IMAGE_FEED_WIDTH,
    output_format: IMAGE_OUTPUT_FORMAT,
    output_quality_percent: IMAGE_OUTPUT_QUALITY,
  },
  video: {
    max_size_bytes: VIDEO_MAX_BYTES,
    max_duration_seconds: VIDEO_MAX_DURATION_SECONDS,
    output_resolution: VIDEO_OUTPUT_RESOLUTION,
    output_codec: VIDEO_OUTPUT_CODEC,
    streaming: VIDEO_STREAMING,
  },
};

export const media_rules = async (_req: Request, res: Response) => {
  return formatResponse({
    res,
    success: true,
    body: { rules: mediaRules },
  });
};

export const create_image_direct_upload = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > IMAGE_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `image exceeds ${IMAGE_MAX_BYTES} bytes`,
    });
  }

  const contentType = String((req.body as any)?.content_type ?? "").trim();
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "content_type must be an image/* mime type",
    });
  }

  try {
    const formData = new FormData();
    formData.append("requireSignedURLs", "false");
    formData.append(
      "metadata",
      JSON.stringify({
        userId: String(req.userId ?? ""),
        app: "minhoo",
        context: String((req.body as any)?.context ?? "feed"),
      })
    );

    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v2/direct_upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
        body: formData,
      }
    );

    const payload: any = await response.json();
    if (!payload?.success) {
      const firstError =
        payload?.errors?.[0]?.message ?? "cloudflare images upload failed";
      throw new Error(firstError);
    }

    const result = payload?.result ?? {};
    return formatResponse({
      res,
      success: true,
      body: {
        image_id: result.id ?? null,
        upload_url: result.uploadURL ?? null,
        rules: mediaRules.image,
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const confirm_image_upload = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const imageId = String((req.body as any)?.image_id ?? "").trim();
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "image_id is required",
    });
  }

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v1/${imageId}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare image lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const variants = Array.isArray(result.variants) ? result.variants : [];
    const preferredVariant = variants.find((url: string) =>
      url.endsWith(`/${getImageVariant()}`)
    );

    return formatResponse({
      res,
      success: true,
      body: {
        image: {
          id: result.id ?? imageId,
          ready: !result.draft,
          uploaded: result.uploaded ?? null,
          variant: getImageVariant(),
          url: preferredVariant ?? variants[0] ?? null,
          variants,
        },
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const delete_image_asset = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const imageId = String((req.params as any)?.id ?? "").trim();
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id is required",
    });
  }

  try {
    const response = await axios.delete(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v1/${imageId}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare image delete failed";
      throw new Error(firstError);
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, image_id: imageId },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const create_video_direct_upload = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > VIDEO_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `video exceeds ${VIDEO_MAX_BYTES} bytes`,
    });
  }

  try {
    const allowedOrigins = parseCsv(process.env.CLOUDFLARE_STREAM_ALLOWED_ORIGINS);
    const payload: any = {
      maxDurationSeconds: VIDEO_MAX_DURATION_SECONDS,
      creator: String(req.userId ?? ""),
      meta: {
        userId: String(req.userId ?? ""),
        app: "minhoo",
        context: String((req.body as any)?.context ?? "feed"),
      },
    };

    if (allowedOrigins.length) payload.allowedOrigins = allowedOrigins;

    const response = await axios.post(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/direct_upload`,
      payload,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream upload failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    return formatResponse({
      res,
      success: true,
      body: {
        uid: result.uid ?? null,
        upload_url: result.uploadURL ?? null,
        rules: mediaRules.video,
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const confirm_video_upload = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const uid = String((req.body as any)?.uid ?? "").trim();
  if (!uid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/${uid}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const duration = Number(result.duration ?? 0);
    if (Number.isFinite(duration) && duration > VIDEO_MAX_DURATION_SECONDS) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `video duration exceeds ${VIDEO_MAX_DURATION_SECONDS}s`,
      });
    }

    const hls =
      result?.playback?.hls ??
      (uid ? `https://videodelivery.net/${uid}/manifest/video.m3u8` : null);
    const thumbnail =
      result?.thumbnail ??
      (uid ? `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=1s` : null);

    return formatResponse({
      res,
      success: true,
      body: {
        video: {
          uid,
          ready: !!result.readyToStream,
          duration_seconds: Number.isFinite(duration) ? duration : null,
          hls,
          thumbnail,
          status: result.status ?? null,
        },
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const delete_video_asset = async (req: Request, res: Response) => {
  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const uid = String((req.params as any)?.uid ?? "").trim();
  if (!uid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }

  try {
    const response = await axios.delete(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/${uid}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream delete failed";
      throw new Error(firstError);
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, uid },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};
