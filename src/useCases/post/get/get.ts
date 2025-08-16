import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const gets = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 10 } = req.query;
    const posts = await repository.gets(page, size, req.userId);

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: posts.count,
        posts: posts.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const post = await repository.get(id);

    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
