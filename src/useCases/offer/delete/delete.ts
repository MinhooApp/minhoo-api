import {
  Request,
  Response,
  formatResponse,
  repository,
  serviceRepository,
  sendEmail,
  sendNotification,
  socket,
} from "../_module/module";

export const removeOffer = async (req: Request, res: Response) => {
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

    // ✅ SOLO dueño del servicio puede cancelar (remove)
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

    // ✅ quita del pivot de workers (si estaba asignado)
    await serviceRepository.removeWorker(offer.serviceId, offer.workerId);

    // ✅ marca cancelado por cliente en offer (removed=true)
    // (también mantiene tu helper cancelWorker por compatibilidad si lo usas en otros puntos)
    await serviceRepository.cancelWorker(offer.serviceId, offer.workerId, true);

    // ✅ update definitivo: queda en Cancelled bloqueado
    await repository.update(offerId, {
      accepted: false,
      removed: true,
      canceled: false,
    });

    const service = await serviceRepository.get(offer.serviceId);

    //SEND EMAIL
    const emailParams = {
      subject: "Application Cancelled",
      email: offer.offerer.personal_data.email,
      htmlPath: "./src/public/html/email/offer_canceled_by_client_email.html",
      replacements: [
        {
          code: "@@name",
          name: `${offer.offerer.personal_data.name} ${offer.offerer.personal_data.last_name}`,
        },
      ],
    };

    // ✅ userId correcto (el user del worker)
    await sendNotification({
      userId: offer.offerer.userId,
      interactorId: req.userId,
      serviceId: Number(offer.serviceId),
      offerId: offer.id,
      type: "applicationCanceled",
      message: "has withdrawn your candidacy",
    });

    sendEmail(emailParams);

    // ✅ emitir para refresco rápido
    socket.emit("offers", { serviceId: offer.serviceId });

    return formatResponse({
      res,
      success: true,
      body: { service },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
