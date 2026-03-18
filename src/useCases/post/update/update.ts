import {
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
} from "../_module/module";

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

    const post = await repository.get(id);
    if (post) {
      if (typeof (post as any).setDataValue === "function") {
        (post as any).setDataValue("likes_count", result.likesCount ?? 0);
      } else {
        (post as any).likes_count = result.likesCount ?? 0;
      }
    }

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
