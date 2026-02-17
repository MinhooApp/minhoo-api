import { Request, Response, formatResponse, repository } from "../_module/module";

const parsePostId = (raw: any): number | null => {
  const postId = Number(raw);
  if (!Number.isFinite(postId) || postId <= 0) return null;
  return postId;
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
    const saveCount = await repository.countByPostId(postId);
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
