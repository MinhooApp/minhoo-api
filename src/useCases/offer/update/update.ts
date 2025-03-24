import {
  Request,
  Response,
  formatResponse,
  repository,
  serviceRepository,
  socket,
  sendNotification,
  sendEmail,
} from "../_module/module";

export const acceptOffer = async (req: Request, res: Response) => {
  const { offerId } = req.params;
  // const { serviceId, workerId, } = req.body;
  try {
    const offer = await repository.get(offerId);
    if (offer == null) {
      return formatResponse({
        res: res,
        success: false,
        message: "Offer not found.",
        code: 400,
      });
    }
    const tempService = await serviceRepository.get(offer!.serviceId);
    const workers: any[] = tempService!.workers;

    const filteredWorkersActives = workers.filter((worker) => {
      return worker.service_worker.removed == false;
    });
    //return formatResponse({ res: res, success: true, body: filteredWorkersActives! });
    if (tempService!.userId != req.userId) {
      return formatResponse({
        res: res,
        success: false,
        message: "Service not found.",
        code: 400,
      });
    }
    if (filteredWorkersActives.length >= tempService!.places) {
      return formatResponse({
        res: res,
        success: false,
        message: "The spaces available for service are complete.",
        code: 400,
      });
    }

    const assigned: boolean =
      filteredWorkersActives.length + 1 >= tempService!.places;
    await serviceRepository.assignWorker(
      offer!.workerId,
      tempService!,
      assigned
    );
    await repository.update(offerId, { accepted: true });
    const service = await serviceRepository.get(offer!.serviceId);

    await sendNotification({
      userId: offer.offerer.userId,
      interactorId: req.userId,
      serviceId: offer.serviceId,
      offerId: offer.id,
      type: "offerAccepted",
      message: `has accepted your job offer!`,
    });

    //SEND EMAIL
    const emailParams = {
      subject: "Offer Accepted",
      email: offer.offerer.personal_data.email,
      htmlPath: "./src/public/html/email/offer_accepted_email.html",
      replacements: [
        {
          code: "@@name",
          name: `${offer.offerer.personal_data.name} ${offer.offerer.personal_data.last_name}`,
        },
      ],
    };
    await sendEmail(emailParams);
    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const cancelOffer = async (req: Request, res: Response) => {
  const { offerId } = req.params;
  // const { serviceId, workerId, } = req.body;
  try {
    const offer = await repository.get(offerId);
    if (offer == null) {
      return formatResponse({
        res: res,
        success: false,
        message: "Offer not found.",
        code: 400,
      });
    }

    //cancel worker from offer////
    await serviceRepository.cancelWorker(offer!.serviceId, req.workerId);
    await repository.update(offerId, { accepted: false, canceled: true });

    const service = await serviceRepository.get(offer!.serviceId);

    socket.emit("offers", offer);
    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
