import { Request, Response, formatResponse, repository } from "../_module/module";

export const saved_posts = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 20 } = req.query;
    const saved = await repository.listSavedPosts(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: saved,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const saved_videos = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 20 } = req.query;
    const saved = await repository.listSavedVideos(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: saved,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
