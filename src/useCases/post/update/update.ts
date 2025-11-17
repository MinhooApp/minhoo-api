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
    const like = await repository.toggleLike(req.userId, id);
    const post = await repository.get(id);
    if (like) {
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
