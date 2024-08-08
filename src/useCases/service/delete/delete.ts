import {
  Request,
  Response,
  formatResponse,
  repository,
  sendPushToMultipleUsers,
  socket,
} from "../_module/module";
export const deleteService = async (req: Request, res: Response) => {
  const { id } = req.params;
  const tempService = await repository.getByUser(id, req.userId);
  if (!tempService) {
    return formatResponse({
      res: res,
      success: false,
      message: "Service not found",
    });
  }
  await repository.deleteservice(id);

  ////////Emit the service/////
  socket.emit("services", tempService);
  return formatResponse({
    res: res,
    success: true,
    message: "Service deleted successfully",
  });
};

export const removeWorker = async (req: Request, res: Response) => {
  const { serviceId } = req.params;
  const { workerId } = req.body;
  try {
    const worker = await repository.removeWorker(serviceId, workerId);

    return formatResponse({ res: res, success: true, body: worker });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
