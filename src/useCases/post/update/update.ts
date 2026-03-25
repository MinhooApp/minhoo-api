import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";

const toCounter = (value: any): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
};

const toPositiveIntOrNull = (value: any): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const toBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const toPlainObject = (value: any): any => {
  if (!value) return null;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") return { ...value.dataValues };
  return value;
};

const emitPostUpdatedRealtime = (params: {
  action: string;
  postRaw?: any;
  postIdRaw?: any;
  ownerIdRaw?: any;
  actorUserIdRaw?: any;
  likesCountRaw?: any;
  savesCountRaw?: any;
  sharesCountRaw?: any;
  commentsCountRaw?: any;
  isLikedRaw?: any;
  isSavedRaw?: any;
}) => {
  const sourcePost = toPlainObject(params.postRaw) ?? {};
  const postId = toPositiveIntOrNull(sourcePost.id ?? params.postIdRaw);
  if (!postId) return;

  const ownerId = toPositiveIntOrNull(
    sourcePost.userId ?? sourcePost.user_id ?? sourcePost.user?.id ?? params.ownerIdRaw
  );
  const actorUserId = toPositiveIntOrNull(params.actorUserIdRaw);
  const likesCount = toCounter(params.likesCountRaw ?? sourcePost.likes_count ?? sourcePost.likesCount);
  const savesCount = toCounter(params.savesCountRaw ?? sourcePost.saves_count ?? sourcePost.savesCount);
  const sharesCount = toCounter(params.sharesCountRaw ?? sourcePost.shares_count ?? sourcePost.sharesCount);
  const commentsCount = toCounter(
    params.commentsCountRaw ?? sourcePost.comments_count ?? sourcePost.commentsCount
  );
  const isLiked = toBoolOrNull(params.isLikedRaw ?? sourcePost.is_liked ?? sourcePost.isLiked);
  const isSaved = toBoolOrNull(params.isSavedRaw ?? sourcePost.is_saved ?? sourcePost.isSaved);

  const normalizedPost = {
    ...sourcePost,
    id: postId,
    userId: ownerId,
    user_id: ownerId,
    likes_count: likesCount,
    likesCount,
    saves_count: savesCount,
    savesCount,
    shares_count: sharesCount,
    sharesCount,
    comments_count: commentsCount,
    commentsCount,
    is_liked: isLiked,
    isLiked: isLiked,
    is_saved: isSaved,
    isSaved: isSaved,
  };
  const updatedAt = new Date().toISOString();

  socket.emit("post/updated", {
    action: params.action,
    postId,
    post_id: postId,
    ownerId,
    owner_id: ownerId,
    actorUserId,
    actor_user_id: actorUserId,
    likesCount,
    likes_count: likesCount,
    savesCount,
    saves_count: savesCount,
    sharesCount,
    shares_count: sharesCount,
    commentsCount,
    comments_count: commentsCount,
    isLiked,
    is_liked: isLiked,
    isSaved,
    is_saved: isSaved,
    updatedAt,
    updated_at: updatedAt,
    post: normalizedPost,
  });
};

export const like = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.toggleLike(req.userId, id);
    if (result?.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "post not found",
      });
    }

    const post = await repository.get(id, req.userId);
    if (post) {
      if (typeof (post as any).setDataValue === "function") {
        (post as any).setDataValue("likes_count", result.likesCount ?? 0);
        (post as any).setDataValue("likesCount", result.likesCount ?? 0);
        (post as any).setDataValue("is_liked", Boolean(result.liked));
        (post as any).setDataValue("isLiked", Boolean(result.liked));
      } else {
        (post as any).likes_count = result.likesCount ?? 0;
        (post as any).likesCount = result.likesCount ?? 0;
        (post as any).is_liked = Boolean(result.liked);
        (post as any).isLiked = Boolean(result.liked);
      }
    }

    emitPostUpdatedRealtime({
      action: result?.liked ? "liked" : "unliked",
      postRaw: post,
      postIdRaw: id,
      ownerIdRaw: post?.userId,
      actorUserIdRaw: req.userId,
      likesCountRaw: result?.likesCount,
      savesCountRaw: (post as any)?.saves_count ?? (post as any)?.savesCount,
      sharesCountRaw: (post as any)?.shares_count ?? (post as any)?.sharesCount,
      commentsCountRaw: (post as any)?.comments_count ?? (post as any)?.commentsCount,
      isLikedRaw: result?.liked,
      isSavedRaw: (post as any)?.is_saved ?? (post as any)?.isSaved,
    });

    if (result?.liked) {
      await sendNotification({
        postId: post?.id,
        userId: post?.userId,
        interactorId: req.userId,
        type: "like",
        message: `Has given your post a star!`,
      });
    }
    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const share = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.sharePost(id);
    if (!result?.found) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "post not found",
      });
    }

    const post = await repository.get(id, req.userId);
    if (post) {
      if (typeof (post as any).setDataValue === "function") {
        (post as any).setDataValue("shares_count", result.sharesCount ?? 0);
        (post as any).setDataValue("sharesCount", result.sharesCount ?? 0);
      } else {
        (post as any).shares_count = result.sharesCount ?? 0;
        (post as any).sharesCount = result.sharesCount ?? 0;
      }
    }

    emitPostUpdatedRealtime({
      action: "shared",
      postRaw: post,
      postIdRaw: id,
      ownerIdRaw: post?.userId,
      actorUserIdRaw: req.userId,
      likesCountRaw: (post as any)?.likes_count ?? (post as any)?.likesCount,
      savesCountRaw: (post as any)?.saves_count ?? (post as any)?.savesCount,
      sharesCountRaw: result?.sharesCount,
      commentsCountRaw: (post as any)?.comments_count ?? (post as any)?.commentsCount,
      isLikedRaw: (post as any)?.is_liked ?? (post as any)?.isLiked,
      isSavedRaw: (post as any)?.is_saved ?? (post as any)?.isSaved,
    });

    return formatResponse({
      res,
      success: true,
      body: {
        postId: Number(id),
        shares_count: result.sharesCount ?? 0,
        sharesCount: result.sharesCount ?? 0,
        post,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
