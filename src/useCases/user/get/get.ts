import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const gets = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 5 } = req.query;
    const users: any = await repository.users(page, size);
    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: users.count,
        users: users.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const user = await repository.get(id);
    return formatResponse({ res: res, success: true, body: { user: user } });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const myData = async (req: Request, res: Response) => {
  try {
    const user = await repository.get(req.userId);
    return formatResponse({ res: res, success: true, body: { user: user } });
  } catch (error) {
    console.log(req.userId);
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const follows = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const follows = await repository.follows(id ?? req.userId);

    return formatResponse({ res: res, success: true, body: { follows } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const followers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const followers = await repository.followers(id ?? req.userId);
    return formatResponse({ res: res, success: true, body: { followers } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const validatePhone = async (req: Request, res: Response) => {
  const { phone, dialing_code } = req.body;

  if (!phone) {
    return formatResponse({
      res,
      success: false,
      message: "Phone is required",
    });
  }
  if (!dialing_code) {
    return formatResponse({
      res,
      success: false,
      message: "Dialing Code is required",
    });
  }

  try {
    const user = await repository.findByPhone(req.userId, phone, dialing_code);

    if (user) {
      return formatResponse({
        res,
        success: true,
        body: { already_exists: true },
      });
    } else {
      return formatResponse({
        res,
        success: true,
        body: { already_exists: false },
      });
    }
  } catch (error) {
    console.error("Error in validatePhone:", error);
    return formatResponse({
      res,
      success: false,
      message: "Internal server error",
    });
  }
};
