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
import {
  attachApplicantsCountAliases,
  enrichServiceApplicantsStatus,
  resolveApplicantsCount,
} from "../../../libs/applicants_status";
import { toServiceUpdatedSocketPayload } from "../../../libs/service_client_bucket";
import logger from "../../../libs/logger/logger";

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

    // ✅ Cliente puede remover un trabajador sin cancelar la orden completa
    // mientras el servicio esté activo en flujo de trabajo.
    // statusId: 1=searching, 2=assigned, 3=in_progress
    // y también en 4 cuando aún no hubo cierre manual del cliente.
    const statusId = Number(tempService.statusId);
    const manualClosedAt =
      (tempService as any)?.manual_closed_at ?? (tempService as any)?.manualClosedAt;
    const canRemoveInFinalizedPendingClose = statusId === 4 && !manualClosedAt;
    const allowedStatuses = new Set([1, 2, 3]);
    const canRemoveWorker =
      tempService.is_available == true &&
      (allowedStatuses.has(statusId) || canRemoveInFinalizedPendingClose);

    if (!canRemoveWorker) {
      return formatResponse({
        res,
        success: false,
        message: "Service cannot remove workers in the current status.",
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

    const service = enrichServiceApplicantsStatus(
      await serviceRepository.get(offer.serviceId)
    );
    const offersCount = attachApplicantsCountAliases(
      service,
      resolveApplicantsCount(service)
    );
    const refreshLists = [
      "offers",
      "offers/pending",
      "offers/accepted",
      "myonGoing",
      "onGoing/worker",
      "history/worker",
      "worker/canceled",
    ];
    const routing = toServiceUpdatedSocketPayload(service ?? null);
    const ownerUserId = Number(tempService?.userId ?? service?.userId ?? 0);
    const workerUserId = Number(offer?.offerer?.userId ?? 0);
    const targetUserIds = [ownerUserId, workerUserId].filter((id) => id > 0);

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

    // ✅ emitir para refresco en tiempo real (global + por serviceId)
    socket.emit("offers", {
      action: "removed",
      eventAction: "offer_removed",
      serviceId: Number(offer?.serviceId ?? 0),
      ownerUserId,
      targetUserIds,
      target_user_ids: targetUserIds,
      offerId: Number(offer?.id ?? 0),
      workerId: Number(offer?.workerId ?? 0),
      service: service ?? null,
      offersCount,
      offers_count: offersCount,
      applicantsCount: offersCount,
      applicants_count: offersCount,
      ...routing,
      refreshLists,
      updatedAt: new Date().toISOString(),
    });
    socket.emit("services", {
      action: "removed",
      eventAction: "offer_removed",
      serviceId: Number(offer?.serviceId ?? 0),
      ownerUserId,
      targetUserIds,
      target_user_ids: targetUserIds,
      offerId: Number(offer?.id ?? 0),
      workerId: Number(offer?.workerId ?? 0),
      service: service ?? null,
      offersCount,
      offers_count: offersCount,
      applicantsCount: offersCount,
      applicants_count: offersCount,
      ...routing,
      refreshLists,
      updatedAt: new Date().toISOString(),
    });
    socket.emit("service.updated", routing);

    return formatResponse({
      res,
      success: true,
      body: {
        service,
        offersCount,
        offers_count: offersCount,
        applicantsCount: offersCount,
        applicants_count: offersCount,
      },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};
