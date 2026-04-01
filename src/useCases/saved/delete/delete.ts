import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  socket,
} from "../_module/module";

const parsePostId = (raw: any): number | null => {
  const postId = Number(raw);
  if (!Number.isFinite(postId) || postId <= 0) return null;
  return postId;
};

const toCounter = (value: any): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
};

export const unsave_post = async (req: Request, res: Response) => {
  try {
    const postId = parsePostId((req.params as any)?.postId);
    if (!postId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "postId must be a valid number",
      });
    }

    const result = await repository.removeSavedPost(req.userId, postId);
    const saveCount = toCounter((result as any)?.savesCount ?? 0);
    const visiblePost = await repository.getVisiblePost(postId);
    const hydratedPost = await postRepository.get(postId, req.userId);
    if (hydratedPost) {
      if (typeof (hydratedPost as any).setDataValue === "function") {
        (hydratedPost as any).setDataValue("saves_count", saveCount);
        (hydratedPost as any).setDataValue("savesCount", saveCount);
        (hydratedPost as any).setDataValue("is_saved", false);
        (hydratedPost as any).setDataValue("isSaved", false);
      } else {
        (hydratedPost as any).saves_count = saveCount;
        (hydratedPost as any).savesCount = saveCount;
        (hydratedPost as any).is_saved = false;
        (hydratedPost as any).isSaved = false;
      }
    }

    const likesCount = toCounter(
      (hydratedPost as any)?.likes_count ??
        (hydratedPost as any)?.likesCount ??
        (visiblePost as any)?.likes_count ??
        (visiblePost as any)?.likesCount
    );
    const ownerId =
      Number(
        (hydratedPost as any)?.userId ??
          (hydratedPost as any)?.user_id ??
          (hydratedPost as any)?.user?.id ??
          (visiblePost as any)?.userId ??
          0
      ) || null;
    const updatedAt = new Date().toISOString();

    socket.emit("post/updated", {
      action: "unsaved",
      postId,
      post_id: postId,
      ownerId,
      owner_id: ownerId,
      actorUserId: Number(req.userId ?? 0) || null,
      actor_user_id: Number(req.userId ?? 0) || null,
      likesCount,
      likes_count: likesCount,
      starsCount: likesCount,
      stars_count: likesCount,
      starCount: likesCount,
      star_count: likesCount,
      savesCount: saveCount,
      saves_count: saveCount,
      savedCount: saveCount,
      saved_count: saveCount,
      isSaved: false,
      is_saved: false,
      removed: Boolean((result as any)?.removed),
      updatedAt,
      updated_at: updatedAt,
      post:
        hydratedPost ??
        {
          id: postId,
          userId: ownerId,
          user_id: ownerId,
          likes_count: likesCount,
          likesCount,
          stars_count: likesCount,
          starsCount: likesCount,
          star_count: likesCount,
          starCount: likesCount,
          saves_count: saveCount,
          savesCount: saveCount,
          saved_count: saveCount,
          savedCount: saveCount,
          is_saved: false,
          isSaved: false,
      },
    });
    console.log(
      `[unsaved_post] userId=${Number(req.userId ?? 0)} postId=${postId} removed=${Boolean(
        (result as any)?.removed
      )} savesCount=${saveCount}`
    );

    return formatResponse({
      res,
      success: true,
      body: {
        postId,
        saved: false,
        removed: result.removed,
        saved_count: saveCount,
        savedCount: saveCount,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
