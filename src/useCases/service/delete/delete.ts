import {
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
  socket,
  sendEmailToMany,
} from "../_module/module";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";
import {
  attachServiceRoutingFields,
  toServiceUpdatedSocketPayload,
} from "../../../libs/service_client_bucket";
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

  const clientAlreadyRatedWorker = await repository.hasClientRatedWorkerForService(
    id,
    req.userId
  );
  if (clientAlreadyRatedWorker) {
    return formatResponse({
      res: res,
      success: false,
      message:
        "Service cannot be canceled after rating the worker. Please finalize the service instead.",
      islogin: true,
      code: 409,
    });
  }
	
  const workers = await repository.workersByService(id, req.userId);
  let emails = [];
  //send emails
  for (let i = 0; i < workers.length; i++) {
    emails.push(workers[i].personal_data?.email);

    await sendNotification({
      userId: workers[i]!.personal_data.id,
      interactorId: req.userId,
      serviceId: parseInt(tempService.id),
      type: "requestCanceled",
      message: `The offer has closed.`,
    });
  }
  //SEND EMAIL
  const emailParams = {
    subject: "The offer has closed",
    emails: emails,
    htmlPath: "./src/public/html/email/service_canceled_email.html",
    replacements: [],
  };

  await repository.deleteservice(id);
  await bumpHomeContentSectionVersion("services");
  const response = await repository.getByUser(id, req.userId);
  const safeResponse =
    response && typeof (response as any).toJSON === "function"
      ? (response as any).toJSON()
      : response;
  attachServiceRoutingFields(safeResponse);
  sendEmailToMany(emailParams);

  ////////Emit the service/////
  socket.emit("services", safeResponse);
  socket.emit("service.updated", toServiceUpdatedSocketPayload(safeResponse));
  return formatResponse({
    res: res,
    success: true,
    message: "Service deleted successfully",
    body: safeResponse,
  });
};
