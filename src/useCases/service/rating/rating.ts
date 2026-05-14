import {
  Request,
  Response,
  formatResponse,
  repository as serviceRepository,
  sendNotification,
  socket,
} from "../_module/module";
import {
  createClientToWorkerRating,
  createWorkerToClientRating,
  normalizeRatingPayload,
} from "../../../repository/service/service_rating_repository";
import {
  attachApplicantsCountAliases,
  enrichServiceApplicantsStatus,
  resolveApplicantsCount,
} from "../../../libs/applicants_status";
import {
  attachServiceRoutingFields,
  toServiceUpdatedSocketPayload,
} from "../../../libs/service_client_bucket";
import { getUserReputation } from "../../../repository/user/user_reputation_repository";
import {
  emitUserReputationUpdatedRealtime,
  emitUserUpdatedRealtime,
} from "../../../libs/helper/realtime_dispatch";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toReviewerName = (reviewerRaw: any): string => {
  const reviewer = reviewerRaw ?? {};
  const fullName = `${String(reviewer?.name ?? "").trim()} ${String(
    reviewer?.last_name ?? ""
  ).trim()}`.trim();
  if (fullName) return fullName;
  const username = String(reviewer?.username ?? "").trim();
  if (username) return username;
  return "Minhoo";
};

const toBoundedRate = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const bounded = Math.min(Math.max(parsed, 0), 5);
  return Math.round(bounded * 10) / 10;
};

const buildRealtimeUserReputationSummary = (data: any) => {
  const customer = data?.customer ?? null;
  const worker = data?.worker ?? null;
  const customerRate = toBoundedRate(customer?.rate ?? customer?.rating);
  const workerRate = toBoundedRate(worker?.rate ?? worker?.rating);
  const customerReviewsCount = Math.max(0, Number(customer?.reviews_count ?? 0) || 0);
  const workerReviewsCount = Math.max(0, Number(worker?.reviews_count ?? 0) || 0);
  const primaryRate = workerRate > 0 ? workerRate : customerRate;
  const primaryReviewsCount = workerRate > 0 ? workerReviewsCount : customerReviewsCount;

  return {
    primaryRate,
    primaryReviewsCount,
    customerRate,
    workerRate,
    customerReviewsCount,
    workerReviewsCount,
  };
};

const normalizeServiceForRealtime = (serviceRaw: any) => {
  const service =
    serviceRaw && typeof serviceRaw.toJSON === "function"
      ? serviceRaw.toJSON()
      : serviceRaw ?? {};
  const enrichedService = enrichServiceApplicantsStatus(service);
  const offersCount = attachApplicantsCountAliases(
    enrichedService,
    resolveApplicantsCount(enrichedService)
  );
  const routing = attachServiceRoutingFields(enrichedService);
  return { service: enrichedService, offersCount, routing };
};

const emitRatingUpdatedRealtime = async ({
  serviceId,
  ownerUserId,
  targetUserIds = [],
  eventAction,
  extraFlags = {},
}: {
  serviceId: number;
  ownerUserId: number;
  targetUserIds?: number[];
  eventAction: string;
  extraFlags?: Record<string, any>;
}) => {
  try {
    const fullService = await serviceRepository.get(serviceId);
    if (!fullService) return;

    const { service, offersCount } = normalizeServiceForRealtime(fullService);
    const socketRoutingPayload = toServiceUpdatedSocketPayload(service);
    const refreshLists = [
      "myonGoing",
      "myHistory",
      "myHistoryCanceled",
      "onGoing/worker",
      "history/worker",
      "worker/canceled",
    ];

    const basePayload = {
      action: "updated",
      eventAction,
      serviceId: socketRoutingPayload.id,
      ownerUserId,
      service,
      offersCount,
      offers_count: offersCount,
      applicantsCount: offersCount,
      applicants_count: offersCount,
      ...socketRoutingPayload,
      ...extraFlags,
      targetUserIds,
      target_user_ids: targetUserIds,
      refreshLists,
      updatedAt: new Date().toISOString(),
    };

    socket.emit("service.updated", {
      ...socketRoutingPayload,
      ...extraFlags,
    });
    socket.emit("offers", basePayload);
    socket.emit("services", {
      ...basePayload,
      ...service,
    });
  } catch (error) {
    console.error("[service-rating] realtime emit error", error);
  }
};

