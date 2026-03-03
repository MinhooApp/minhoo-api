import { Request, Response, formatResponse, repository } from "../_module/module";

const parseBool = (value: any, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return fallback;
};

const parseVisibility = (value: any) => {
  const v = String(value ?? "public").trim().toLowerCase();
  if (["public", "followers", "private"].includes(v)) return v;
  return "public";
};

const parseJSON = (value: any) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

export const create_reel = async (req: Request, res: Response) => {
  try {
    const video_uid = String(
      (req.body as any)?.video_uid ??
        (req.body as any)?.videoUid ??
        (req.body as any)?.uid ??
        ""
    ).trim();

    const streamFromBody = String(
      (req.body as any)?.stream_url ?? (req.body as any)?.streamUrl ?? ""
    ).trim();

    const stream_url =
      streamFromBody ||
      (video_uid ? `https://videodelivery.net/${video_uid}/manifest/video.m3u8` : "");

    if (!stream_url) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "stream_url or video_uid is required",
      });
    }

    const thumbnail_url = String(
      (req.body as any)?.thumbnail_url ??
        (req.body as any)?.thumbnailUrl ??
        (video_uid
          ? `https://videodelivery.net/${video_uid}/thumbnails/thumbnail.jpg?time=1s`
          : "")
    ).trim();

    const download_url = String(
      (req.body as any)?.download_url ??
        (req.body as any)?.downloadUrl ??
        (video_uid
          ? `/api/v1/media/video/download?uid=${encodeURIComponent(video_uid)}`
          : "")
    ).trim();

    const duration_seconds = Math.max(
      0,
      Number((req.body as any)?.duration_seconds ?? (req.body as any)?.durationSeconds ?? 0) || 0
    );

    const payload = {
      userId: req.userId,
      description: String((req.body as any)?.description ?? "").trim() || null,
      video_uid: video_uid || null,
      stream_url,
      download_url: download_url || null,
      thumbnail_url: thumbnail_url || null,
      duration_seconds,
      visibility: parseVisibility((req.body as any)?.visibility),
      status: String((req.body as any)?.status ?? "ready").toLowerCase() === "processing"
        ? "processing"
        : String((req.body as any)?.status ?? "ready").toLowerCase() === "failed"
        ? "failed"
        : "ready",
      allow_download: parseBool((req.body as any)?.allow_download ?? (req.body as any)?.allowDownload, true),
      metadata: parseJSON((req.body as any)?.metadata),
      is_delete: false,
    };

    const reel = await repository.createReel(payload);

    return formatResponse({
      res,
      success: true,
      body: { reel },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const add_reel_comment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const commentText = String((req.body as any)?.comment ?? "").trim();
    const media_url = String((req.body as any)?.media_url ?? "").trim() || null;

    if (!commentText && !media_url) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "comment or media_url is required",
      });
    }

    const result = await repository.addComment(id, req.userId, {
      comment: commentText || null,
      media_url,
    });

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        comment: result.comment,
        comments_count: result.comments_count,
        commentsCount: result.comments_count,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
