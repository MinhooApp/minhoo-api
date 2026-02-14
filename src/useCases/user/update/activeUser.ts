import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const activeUser = async (req: Request, res: Response) => {
  try {
    const userTemp = await repository.get(req.params.id);

    if (userTemp == null) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
      });
    }

    const user = await repository.activeUser(req.params.id);

    return formatResponse({
      res,
      success: true,
      body: { user },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({
      res,
      success: false,
      message: error,
    });
  }
};
