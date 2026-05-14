import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import crypto from "crypto";
import multer from "multer";
import { uploadImageBufferToCloudflare } from "../../_utils/cloudflare_images";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";
import { applyCreateContentIdempotency } from "../../../libs/idempotency/content_create_idempotency";
import { isHashtagValidationError, sendHashtagError } from "../../../libs/hashtags";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const POST_MAX_FILES = 20;

const uploadPostImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: POST_MAX_FILES },
}).fields([{ name: "image_post", maxCount: POST_MAX_FILES }]);

const toArray = (value: any) => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
};

const toPlainForIdempotency = (value: any): any => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return value;
};

const sha256Buffer = (buffer: Buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const buildPostIdempotencyPayload = (params: {
  postText: string;
  hashtags: any;
  directMedia: any;
  uploadedFiles?: any[];
}) => {
  const uploadedFiles = Array.isArray(params.uploadedFiles) ? params.uploadedFiles : [];
  const uploadFingerprints = uploadedFiles.map((fileObj: any, index: number) => {
    const buffer: Buffer = fileObj?.buffer;
    const size = Number(fileObj?.size ?? (Buffer.isBuffer(buffer) ? buffer.length : 0)) || 0;
    return {
      index,
      name: String(fileObj?.originalname ?? "").trim(),
      mime: String(fileObj?.mimetype ?? "").trim(),
      size,
      sha256: Buffer.isBuffer(buffer) ? sha256Buffer(buffer) : "",
    };
  });

  return {
    post: String(params.postText ?? ""),
    hashtags: toPlainForIdempotency(params.hashtags),
    media: toPlainForIdempotency(params.directMedia),
    uploads: uploadFingerprints,
  };
};

const resolvePostResourceId = (responsePayload: any): string | number | null => {
  const id =
    Number(responsePayload?.body?.id ?? 0) ||
    Number(responsePayload?.body?.post?.id ?? 0);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const isLocalUploadPath = (value: string) => {
  const normalized = value.replace(/\\/g, "/");
  if (/^https?:\/\//i.test(normalized)) return false;
  return (
    normalized.startsWith("/uploads/") ||
    normalized.startsWith("uploads/") ||
    normalized.includes("/uploads/")
  );
};

const validateDirectMediaPayload = (value: any): string | null => {
  if (value === undefined || value === null) return null;

  let source: any = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
  }

  const items = Array.isArray(source) ? source : [source];
  for (const item of items) {
    if (typeof item === "string") {
      if (isLocalUploadPath(item.trim())) return item;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const url = String(item.url ?? item.media_url ?? "").trim();
    if (!url) continue;
    if (isLocalUploadPath(url)) return url;
  }

  return null;
};

const normalizeMediaPresenceItems = (value: any): any[] => {
  if (value === undefined || value === null) return [];

  let source: any = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
  }

  const items = Array.isArray(source) ? source : [source];
  return items.filter((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    if (!item || typeof item !== "object") return false;
    const url = String(item.url ?? item.media_url ?? "").trim();
    return url.length > 0;
  });
};

const createPost = async (req: Request, res: Response, mediaItems?: any) => {
  const rawPost = (req.body as any)?.post;
  const postText = rawPost === undefined || rawPost === null ? "" : String(rawPost);
  const hasText = postText.trim().length > 0;
  const hasMedia = normalizeMediaPresenceItems(mediaItems).length > 0;

  if (!hasText && !hasMedia) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "post text or media is required",
    });
  }

  req.body.userId = req.userId;
  req.body.created_date = new Date(new Date().toUTCString());
  req.body.post = hasText ? postText : "";

  if (mediaItems !== undefined) {
    req.body.media_items = mediaItems;
  }

  const post = await repository.add(req.body);
  await bumpHomeContentSectionVersion("posts");
  return formatResponse({ res, success: true, body: post });
};

export const add = async (req: Request, res: Response) => {
  const isMultipart = !!req.is("multipart/form-data");

  if (!isMultipart) {
    try {
      const rawPost = (req.body as any)?.post;
      const postText = rawPost === undefined || rawPost === null ? "" : String(rawPost);
      const directMedia =
        (req.body as any)?.media_items ??
        (req.body as any)?.media ??
        (req.body as any)?.media_url;
      const hashtags = (req.body as any)?.hashtags;

      const canProceed = await applyCreateContentIdempotency({
        req,
        res,
        endpoint: "/api/v1/post",
        payloadForHash: buildPostIdempotencyPayload({
          postText,
          hashtags,
          directMedia,
        }),
        resolveResourceId: resolvePostResourceId,
      });
      if (!canProceed) return;

      const localPath = validateDirectMediaPayload(directMedia);
      if (localPath) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "media_items cannot contain local /uploads paths",
        });
      }

      return await createPost(req, res, directMedia);
    } catch (error: any) {
      if (isHashtagValidationError(error)) {
        return sendHashtagError(
          res,
          error.status ?? 400,
          error.code,
          error.message
        );
      }
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? String(error),
      });
    }
  }

  uploadPostImages(req, res, async (err) => {
    const filesAny: any = (req as any).files || {};
    const uploadedFiles: any[] = filesAny.image_post ?? [];

    if (err) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: err?.message ?? "Error uploading files",
      });
    }

    try {
      const rawPost = (req.body as any)?.post;
      const postText = rawPost === undefined || rawPost === null ? "" : String(rawPost);
      const directMedia =
        (req.body as any)?.media_items ??
        (req.body as any)?.media ??
        (req.body as any)?.media_url;
      const hashtags = (req.body as any)?.hashtags;

      const canProceed = await applyCreateContentIdempotency({
        req,
        res,
        endpoint: "/api/v1/post",
        payloadForHash: buildPostIdempotencyPayload({
          postText,
          hashtags,
          directMedia,
          uploadedFiles,
        }),
        resolveResourceId: resolvePostResourceId,
      });
      if (!canProceed) return;

      const localPath = validateDirectMediaPayload(directMedia);
      if (localPath) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "media_items cannot contain local /uploads paths",
        });
      }

      const cloudMedia = await Promise.all(
        uploadedFiles.map(async (fileObj: any, index: number) => {
          const uploadedImage = await uploadImageBufferToCloudflare({
            buffer: fileObj.buffer,
            filename: fileObj.originalname,
            mimeType: fileObj.mimetype,
            metadata: {
              app: "minhoo",
              context: "post-image",
              userId: String(req.userId ?? ""),
              index,
            },
          });
          return { url: uploadedImage.url, is_img: true };
        })
      );

      const mergedMedia = [...toArray(directMedia), ...cloudMedia];
      const mediaPayload = mergedMedia.length ? mergedMedia : undefined;

      return await createPost(req, res, mediaPayload);
    } catch (error: any) {
      if (isHashtagValidationError(error)) {
        return sendHashtagError(
          res,
          error.status ?? 400,
          error.code,
          error.message
        );
      }
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? String(error),
      });
    }
  });
};