const emitReputationUpdatedRealtime = async ({
  changedUserId,
  targetUserIds = [],
  eventAction,
  serviceId,
}: {
  changedUserId: number | null;
  targetUserIds?: number[];
  eventAction: string;
  serviceId: number | null;
}) => {
  try {
    if (!changedUserId || changedUserId <= 0) return;

    const reputationResult = await getUserReputation({
      userIdRaw: changedUserId,
      pageRaw: 1,
      limitRaw: 20,
    });
    if (!(reputationResult as any)?.success) return;

    const recipients = [...new Set(
      [changedUserId, ...(Array.isArray(targetUserIds) ? targetUserIds : [])]
        .map((id) => toPositiveInt(id))
        .filter((id): id is number => Boolean(id))
    )];
    if (!recipients.length) return;

    const payload = {
      action: "updated",
      eventAction,
      userId: changedUserId,
      profileUserId: changedUserId,
      profile_user_id: changedUserId,
      serviceId: serviceId ?? null,
      targetUserIds: recipients,
      target_user_ids: recipients,
      data: (reputationResult as any).data,
      reputation: (reputationResult as any).data,
      updatedAt: new Date().toISOString(),
    };

    emitUserReputationUpdatedRealtime(payload, recipients);

    const summary = buildRealtimeUserReputationSummary((reputationResult as any).data);
    emitUserUpdatedRealtime(
      {
        type: "user_updated",
        action: "updated",
        eventAction,
        userId: changedUserId,
        profileUserId: changedUserId,
        profile_user_id: changedUserId,
        rate: summary.primaryRate,
        rating: summary.primaryRate,
        reviews_count: summary.primaryReviewsCount,
        customer_rate: summary.customerRate,
        customer_reviews_count: summary.customerReviewsCount,
        worker_rate: summary.workerRate,
        worker_reviews_count: summary.workerReviewsCount,
        reputation: (reputationResult as any).data,
        data: (reputationResult as any).data,
        updatedAt: new Date().toISOString(),
      },
      recipients
    );
  } catch (error) {
    console.error("[service-rating] reputation realtime emit error", error);
  }
};

const sendCodedError = (
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, any> = {}
) => {
  const reqAny: any = (res as any)?.req ?? {};
  const userId = Number(reqAny?.userId ?? 0);
  const isAuthenticated =
    Boolean(reqAny?.authenticated) || (Number.isFinite(userId) && userId > 0);

  return res.status(status).json({
    header: {
      success: false,
      authenticated: isAuthenticated,
      messages: [message],
    },
    body: {
      code,
      message,
      ...extra,
    },
  });
};

