import { uRepository } from "useCases/auth/_module/module";
import { findById } from "../../../repository/auth/auth_repository";
import {
  //
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
  socket,
  sendEmail,
  workerRepository,
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
  const { workerId } = req.body;
  const { serviceId } = req.params;
  try {
    const workerTemp = await repository.removeWorker(serviceId, workerId);
    const workerData = await workerRepository.worker(workerId);
    //SEND EMAIL
    const emailParams = {
      subject: "Offer Removed",
      email: workerData!.personal_data.email,
      htmlPath: "./src/public/html/email/offer_canceled_by_client_email.html",
      replacements: [
        {
          code: "@@name",
          name: `${workerData!.personal_data.name} ${
            workerData!.personal_data.last_name
          }`,
        },
      ],
    };
    await sendNotification({
      userId: workerData!.personal_data.id,
      interactorId: req.userId,
      serviceId: parseInt(serviceId),
      type: "applicationRemoved",
      message: `${workerData!.personal_data.name} ${
        workerData!.personal_data.last_name
      } has canceled your application.`,
    });
    await sendEmail(emailParams);

    return formatResponse({ res: res, success: true, body: workerTemp });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
