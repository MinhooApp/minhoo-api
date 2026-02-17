import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import multer from "multer";
import { uploadImageBufferToCloudflare } from "../../_utils/cloudflare_images";

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

const createPost = async (req: Request, res: Response, mediaItems?: any) => {
  req.body.userId = req.userId;
  req.body.created_date = new Date(new Date().toUTCString());

  if (mediaItems !== undefined) {
    req.body.media_items = mediaItems;
  }

  const post = await repository.add(req.body);
  return formatResponse({ res, success: true, body: post });
};

export const add = async (req: Request, res: Response) => {
  const isMultipart = !!req.is("multipart/form-data");

  if (!isMultipart) {
    try {
      const directMedia =
        (req.body as any)?.media_items ??
        (req.body as any)?.media ??
        (req.body as any)?.media_url;

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

      const directMedia =
        (req.body as any)?.media_items ??
        (req.body as any)?.media ??
        (req.body as any)?.media_url;

      const localPath = validateDirectMediaPayload(directMedia);
      if (localPath) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "media_items cannot contain local /uploads paths",
        });
      }

      const mergedMedia = [...toArray(directMedia), ...cloudMedia];
      const mediaPayload = mergedMedia.length ? mergedMedia : undefined;

      return await createPost(req, res, mediaPayload);
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? String(error),
      });
    }
  });
};
