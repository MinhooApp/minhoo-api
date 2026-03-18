import { findById } from "../../../repository/auth/auth_repository";
import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import * as savedRepository from "../../../repository/saved/saved_repository";

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
  await savedRepository.removeByPostId(Number(id));

  return formatResponse({
    res: res,
    success: true,
    message: "Post deleted successfully",
  });
};

export const deletePostAdmin = async (req: Request, res: Response) => {
  const { id } = req.params;
  const tempService = await repository.get(id);
  if (!tempService) {
    return formatResponse({
      res: res,
      success: false,
      message: "Post not found",
    });
  }
  await repository.deletePost(id);
  await savedRepository.removeByPostId(Number(id));

  return formatResponse({
    res: res,
    success: true,
    message: "Post deleted successfully",
  });
};
