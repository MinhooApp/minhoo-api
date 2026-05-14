import {
  socket,
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import {
  attachApplicantsCountAliases,
  enrichServiceApplicantsStatus,
  resolveApplicantsCount,
} from "../../../libs/applicants_status";
import {
  attachServiceRoutingFields,
  toServiceUpdatedSocketPayload,
} from "../../../libs/service_client_bucket";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";

export const update = async (_req: Request, _res: Response) => {};

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

  return {
    service: enrichedService,
    offersCount,
    routing,
  };
};

const emitServiceUpdated = ({
  action,
  ownerUserId,
  service,
  offersCount,
  refreshLists,
}: {
  action: string;
  ownerUserId: number;
  service: any;
  offersCount: number;
  refreshLists: string[];
}) => {
  const socketRoutingPayload = toServiceUpdatedSocketPayload(service);
  const normalizedAction =
    action === "worker_finalize" ||
    action === "move_to_history" ||
    action === "finalize_search"
      ? "finalized"
      : action;

  socket.emit("service.updated", socketRoutingPayload);

  socket.emit("offers", {
    action: normalizedAction,
    eventAction: action,
    serviceId: socketRoutingPayload.id,
    ownerUserId,
    targetUserIds: [ownerUserId],
    target_user_ids: [ownerUserId],
    service,
    offersCount,
    offers_count: offersCount,
    applicantsCount: offersCount,
    applicants_count: offersCount,
    ...socketRoutingPayload,
    refreshLists,
    updatedAt: new Date().toISOString(),
  });

  socket.emit("services", {
    action: normalizedAction,
    eventAction: action,
    ...service,
    offersCount,
    offers_count: offersCount,
    applicantsCount: offersCount,
    applicants_count: offersCount,
    ...socketRoutingPayload,
    refreshLists,
  });

  // backward compatibility
  socket.emit("service/finalized", {
    action: normalizedAction,
    eventAction: action,
    ...socketRoutingPayload,
    offersCount,
    offers_count: offersCount,
    applicantsCount: offersCount,
    applicants_count: offersCount,
    refreshLists,
  });
};

const buildResponseBody = ({
  service,
  offersCount,
  refreshLists,
  extraFlags = {},
}: {
  service: any;
  offersCount: number;
  refreshLists: string[];
  extraFlags?: Record<string, any>;
}) => {
  const routing = attachServiceRoutingFields(service);
  return {
    id: Number(service?.id ?? 0) || null,
    ...routing,
    offersCount,
    offers_count: offersCount,
    applicantsCount: offersCount,
    applicants_count: offersCount,
    refreshLists,
    ...extraFlags,
  };
};

export const finalizeSearch = async (req: Request, res: Response) => {
  const serviceId = Number(req.params?.id);
  try {
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }

    const tempService = await repository.get(serviceId);
    if (!tempService) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }

    const refreshLists = [
      "myonGoing",
      "myHistory",
      "myHistoryCanceled",
      "onGoing/worker",
      "history/worker",
      "worker/canceled",
    ];

    const isOwner = Number((tempService as any).userId) === Number(req.userId);

    if (isOwner) {
      const finalizedResult: any = await repository.finalizeSearchService(serviceId);
      if (finalizedResult?.notFound) {
        return formatResponse({
          res,
          success: false,
          message: "Service not found.",
          code: 404,
        });
      }
      if (finalizedResult?.invalidServiceId) {
        return formatResponse({
          res,
          success: false,
          message: "Invalid service id.",
          code: 400,
        });
      }
      if (finalizedResult?.canceledService) {
        return formatResponse({
          res,
          success: false,
          message: "Canceled services cannot be finalized.",
          code: 409,
        });
      }

      const { service, offersCount } = normalizeServiceForRealtime(
        finalizedResult?.service ?? tempService
      );

      emitServiceUpdated({
        action: "finalize_search",
        ownerUserId: Number(tempService?.userId ?? service?.userId ?? 0),
        service,
        offersCount,
        refreshLists,
      });

      await bumpHomeContentSectionVersion("services");

      return formatResponse({
        res,
        success: true,
        body: buildResponseBody({ service, offersCount, refreshLists }),
      });
    }

    const workerFinalizeResult: any = await repository.finalizeServiceForWorker(
      serviceId,
      req.workerId,
      req.userId
    );
    if (workerFinalizeResult?.notFound) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }
    if (workerFinalizeResult?.invalidServiceId) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }
    if (workerFinalizeResult?.invalidStatus) {
      return formatResponse({
        res,
        success: false,
        message: workerFinalizeResult?.canceledService
          ? "Canceled services cannot be finalized."
          : "Service cannot be finalized by worker in current state.",
        code: 409,
      });
    }
    if (workerFinalizeResult?.clientNotClosedYet) {
      return formatResponse({
        res,
        success: false,
        message: "Client must finalize service first.",
        code: 409,
      });
    }
    if (workerFinalizeResult?.ratingRequired) {
      return formatResponse({
        res,
        success: false,
        message: "Worker must rate client before finalizing.",
        code: 409,
      });
    }
    if (workerFinalizeResult?.workerUnauthorized || workerFinalizeResult?.workerNotAssigned) {
      return formatResponse({
        res,
        success: false,
        message: "Forbidden. Worker is not assigned to this service.",
        code: 403,
      });
    }

    const { service, offersCount } = normalizeServiceForRealtime(
      workerFinalizeResult?.service ?? tempService
    );
    Object.assign(service, {
      worker_finalized_service: true,
      workerFinalizedService: true,
      worker_pending_close: false,
      workerPendingClose: false,
      worker_can_finalize_service: false,
      workerCanFinalizeService: false,
      worker_rated_client: true,
      workerRatedClient: true,
      worker_can_rate_client: false,
      workerCanRateClient: false,
    });

    emitServiceUpdated({
      action: "worker_finalize",
      ownerUserId: Number(tempService?.userId ?? service?.userId ?? 0),
      service,
      offersCount,
      refreshLists,
    });

    await bumpHomeContentSectionVersion("services");

    return formatResponse({
      res,
      success: true,
      body: buildResponseBody({
        service,
        offersCount,
        refreshLists,
        extraFlags: {
          worker_finalized_service: true,
          workerFinalizedService: true,
          worker_pending_close: false,
          workerPendingClose: false,
          worker_can_finalize_service: false,
          workerCanFinalizeService: false,
          worker_rated_client: true,
          workerRatedClient: true,
          worker_can_rate_client: false,
          workerCanRateClient: false,
        },
      }),
    });
  } catch (error) {
    console.log(error);
    return formatResponse({
      res,
      success: false,
      message: error,
      code: 400,
    });
  }
};

