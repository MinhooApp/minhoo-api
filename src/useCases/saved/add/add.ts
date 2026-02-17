import { Request, Response, formatResponse, repository } from "../_module/module";

const parsePostId = (raw: any): number | null => {
  const postId = Number(raw);
  if (!Number.isFinite(postId) || postId <= 0) return null;
  return postId;
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

    const post = await repository.getVisiblePost(postId);
    if (!post) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "post not found",
      });
    }

    const result = await repository.savePost(req.userId, postId);
    const saveCount = await repository.countByPostId(postId);
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
