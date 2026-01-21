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

  try {
    const offer = await repository.get(offerId);
    if (!offer) {
      return formatResponse({
        res,
        success: false,
        message: "Offer not found.",
        code: 400,
      });
    }

    const tempService = await serviceRepository.get(offer.serviceId);
    if (!tempService) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 400,
      });
    }

    // ✅ Solo el dueño del servicio
    if (tempService.userId != req.userId) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 400,
      });
    }

    // ✅ SOLO SI SERVICIO ACTIVO (regla definitiva)
    if (tempService.statusId != 1 || tempService.is_available != true) {
      return formatResponse({
        res,
        success: false,
        message: "Service is not active.",
        code: 400,
      });
    }

    // ✅ Si la offer está cancelada por cliente o worker, NO se puede aceptar
    // Solo se puede aceptar si el worker vuelve a postularse (add re-activa)
    if (offer.canceled === true || offer.removed === true) {
      return formatResponse({
        res,
        success: false,
        message:
          "This application was canceled. The worker must apply again to be accepted.",
        code: 400,
      });
    }

    const workers: any[] = tempService.workers ?? [];
    const filteredWorkersActives = workers.filter((worker) => {
      return worker.service_worker?.removed == false;
    });

    if (filteredWorkersActives.length >= tempService.places) {
      return formatResponse({
        res,
        success: false,
        message: "The spaces available for service are complete.",
        code: 400,
      });
    }

    const assigned: boolean =
      filteredWorkersActives.length + 1 >= tempService.places;

    await serviceRepository.assignWorker(offer.workerId, tempService, assigned);

    // ✅ update consistente (limpia flags)
    await repository.update(offerId, {
      accepted: true,
      canceled: false,
      removed: false,
    });

    const service = await serviceRepository.get(offer.serviceId);

    await sendNotification({
      userId: offer.offerer.userId,
      interactorId: req.userId,
      serviceId: offer.serviceId,
      offerId: offer.id,
      type: "offerAccepted",
      message: `has accepted your job offer!`,
    });

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
    sendEmail(emailParams);

    // ✅ emitir para refresco rápido (mejor enviar serviceId)
    socket.emit("offers", { serviceId: offer.serviceId });

    return formatResponse({ res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const cancelOffer = async (req: Request, res: Response) => {
  const { offerId } = req.params;

  try {
    const offer = await repository.get(offerId);
    if (!offer) {
      return formatResponse({
        res,
        success: false,
        message: "Offer not found.",
        code: 400,
      });
    }

    const tempService = await serviceRepository.get(offer.serviceId);
    if (!tempService) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 400,
      });
    }

    // ✅ SOLO SI SERVICIO ACTIVO (regla definitiva)
    if (tempService.statusId != 1 || tempService.is_available != true) {
      return formatResponse({
        res,
        success: false,
        message: "Service is not active.",
        code: 400,
      });
    }

    // ✅ worker cancela su postulación / o cancela estando aceptado
    // 1) quitarlo de workers
    await serviceRepository.removeWorker(offer.serviceId, req.workerId);

    // 2) 🔥 IMPORTANTÍSIMO: liberar el estado “aceptado/asignado” del service
    // para que si el worker reaplica vuelva a Applicants y NO quede como Accepted.
    await serviceRepository.cancelWorker(offer.serviceId, req.workerId, true);

    // ✅ update consistente
    await repository.update(offerId, {
      accepted: false,
      canceled: true,
      removed: false,
    });

    const service = await serviceRepository.get(offer.serviceId);

    socket.emit("offers", { serviceId: offer.serviceId });

    const emailParams = {
      subject: "Application canceled",
      email: service!.client.email,
      htmlPath: "./src/public/html/email/offer_canceled_by_worker_email.html",
      replacements: [
        {
          code: "@@name",
          name: `${service!.client.name} ${service!.client.last_name}`,
        },
      ],
    };

    await sendNotification({
      userId: service!.userId,
      interactorId: req.userId,
      serviceId: offer.serviceId,
      offerId: offer.id,
      type: "applicationCanceled",
      message: `Application canceled`,
    });

    sendEmail(emailParams);

    return formatResponse({ res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};


