import { worker } from "repository/worker/worker_repository";
import {
  socket,
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const update = async (req: Request, res: Response) => {};

export const finalized = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const tempService = await repository.get(id);
    if (tempService!.userId != req.userId) {
      return formatResponse({
        res: res,
        success: false,
        message: "Service not found.",
        code: 400,
      });
    }
    const service = await repository.finalizedService(id);
    const offer = {
      serviceId: id,
    };
    socket.emit("offers", offer);
    const deletedService = await repository.get(id);
    socket.emit("services", deletedService);
    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error,
      code: 400,
    });
  }
};
