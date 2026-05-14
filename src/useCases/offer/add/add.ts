import {
  Request,
  Response,
  formatResponse,
  repository,
  sendEmail,
  socket,
  sendNotification,
} from "../_module/module";
import {
  attachApplicantsCountAliases,
  enrichServiceApplicantsStatus,
  resolveApplicantsCount,
} from "../../../libs/applicants_status";
import { toServiceUpdatedSocketPayload } from "../../../libs/service_client_bucket";

export const add = async (req: Request, res: Response) => {
  try {
    const body = req.body;
    body.workerId = req.workerId;
    const now = new Date(new Date().toUTCString());
    req.body.offer_date = now;
    const offer = await repository.add(body);
    const response = await repository.get(offer.id);
    const service = enrichServiceApplicantsStatus(response?.service ?? null);
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
    const ownerUserId = Number(response?.service?.userId ?? 0);
    const workerUserId = Number(req?.userId ?? 0);
    const targetUserIds = [ownerUserId, workerUserId].filter((id) => id > 0);

    socket.emit("offers", {
      action: "created",
      eventAction: "offer_created",
      serviceId: Number(offer?.serviceId ?? body?.serviceId ?? 0),
      ownerUserId,
      targetUserIds,
      target_user_ids: targetUserIds,
      offerId: Number(offer?.id ?? 0),
      workerId: Number(offer?.workerId ?? body?.workerId ?? 0),
      offer: response ?? offer,
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
      action: "created",
      eventAction: "offer_created",
      serviceId: Number(offer?.serviceId ?? body?.serviceId ?? 0),
      ownerUserId,
      targetUserIds,
      target_user_ids: targetUserIds,
      offerId: Number(offer?.id ?? 0),
      workerId: Number(offer?.workerId ?? body?.workerId ?? 0),
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
    await sendNotification({
      userId: response!.service.userId,
      interactorId: req.userId,
      serviceId: offer.serviceId,
      offerId: offer.id,
      type: "postulation",
      message: `Sent you a new offer!`,
    });
    //SEND EMAIL
    const emailParams = {
      subject: "There is an applicant for your offer",
      email: response!.service.client.email,
      htmlPath: "./src/public/html/email/send_offer_emmail.html",
      replacements: [
        {
          code: "@@name",
          name: `${response!.service!.client.name} ${
            response!.service!.client.last_name
          }`,
        },
      ],
    };
    sendEmail(emailParams);
    return formatResponse({
      res: res,
      success: true,
      body: {
        offer: response,
        service: service ?? null,
        offersCount,
        offers_count: offersCount,
        applicantsCount: offersCount,
        applicants_count: offersCount,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