export const rateWorkerByClient = async (req: Request, res: Response) => {
  try {
    const payload = normalizeRatingPayload(req.body);
    if (!payload) {
      return sendCodedError(
        res,
        400,
        "RATING_INVALID_PAYLOAD",
        "A rating score is required (overall/rating/rate/score/stars) in range 1-5."
      );
    }

    const result = await createClientToWorkerRating({
      serviceIdRaw: (req.params as any)?.serviceId,
      workerIdRaw: (req.params as any)?.workerId,
      reviewerUserIdRaw: (req as any)?.userId,
      payload,
    });

    if (result?.invalid) {
      return sendCodedError(res, 400, "RATING_INVALID_REQUEST", "Invalid serviceId or workerId.");
    }
    if (result?.notFound) {
      return sendCodedError(res, 404, "RATING_SERVICE_NOT_FOUND", "Service not found.");
    }
    if (result?.forbidden) {
      return sendCodedError(
        res,
        403,
        "RATING_FORBIDDEN",
        "Only the service owner can rate the hired worker."
      );
    }
    if (result?.invalidTarget) {
      return sendCodedError(
        res,
        409,
        "RATING_TARGET_INVALID",
        "Worker is not an accepted hire for this service."
      );
    }
    if (result?.duplicate) {
      return sendCodedError(
        res,
        409,
        "RATING_ALREADY_EXISTS",
        "You already rated this worker for this service."
      );
    }

    const serviceId = toPositiveInt((req.params as any)?.serviceId);
    const reviewerUserId = toPositiveInt((req as any)?.userId);
    const revieweeUserId = toPositiveInt(result?.rating?.reviewee_user_id);
    const serviceOwnerId = toPositiveInt(result?.rating?.reviewer_user_id);
    const senderName = toReviewerName(result?.rating?.reviewer);

    if (revieweeUserId && reviewerUserId && serviceId) {
      sendNotification({
        userId: revieweeUserId,
        interactorId: reviewerUserId,
        serviceId,
        type: "admin",
        senderName,
        message: "You received a new rating from your client. You can now rate the client.",
      });
    }

    if (serviceId && serviceOwnerId) {
      const realtimeTargetUserIds = [serviceOwnerId, reviewerUserId ?? 0, revieweeUserId ?? 0].filter(
        (id) => Number.isFinite(id) && id > 0
      ) as number[];

      void emitRatingUpdatedRealtime({
        serviceId,
        ownerUserId: serviceOwnerId,
        targetUserIds: realtimeTargetUserIds,
        eventAction: "client_rated_worker",
        extraFlags: {
          client_rated_worker: true,
          clientRatedWorker: true,
          client_already_rated_worker: true,
          clientAlreadyRatedWorker: true,
          client_can_rate_worker: false,
          clientCanRateWorker: false,
          rating_requested_for_worker: true,
          ratingRequestedForWorker: true,
          worker_can_rate_client: true,
          workerCanRateClient: true,
          worker_rated_client: false,
          workerRatedClient: false,
          worker_can_finalize_service: false,
          workerCanFinalizeService: false,
          worker_pending_close: true,
          workerPendingClose: true,
        },
      });

      void emitReputationUpdatedRealtime({
        changedUserId: revieweeUserId,
        targetUserIds: realtimeTargetUserIds,
        eventAction: "client_rated_worker",
        serviceId,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { rating: result?.rating ?? null },
      message: "Rating submitted successfully.",
    });
  } catch (error: any) {
    return sendCodedError(
      res,
      500,
      "RATING_INTERNAL_ERROR",
      error?.message ?? "Unable to submit rating."
    );
  }
};

export const rateClientByWorker = async (req: Request, res: Response) => {
  try {
    const payload = normalizeRatingPayload(req.body);
    if (!payload) {
      return sendCodedError(
        res,
        400,
        "RATING_INVALID_PAYLOAD",
        "A rating score is required (overall/rating/rate/score/stars) in range 1-5."
      );
    }

    const result = await createWorkerToClientRating({
      serviceIdRaw: (req.params as any)?.serviceId,
      clientUserIdRaw: (req.params as any)?.clientId,
      reviewerUserIdRaw: (req as any)?.userId,
      reviewerWorkerIdRaw: (req as any)?.workerId,
      payload,
    });

    if (result?.invalid) {
      return sendCodedError(res, 400, "RATING_INVALID_REQUEST", "Invalid serviceId or clientId.");
    }
    if (result?.notFound) {
      return sendCodedError(res, 404, "RATING_SERVICE_NOT_FOUND", "Service not found.");
    }
    if (result?.forbidden) {
      return sendCodedError(
        res,
        403,
        "RATING_FORBIDDEN",
        "Only an accepted hired worker can rate the client."
      );
    }
    if (result?.invalidTarget) {
      return sendCodedError(
        res,
        409,
        "RATING_TARGET_INVALID",
        "Client does not match service owner."
      );
    }
    if (result?.ratingNotRequested) {
      return sendCodedError(
        res,
        409,
        "RATING_NOT_REQUESTED",
        "Client must rate worker first before worker can rate client."
      );
    }
    if (result?.duplicate) {
      return sendCodedError(
        res,
        409,
        "RATING_ALREADY_EXISTS",
        "You already rated this client for this service."
      );
    }

    const serviceId = toPositiveInt((req.params as any)?.serviceId);
    const reviewerUserId = toPositiveInt((req as any)?.userId);
    const revieweeUserId = toPositiveInt(result?.rating?.reviewee_user_id);
    const serviceOwnerId = toPositiveInt(result?.rating?.reviewee_user_id);
    const senderName = toReviewerName(result?.rating?.reviewer);

    if (revieweeUserId && reviewerUserId && serviceId) {
      sendNotification({
        userId: revieweeUserId,
        interactorId: reviewerUserId,
        serviceId,
        type: "admin",
        senderName,
        message: "The worker has rated your service.",
      });
    }

    if (serviceId && serviceOwnerId) {
      const realtimeTargetUserIds = [serviceOwnerId, reviewerUserId ?? 0, revieweeUserId ?? 0].filter(
        (id) => Number.isFinite(id) && id > 0
      ) as number[];

      void emitRatingUpdatedRealtime({
        serviceId,
        ownerUserId: serviceOwnerId,
        targetUserIds: realtimeTargetUserIds,
        eventAction: "worker_rated_client",
        extraFlags: {
          client_rated_worker: true,
          clientRatedWorker: true,
          rating_requested_for_worker: true,
          ratingRequestedForWorker: true,
          client_can_rate_worker: false,
          clientCanRateWorker: false,
          worker_rated_client: true,
          workerRatedClient: true,
          worker_can_rate_client: false,
          workerCanRateClient: false,
          worker_can_finalize_service: true,
          workerCanFinalizeService: true,
          worker_pending_close: true,
          workerPendingClose: true,
        },
      });

      void emitReputationUpdatedRealtime({
        changedUserId: revieweeUserId,
        targetUserIds: realtimeTargetUserIds,
        eventAction: "worker_rated_client",
        serviceId,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { rating: result?.rating ?? null },
      message: "Rating submitted successfully.",
    });
  } catch (error: any) {
    return sendCodedError(
      res,
      500,
      "RATING_INTERNAL_ERROR",
      error?.message ?? "Unable to submit rating."
    );
  }
};