export const moveToHistory = async (req: Request, res: Response) => {
  const serviceId = Number(req.params?.id);
  try {
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }

    const tempService = await repository.get(serviceId);
    if (!tempService) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }

    const isOwner = Number((tempService as any).userId) === Number(req.userId);

    const refreshLists = [
      "myonGoing",
      "myHistory",
      "myHistoryCanceled",
      "onGoing/worker",
      "history/worker",
      "worker/canceled",
    ];

    // Backward-compatible worker flow:
    // some front builds still use /move-to-history for worker finalize.
    if (!isOwner) {
      const workerFinalizeResult: any = await repository.finalizeServiceForWorker(
        serviceId,
        req.workerId,
        req.userId
      );
      if (workerFinalizeResult?.notFound) {
        return formatResponse({
          res,
          success: false,
          message: "Service not found.",
          code: 404,
        });
      }
      if (workerFinalizeResult?.invalidServiceId) {
        return formatResponse({
          res,
          success: false,
          message: "Invalid service id.",
          code: 400,
        });
      }
      if (workerFinalizeResult?.invalidStatus) {
        return formatResponse({
          res,
          success: false,
          message: workerFinalizeResult?.canceledService
            ? "Canceled services cannot be finalized."
            : "Service cannot be finalized by worker in current state.",
          code: 409,
        });
      }
      if (workerFinalizeResult?.clientNotClosedYet) {
        return formatResponse({
          res,
          success: false,
          message: "Client must finalize service first.",
          code: 409,
        });
      }
      if (workerFinalizeResult?.ratingRequired) {
        return formatResponse({
          res,
          success: false,
          message: "Worker must rate client before finalizing.",
          code: 409,
        });
      }
      if (workerFinalizeResult?.workerUnauthorized || workerFinalizeResult?.workerNotAssigned) {
        return formatResponse({
          res,
          success: false,
          message: "Forbidden. Worker is not assigned to this service.",
          code: 403,
        });
      }

      const { service, offersCount } = normalizeServiceForRealtime(
        workerFinalizeResult?.service ?? tempService
      );
      Object.assign(service, {
        worker_finalized_service: true,
        workerFinalizedService: true,
        worker_pending_close: false,
        workerPendingClose: false,
        worker_can_finalize_service: false,
        workerCanFinalizeService: false,
        worker_rated_client: true,
        workerRatedClient: true,
        worker_can_rate_client: false,
        workerCanRateClient: false,
      });

      emitServiceUpdated({
        action: "worker_finalize",
        ownerUserId: Number(tempService?.userId ?? service?.userId ?? 0),
        service,
        offersCount,
        refreshLists,
      });

      await bumpHomeContentSectionVersion("services");

      return formatResponse({
        res,
        success: true,
        body: buildResponseBody({
          service,
          offersCount,
          refreshLists,
          extraFlags: {
            worker_finalized_service: true,
            workerFinalizedService: true,
            worker_pending_close: false,
            workerPendingClose: false,
            worker_can_finalize_service: false,
            workerCanFinalizeService: false,
            worker_rated_client: true,
            workerRatedClient: true,
            worker_can_rate_client: false,
            workerCanRateClient: false,
          },
        }),
      });
    }

    const movedResult: any = await repository.moveServiceToHistory(serviceId);
    if (movedResult?.notFound) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }
    if (movedResult?.invalidServiceId) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }
    if (movedResult?.invalidStatus) {
      return formatResponse({
        res,
        success: false,
        message: "Service must be finalized before moving to history.",
        code: 409,
      });
    }

    const { service, offersCount } = normalizeServiceForRealtime(
      movedResult?.service ?? tempService
    );

    emitServiceUpdated({
      action: "move_to_history",
      ownerUserId: Number(tempService?.userId ?? service?.userId ?? 0),
      service,
      offersCount,
      refreshLists,
    });

    await bumpHomeContentSectionVersion("services");

    return formatResponse({
      res,
      success: true,
      body: buildResponseBody({ service, offersCount, refreshLists }),
    });
  } catch (error) {
    console.log(error);
    return formatResponse({
      res,
      success: false,
      message: error,
      code: 400,
    });
  }
};

export const finalized = finalizeSearch;
