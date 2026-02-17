import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  sendNotification,
} from "../_module/module";
import multer from "multer";
import {
  normalizeRemoteHttpUrl,
  uploadImageBufferToCloudflare,
} from "../../_utils/cloudflare_images";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const uploadCommentMedia = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: IMAGE_MAX_BYTES },
}).fields([{ name: "media_url", maxCount: 1 }]);

const createComment = async (req: Request, res: Response) => {
  req.body.created_date = new Date(new Date().toUTCString());
  req.body.userId = req.userId;

  const comment = await repository.add(req.body, req.userId);
  const post = await postRepository.get(req.body.postId, req.userId);
  if (!comment) {
    return formatResponse({
      res,
      success: false,
      message: "Comment not created",
    });
  }

  const rawPreview = (req.body.comment ?? "").toString().trim();
  const snippet =
    rawPreview.length > 60 ? `${rawPreview.slice(0, 60)}...` : rawPreview;
  const notificationBody = snippet || "You have a new comment";

  await sendNotification({
    userId: post?.userId,
    interactorId: req.userId,
    postId: post?.id,
    commentId: comment.id,
    type: "comment",
    message: notificationBody,
  });

  return formatResponse({ res, success: true, body: { post } });
};

export const add = async (req: Request, res: Response) => {
  try {
    const isMultipart = !!req.is("multipart/form-data");
    if (!isMultipart) {
      const mediaUrlRaw = (req.body as any)?.media_url;
      const normalizedMediaUrl = normalizeRemoteHttpUrl(mediaUrlRaw);
      const hasMediaUrl =
        mediaUrlRaw !== undefined && String(mediaUrlRaw ?? "").trim() !== "";
      if (hasMediaUrl && !normalizedMediaUrl) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "media_url must be a valid http(s) URL",
        });
      }
      if (normalizedMediaUrl) req.body.media_url = normalizedMediaUrl;
      return await createComment(req, res);
    }

    uploadCommentMedia(req, res, async (err: any) => {
      if (err) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: err?.message ?? "Error uploading media",
        });
      }

      try {
        const filesAny: any = (req as any).files || {};
        const fileObj = (filesAny?.media_url ?? [])[0];

        if (fileObj?.buffer) {
          const uploadedImage = await uploadImageBufferToCloudflare({
            buffer: fileObj.buffer,
            filename: fileObj.originalname,
            mimeType: fileObj.mimetype,
            metadata: {
              app: "minhoo",
              context: "comment-media",
              userId: String(req.userId ?? ""),
            },
          });
          req.body.media_url = uploadedImage.url;
        } else {
          const mediaUrlRaw = (req.body as any)?.media_url;
          const normalizedMediaUrl = normalizeRemoteHttpUrl(mediaUrlRaw);
          const hasMediaUrl =
            mediaUrlRaw !== undefined && String(mediaUrlRaw ?? "").trim() !== "";
          if (hasMediaUrl && !normalizedMediaUrl) {
            return formatResponse({
              res,
              success: false,
              code: 400,
              message: "media_url must be a valid http(s) URL",
            });
          }
          if (normalizedMediaUrl) req.body.media_url = normalizedMediaUrl;
        }

        return await createComment(req, res);
      } catch (error: any) {
        return formatResponse({
          res,
          success: false,
          message: error?.message ?? "comment create failed",
        });
      }
    });
  } catch (e) {
    return formatResponse({ res, success: false, message: e });
  }
};
