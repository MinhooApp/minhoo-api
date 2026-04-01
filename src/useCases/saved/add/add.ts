import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  socket,
  sendNotification,
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

export const save_post = async (req: Request, res: Response) => {
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

    const visiblePost = await repository.getVisiblePost(postId);
    if (!visiblePost) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "post not found",
      });
    }

    const result = await repository.savePost(req.userId, postId);
    const saveCount = toCounter((result as any)?.savesCount ?? 0);
    const hydratedPost = await postRepository.get(postId, req.userId);
    if (hydratedPost) {
      if (typeof (hydratedPost as any).setDataValue === "function") {
        (hydratedPost as any).setDataValue("saves_count", saveCount);
        (hydratedPost as any).setDataValue("savesCount", saveCount);
        (hydratedPost as any).setDataValue("is_saved", true);
        (hydratedPost as any).setDataValue("isSaved", true);
      } else {
        (hydratedPost as any).saves_count = saveCount;
        (hydratedPost as any).savesCount = saveCount;
        (hydratedPost as any).is_saved = true;
        (hydratedPost as any).isSaved = true;
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

    const shouldNotifyOwner =
      Boolean(result.created) && Number(visiblePost.userId) !== Number(req.userId);

    console.log(
      `[saved_post] userId=${req.userId} postId=${postId} created=${Boolean(
        result.created
      )} ownerId=${Number(visiblePost.userId)} notify=${shouldNotifyOwner}`
    );

    if (shouldNotifyOwner) {
      try {
        await sendNotification({
          postId: Number(visiblePost.id),
          userId: Number(visiblePost.userId),
          interactorId: req.userId,
          type: "like",
          message: "Has saved your post.",
        });
        console.log(
          `[saved_post] notification sent ownerId=${Number(
            visiblePost.userId
          )} interactorId=${req.userId} postId=${postId}`
        );
      } catch (notifyError) {
        console.error(
          `[saved_post] notification failed ownerId=${Number(
            visiblePost.userId
          )} interactorId=${req.userId} postId=${postId}`,
          notifyError
        );
      }
    }

    socket.emit("post/updated", {
      action: "saved",
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
      isSaved: true,
      is_saved: true,
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
          is_saved: true,
          isSaved: true,
        },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        postId,
        saved: true,
        created: result.created,
        saved_count: saveCount,
        savedCount: saveCount,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
