import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const deletePost = async (req: Request, res: Response) => {
  const { id } = req.params;
  const tempService = await repository.getOneByUser(id, req.userId);
  if (!tempService) {
    return formatResponse({
      res: res,
      success: false,
      message: "Post not found",
    });
  }
  await repository.deletePost(id);

  return formatResponse({
    res: res,
    success: true,
    message: "Post deleted successfully",
  });
};
