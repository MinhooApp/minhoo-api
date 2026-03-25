import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  socket,
  sendNotification,
} from "../_module/module";
import multer from "multer";
import {
  normalizeRemoteHttpUrl,
  uploadImageBufferToCloudflare,
} from "../../_utils/cloudflare_images";
import { formatRelativeTime } from "../../../libs/localization/relative_time";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const uploadCommentMedia = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: IMAGE_MAX_BYTES },
}).fields([{ name: "media_url", maxCount: 1 }]);

const toIsoOrNull = (value: any): string | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const toPlainObject = (value: any): any => {
  if (!value) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") {
    return { ...value.dataValues };
  }
  return value;
};

const normalizePostCommentPayload = (raw: any) => {
  const source = toPlainObject(raw) ?? {};
  const commentator = toPlainObject(source.commentator ?? null);
  const createdAt = toIsoOrNull(source.createdAt ?? source.created_at ?? source.created_date);
  const updatedAt = toIsoOrNull(source.updatedAt ?? source.updated_at);
  const relativeTimeEn = formatRelativeTime(createdAt, "en");
  const relativeTimeEs = formatRelativeTime(createdAt, "es");

  return {
    ...source,
    postId: Number(source.postId ?? source.post_id ?? 0) || null,
    post_id: Number(source.post_id ?? source.postId ?? 0) || null,
    userId: Number(source.userId ?? source.user_id ?? 0) || null,
    user_id: Number(source.user_id ?? source.userId ?? 0) || null,
    commentator,
    createdAt,
    created_at: createdAt,
    created_date: createdAt,
    updatedAt,
    updated_at: updatedAt,
    relativeTime: relativeTimeEn,
    relative_time: relativeTimeEn,
    relativeTimeEn: relativeTimeEn,
    relative_time_en: relativeTimeEn,
    relativeTimeEs: relativeTimeEs,
    relative_time_es: relativeTimeEs,
  };
};

const createComment = async (req: Request, res: Response) => {
  req.body.created_date = new Date(new Date().toUTCString());
  req.body.userId = req.userId;

  const postId = Number(req.body.postId ?? 0);
  if (!Number.isFinite(postId) || postId <= 0) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "postId is required",
    });
  }

  req.body.postId = postId;

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

  const postPayload = toPlainObject(post) ?? {};
  const postComments = Array.isArray(postPayload.comments) ? postPayload.comments : [];
  const createdComment =
    postComments.find((item: any) => Number(item?.id) === Number(comment.id)) ??
    postComments[0] ??
    {
      ...toPlainObject(comment),
      postId,
      post_id: postId,
      userId: req.userId,
      user_id: req.userId,
      comment: req.body.comment ?? null,
      media_url: req.body.media_url ?? null,
      created_date: req.body.created_date,
    };

  socket.emit("post/commented", {
    action: "commented",
    postId: Number(post?.id ?? postId),
    post_id: Number(post?.id ?? postId),
    ownerId: Number(post?.userId ?? 0),
    owner_id: Number(post?.userId ?? 0),
    actorUserId: Number(req.userId ?? 0),
    actor_user_id: Number(req.userId ?? 0),
    commentsCount: Number(postPayload.comments_count ?? 0),
    comments_count: Number(postPayload.comments_count ?? 0),
    comment: normalizePostCommentPayload(createdComment),
    commentCreatedAt: toIsoOrNull(createdComment?.createdAt ?? createdComment?.created_at ?? createdComment?.created_date),
    comment_created_at: toIsoOrNull(createdComment?.createdAt ?? createdComment?.created_at ?? createdComment?.created_date),
  });
  const updatedAt = new Date().toISOString();
  socket.emit("post/updated", {
    action: "commented",
    postId: Number(post?.id ?? postId),
    post_id: Number(post?.id ?? postId),
    ownerId: Number(post?.userId ?? 0),
    owner_id: Number(post?.userId ?? 0),
    actorUserId: Number(req.userId ?? 0),
    actor_user_id: Number(req.userId ?? 0),
    commentsCount: Number(postPayload.comments_count ?? 0),
    comments_count: Number(postPayload.comments_count ?? 0),
    updatedAt,
    updated_at: updatedAt,
    post: postPayload,
    comment: normalizePostCommentPayload(createdComment),
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
