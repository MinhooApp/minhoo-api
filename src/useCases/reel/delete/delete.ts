import { Request, Response, formatResponse, repository } from "../_module/module";

export const delete_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.deleteReel(id, req.userId);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    if (result.forbidden) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you do not have permission to delete this reel",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        deleted: true,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const delete_reel_comment = async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const result = await repository.deleteComment(commentId, req.userId);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "comment not found",
      });
    }

    if (result.forbidden) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you do not have permission to delete this comment",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        removed: result.removed,
        reelId: result.reelId,
        comments_count: result.comments_count,
        commentsCount: result.comments_count,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
