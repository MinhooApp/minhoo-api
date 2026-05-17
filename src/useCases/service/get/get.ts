import { Request, Response, formatResponse, repository } from "../_module/module";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import { isSummaryMode, toServiceSummary } from "../../../libs/summary_response";
import * as followerRepo from "../../../repository/follower/follower_repository";
import { Op } from "sequelize";
import ServiceRating from "../../../_models/service/service_rating";
import Worker from "../../../_models/worker/worker";
import Offer from "../../../_models/offer/offer";
import {
  enrichServiceApplicantsStatus,
  enrichServicesApplicantsStatus,
} from "../../../libs/applicants_status";
import logger from "../../../libs/logger/logger";

type ServiceHistoryDateRange = {
  from?: Date | null;
  to?: Date | null;
};

const normalizeQueryToken = (input: unknown): string => {
  const raw = Array.isArray(input) ? input[0] : input;
  return String(raw ?? "").trim().toLowerCase();
};

const resolveFirstNonEmptyQueryToken = (...inputs: unknown[]): string => {
  for (const input of inputs) {
    const token = normalizeQueryToken(input);
    if (token) return token;
  }
  return "";
};

const parseHistoryYear = (input: unknown): number | null => {
  const raw = normalizeQueryToken(input);
  if (!raw) return null;
  const year = Number(raw);
  if (!Number.isInteger(year)) return null;
  if (year < 1970 || year > 9999) return null;
  return year;
};

const subtractUtcMonths = (base: Date, months: number): Date => {
  const date = new Date(base.getTime());
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

const resolveHistoryDateRange = (
  query: Record<string, unknown> = {}
): ServiceHistoryDateRange => {
  const now = new Date();
  const year = parseHistoryYear(query.year);
  if (year !== null) {
    const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1);
    return { from, to };
  }

  const filter = normalizeQueryToken(
    query.filter ??
      query.date_filter ??
      query.dateFilter ??
      query.history_filter ??
      query.historyFilter ??
      "latest"
  );

  if (filter === "last_30_days") {
    const from = new Date(now.getTime());
    from.setUTCDate(from.getUTCDate() - 30);
    return { from, to: now };
  }

  if (filter === "last_3_months") {
    return { from: subtractUtcMonths(now, 3), to: now };
  }

  if (filter === "last_6_months") {
    return { from: subtractUtcMonths(now, 6), to: now };
  }

  // latest (default): no date restriction, only newest-first sorting.
  return {};
};

function toPlain<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

function toBool(input: unknown, defaultVal = true): boolean {
  if (input === undefined || input === null) return defaultVal;
  const s = String(Array.isArray(input) ? input[0] : input).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultVal;
}

function parsePageAndSize(query: Record<string, unknown> = {}) {
  const pageNum = Math.max(0, Number(query.page ?? 0) || 0);
  const sizeNum = Math.min(Math.max(Number(query.size ?? 15) || 15, 1), 50);
  return { pageNum, sizeNum };
}

function toCount(countValue: unknown): number {
  if (Array.isArray(countValue)) return countValue.length;
  const parsed = Number(countValue ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const resolveWorkerHistoryScopeToken = (query: Record<string, unknown> = {}) => {
  return (
    resolveFirstNonEmptyQueryToken(
      query.scope,
      query.history_scope,
      query.status_scope,
      query.tab,
      query.type,
      query.state,
      query.section,
      query.status
    ) ||
    resolveFirstNonEmptyQueryToken(query.filter) ||
    "all"
  );
};

const resolveWorkerHistoryStatusIds = (
  query: Record<string, unknown> = {}
): number[] | undefined => {
  const scopeCandidate = resolveWorkerHistoryScopeToken(query);

  // Date filters are handled separately. Don't interpret as scope.
  if (
    ["latest", "last_30_days", "last_3_months", "last_6_months"].includes(scopeCandidate)
  ) {
    return undefined;
  }

  if (!scopeCandidate || scopeCandidate === "all") return undefined;
  if (scopeCandidate === "in_progress" || scopeCandidate === "in-progress") return [1, 4];
  if (scopeCandidate === "assigned") return [2];
  if (scopeCandidate === "working") return [3];
  if (scopeCandidate === "completed") return [4];
  if (scopeCandidate === "closed") return undefined;
  if (scopeCandidate === "canceled" || scopeCandidate === "cancelled") return [5];

  const numeric = Number(scopeCandidate);
  if (Number.isInteger(numeric) && numeric > 0) return [numeric];

  // unknown scope -> keep backward-compatible all-history behavior
  return undefined;
};

function ensureCurrencyOnService(svc: any) {
  if (!svc) return svc;

  const code = svc.currencyCode ?? svc.currency_code;
  const prefix = svc.currencyPrefix ?? svc.currency_prefix;

  if (!code) {
    svc.currencyCode = "AUD";
    svc.currency_code = "AUD";
  } else {
    svc.currencyCode = code;
    svc.currency_code = code;
  }

  if (!prefix) {
    svc.currencyPrefix = "AU$";
    svc.currency_prefix = "AU$";
  } else {
    svc.currencyPrefix = prefix;
    svc.currency_prefix = prefix;
  }

  return svc;
}

function ensureCurrencyOnList(list: any[]) {
  if (!Array.isArray(list)) return list;
  return list.map(ensureCurrencyOnService);
}

function mirrorUsername(target: any, source: any) {
  if (!target || !source) return target;

  const username =
    source.username ??
    source.user_name ??
    target.username ??
    target.user_name ??
    null;

  if (!username) return target;

  target.username = username;
  target.user_name = username;
  return target;
}

function normalizeApplicantUsernamesOnService(service: any) {
  if (!service || typeof service !== "object") return service;

  if (service.client) {
    mirrorUsername(service.client, service.client);
  }

  if (Array.isArray(service.offers)) {
    service.offers = service.offers.map((offer: any) => {
      if (offer?.offerer && offer?.offerer?.personal_data) {
        mirrorUsername(offer.offerer, offer.offerer.personal_data);
      }
      return offer;
    });
  }

  if (Array.isArray(service.workers)) {
    service.workers = service.workers.map((worker: any) => {
      if (worker?.personal_data) {
        mirrorUsername(worker, worker.personal_data);
      }
      return worker;
    });
  }

  return service;
}

function normalizeApplicantUsernamesOnList(list: any[]) {
  if (!Array.isArray(list)) return list;
  return list.map(normalizeApplicantUsernamesOnService);
}

const collectServiceRelationshipUserIds = (servicesRaw: any[]): number[] =>
  Array.from(
    new Set(
      (Array.isArray(servicesRaw) ? servicesRaw : [])
        .flatMap((service: any) => [
          Number(service?.client?.id ?? service?.userId),
          Number(service?.workers?.[0]?.personal_data?.id),
          Number(service?.offers?.[0]?.offerer?.personal_data?.id),
        ])
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

const attachRelationshipAliases = (target: any, relationshipRaw: any) => {
  if (!target) return;
  const isFollowing = Boolean(relationshipRaw?.isFollowing);
  const isFollowedBy = Boolean(relationshipRaw?.isFollowedBy);
  const isMutual = isFollowing && isFollowedBy;
  const fields = {
    relationship: { isFollowing, isFollowedBy, isMutual },
    isFollowing,
    is_following: isFollowing,
    viewerFollowsUser: isFollowing,
    viewer_follows_user: isFollowing,
    isFollowedBy,
    is_followed_by: isFollowedBy,
    userFollowsViewer: isFollowedBy,
    user_follows_viewer: isFollowedBy,
    isMutual,
    is_mutual: isMutual,
  };

  if (typeof target.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      target.setDataValue(key, value);
    });
    return;
  }

  Object.assign(target, fields);
};

const attachRelationshipsToServices = async (viewerIdRaw: any, servicesRaw: any[]) => {
  const relationshipByUserId = await followerRepo.getRelationshipMap(
    viewerIdRaw,
    collectServiceRelationshipUserIds(servicesRaw)
  );

  (Array.isArray(servicesRaw) ? servicesRaw : []).forEach((service: any) => {
    const client =
      service?.client ??
      service?.dataValues?.client ??
      (typeof service?.get === "function" ? service.get("client") : null);
    const workers =
      service?.workers ??
      service?.dataValues?.workers ??
      (typeof service?.get === "function" ? service.get("workers") : []);
    const offers =
      service?.offers ??
      service?.dataValues?.offers ??
      (typeof service?.get === "function" ? service.get("offers") : []);

    const clientId = Number(client?.id ?? service?.userId);
    const clientRelationship =
      relationshipByUserId[clientId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(client, clientRelationship);

    const workerUser = workers?.[0]?.personal_data;
    const workerId = Number(workerUser?.id);
    const workerRelationship =
      relationshipByUserId[workerId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(workerUser, workerRelationship);

    const offerUser = offers?.[0]?.offerer?.personal_data;
    const offerUserId = Number(offerUser?.id);
    const offerRelationship =
      relationshipByUserId[offerUserId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(offerUser, offerRelationship);
  });

  return relationshipByUserId;
};

/**
 * ✅ Orden “más nuevo primero” para cualquier lista de servicios.
 * Intenta con varios campos comunes. Si no existen, cae a id DESC.
 */
function sortNewestFirst(list: any[]) {
  if (!Array.isArray(list)) return list;

  const pickDate = (x: any): number => {
    const raw =
      x?.service_date ??
      x?.serviceDate ??
      x?.createdAt ??
      x?.created_at ??
      x?.date ??
      x?.updatedAt ??
      x?.updated_at;

    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isNaN(t)) return t;

    // fallback final: por id
    const id = Number(x?.id ?? 0);
    return Number.isFinite(id) ? id : 0;
  };

  return [...list].sort((a, b) => pickDate(b) - pickDate(a));
}

const pickServiceChronologicalTs = (serviceRaw: any): number => {
  const raw =
    serviceRaw?.service_date ??
    serviceRaw?.serviceDate ??
    serviceRaw?.createdAt ??
    serviceRaw?.created_at ??
    serviceRaw?.updatedAt ??
    serviceRaw?.updated_at ??
    serviceRaw?.closed_at ??
    serviceRaw?.closedAt;
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isNaN(t)) return t;
  const id = Number(serviceRaw?.id ?? 0);
  return Number.isFinite(id) ? id : 0;
};

const pickWorkerClosedAtTs = (serviceRaw: any): number => {
  const offers = Array.isArray(serviceRaw?.offers) ? serviceRaw.offers : [];
  for (const offer of offers) {
    const raw = offer?.workerClosedAt ?? offer?.worker_closed_at;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return 0;
};

const toServiceStatusId = (serviceRaw: any): number => {
  const statusId = Number(
    serviceRaw?.status_id ?? serviceRaw?.statusId ?? serviceRaw?.status?.id ?? 0
  );
  return Number.isFinite(statusId) ? Math.trunc(statusId) : 0;
};

const toServiceAcceptedCount = (serviceRaw: any): number => {
  const acceptedCount = Number(
    serviceRaw?.accepted_count ?? serviceRaw?.acceptedCount ?? 0
  );
  if (!Number.isFinite(acceptedCount) || acceptedCount < 0) return 0;
  return Math.floor(acceptedCount);
};

const toFlag = (value: any): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const token = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!token) return false;
  if (["1", "true", "yes", "y", "on"].includes(token)) return true;
  return false;
};

const toServiceBucket = (serviceRaw: any): string => {
  return String(serviceRaw?.client_bucket ?? serviceRaw?.clientBucket ?? "")
    .trim()
    .toLowerCase();
};

const hasManualClosedAt = (serviceRaw: any): boolean => {
  const value = serviceRaw?.manual_closed_at ?? serviceRaw?.manualClosedAt;
  return Boolean(value && String(value).trim().length > 0);
};

const isWorkerManualFlowInProgress = (serviceRaw: any): boolean => {
  return (
    toServiceStatusId(serviceRaw) === 4 &&
    toServiceBucket(serviceRaw) === "in_progress" &&
    !hasManualClosedAt(serviceRaw) &&
    toServiceAcceptedCount(serviceRaw) > 0
  );
};

const toPositiveId = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const resolveWorkerIdsForUser = async (
  workerUserIdRaw: any,
  workerIdRaw: any
): Promise<number[]> => {
  const ids = new Set<number>();

  const directWorkerId = toPositiveId(workerIdRaw);
  if (directWorkerId) ids.add(directWorkerId);

  const workerUserId = toPositiveId(workerUserIdRaw);
  if (!workerUserId) return [...ids];

  try {
    const rows = (await Worker.findAll({
      where: { userId: workerUserId },
      attributes: ["id"],
      raw: true,
    })) as any[];

    for (const row of rows) {
      const workerId = toPositiveId((row as any)?.id);
      if (workerId) ids.add(workerId);
    }
  } catch (error) {
    console.log("[historyWorkers] Failed to resolve worker ids", error);
  }

  return [...ids];
};

const attachWorkerClientRatingState = async (
  servicesRaw: any[],
  workerUserIdRaw: any,
  workerIdRaw: any
) => {
  if (!Array.isArray(servicesRaw) || !servicesRaw.length) return;

  const workerUserId = toPositiveId(workerUserIdRaw);
  const workerId = toPositiveId(workerIdRaw);
  const serviceIds = Array.from(
    new Set(
      servicesRaw
        .map((service) => toPositiveId(service?.id))
        .filter((serviceId): serviceId is number => Boolean(serviceId))
    )
  );
  if (!serviceIds.length) return;

  let ratedServiceIds = new Set<number>();
  let workerRatedClientServiceIds = new Set<number>();
  let workerIds: number[] = [];
  try {
    workerIds = workerUserId
      ? await resolveWorkerIdsForUser(workerUserId, workerIdRaw)
      : [];
  } catch (error) {
    console.log("[historyWorkers] Failed to resolve worker ids", error);
  }
  const workerIdSet = new Set<number>(workerIds);
  const workerFinalizedServiceIds = new Set<number>();

  // Source of truth: read worker closure directly from offers table.
  // This avoids edge cases where embedded offer payload omits stale fields.
  if (serviceIds.length && workerIds.length) {
    try {
      const workerClosedOffers = (await Offer.findAll({
        where: {
          serviceId: { [Op.in]: serviceIds },
          workerId: { [Op.in]: workerIds },
          accepted: true,
          canceled: false,
          removed: false,
          workerClosedAt: { [Op.ne]: null },
        },
        attributes: ["serviceId"],
        raw: true,
      })) as any[];

      for (const row of workerClosedOffers) {
        const serviceId = toPositiveId((row as any)?.serviceId);
        if (serviceId) workerFinalizedServiceIds.add(serviceId);
      }
    } catch (error) {
      console.log("[historyWorkers] Failed to load worker finalized gates", error);
    }
  } else {
    // Fallback using embedded offer payload when worker ids are not resolved.
    for (const serviceRaw of servicesRaw) {
      const serviceId = toPositiveId(serviceRaw?.id);
      if (!serviceId) continue;

      const offers = Array.isArray((serviceRaw as any)?.offers)
        ? (serviceRaw as any).offers
        : [];
      const workerOffer = offers.find((offer: any) => {
        const offerWorkerId = toPositiveId(offer?.workerId ?? offer?.worker_id);
        if (!offerWorkerId) return false;
        if (!workerIdSet.size) return false;
        return workerIdSet.has(offerWorkerId);
      });

      const workerClosedAt =
        workerOffer?.workerClosedAt ?? workerOffer?.worker_closed_at ?? null;
      if (workerClosedAt) {
        workerFinalizedServiceIds.add(serviceId);
      }
    }
  }

  if (workerUserId) {
    try {
      const where: Record<string, any> = {
        serviceId: { [Op.in]: serviceIds },
        revieweeRole: "worker",
        revieweeUserId: workerUserId,
      };
      if (workerIds.length > 0) {
        (where as any)[Op.or] = [
          { revieweeWorkerId: { [Op.in]: workerIds } },
          { revieweeWorkerId: null },
        ];
      }

      const ratingsRaw = (await ServiceRating.findAll({
        where,
        attributes: ["serviceId"],
        raw: true,
      })) as any[];

      ratedServiceIds = new Set(
        ratingsRaw
          .map((rating) => toPositiveId(rating?.serviceId))
          .filter((serviceId): serviceId is number => Boolean(serviceId))
      );

      const workerRatedWhere: Record<string, any> = {
        serviceId: { [Op.in]: serviceIds },
        reviewerUserId: workerUserId,
        revieweeRole: "client",
      };
      if (workerIds.length > 0) {
        (workerRatedWhere as any)[Op.or] = [
          { reviewerWorkerId: { [Op.in]: workerIds } },
          { reviewerWorkerId: null },
        ];
      }

      const workerRatingsRaw = (await ServiceRating.findAll({
        where: workerRatedWhere,
        attributes: ["serviceId"],
        raw: true,
      })) as any[];

      workerRatedClientServiceIds = new Set(
        workerRatingsRaw
          .map((rating) => toPositiveId(rating?.serviceId))
          .filter((serviceId): serviceId is number => Boolean(serviceId))
      );
    } catch (error) {
      console.log("[historyWorkers] Failed to load worker rating gates", error);
    }
  }

  for (const serviceRaw of servicesRaw) {
    if (!serviceRaw || typeof serviceRaw !== "object") continue;
    const serviceOwnerId = toPositiveId(serviceRaw?.userId ?? serviceRaw?.client?.id);
    if (workerUserId && serviceOwnerId === workerUserId) {
      // Do not apply worker-only gating when the viewer is the service owner.
      continue;
    }
    const serviceId = toPositiveId(serviceRaw.id);
    const clientRatedWorker = Boolean(serviceId && ratedServiceIds.has(serviceId));
    const workerRatedClient = Boolean(
      serviceId && workerRatedClientServiceIds.has(serviceId)
    );
    const workerFinalizedService = Boolean(
      serviceId && workerFinalizedServiceIds.has(serviceId)
    );
    (serviceRaw as any).client_rated_worker = clientRatedWorker;
    (serviceRaw as any).clientRatedWorker = clientRatedWorker;
    (serviceRaw as any).rating_requested_for_worker = clientRatedWorker;
    (serviceRaw as any).ratingRequestedForWorker = clientRatedWorker;
    const workerCanRateClient = clientRatedWorker && !workerRatedClient;
    (serviceRaw as any).worker_can_rate_client = workerCanRateClient;
    (serviceRaw as any).workerCanRateClient = workerCanRateClient;
    (serviceRaw as any).worker_rated_client = workerRatedClient;
    (serviceRaw as any).workerRatedClient = workerRatedClient;
    (serviceRaw as any).worker_finalized_service = workerFinalizedService;
    (serviceRaw as any).workerFinalizedService = workerFinalizedService;

    if (isWorkerManualFlowInProgress(serviceRaw)) {
      // Keep card in-progress, but only enable "rate client" once client already rated worker.
      (serviceRaw as any).manual_close_required = clientRatedWorker;
      (serviceRaw as any).manualCloseRequired = clientRatedWorker;
    }

    // Worker can close their own side once client already rated worker.
    // This is independent from client manual close.
    const statusId = toServiceStatusId(serviceRaw);
    const isCanceled = statusId === 5;
    if (
      !isCanceled &&
      clientRatedWorker &&
      toServiceAcceptedCount(serviceRaw) > 0 &&
      !workerFinalizedService
    ) {
      (serviceRaw as any).manual_close_required = true;
      (serviceRaw as any).manualCloseRequired = true;
      (serviceRaw as any).client_bucket = "in_progress";
      (serviceRaw as any).clientBucket = "in_progress";
      (serviceRaw as any).worker_pending_close = true;
      (serviceRaw as any).workerPendingClose = true;
      const workerCanFinalize = clientRatedWorker && workerRatedClient;
      (serviceRaw as any).worker_can_finalize_service = workerCanFinalize;
      (serviceRaw as any).workerCanFinalizeService = workerCanFinalize;
    } else {
      (serviceRaw as any).worker_pending_close = false;
      (serviceRaw as any).workerPendingClose = false;
      (serviceRaw as any).worker_can_finalize_service = false;
      (serviceRaw as any).workerCanFinalizeService = false;
    }
  }
};

const reconcileWorkerRatingFlags = (servicesRaw: any[]) => {
  if (!Array.isArray(servicesRaw) || !servicesRaw.length) return;

  for (const serviceRaw of servicesRaw) {
    if (!serviceRaw || typeof serviceRaw !== "object") continue;
    const clientRatedWorker = Boolean(
      (serviceRaw as any).client_rated_worker ?? (serviceRaw as any).clientRatedWorker
    );
    const workerRatedClient = Boolean(
      (serviceRaw as any).worker_rated_client ?? (serviceRaw as any).workerRatedClient
    );
    const workerCanRateClient = clientRatedWorker && !workerRatedClient;

    (serviceRaw as any).worker_can_rate_client = workerCanRateClient;
    (serviceRaw as any).workerCanRateClient = workerCanRateClient;
  }
};

const attachClientOwnerRatingState = async (
  servicesRaw: any[],
  viewerUserIdRaw: any
) => {
  if (!Array.isArray(servicesRaw) || !servicesRaw.length) return;

  const viewerUserId = toPositiveId(viewerUserIdRaw);
  if (!viewerUserId) return;

  // Fast-path for worker/history views: if the viewer does not own any service
  // in this payload, there is no client-side rating state to compute.
  const hasOwnedServiceInPayload = servicesRaw.some((serviceRaw: any) => {
    const serviceOwnerId = toPositiveId(serviceRaw?.userId ?? serviceRaw?.client?.id);
    return Boolean(serviceOwnerId && serviceOwnerId === viewerUserId);
  });
  if (!hasOwnedServiceInPayload) return;

  const serviceIds = Array.from(
    new Set(
      servicesRaw
        .map((service) => toPositiveId(service?.id))
        .filter((serviceId): serviceId is number => Boolean(serviceId))
    )
  );
  if (!serviceIds.length) return;

  type RatedWorkersByService = {
    workerIds: Set<number>;
    workerUserIds: Set<number>;
  };

  const ratedWorkersByService = new Map<number, RatedWorkersByService>();
  try {
    const ratingsRaw = (await ServiceRating.findAll({
      where: {
        serviceId: { [Op.in]: serviceIds },
        reviewerUserId: viewerUserId,
        revieweeRole: "worker",
      },
      attributes: ["serviceId", "revieweeWorkerId", "revieweeUserId"],
      raw: true,
    })) as any[];

    for (const rating of ratingsRaw) {
      const serviceId = toPositiveId(rating?.serviceId);
      if (!serviceId) continue;

      const current = ratedWorkersByService.get(serviceId) ?? {
        workerIds: new Set<number>(),
        workerUserIds: new Set<number>(),
      };

      const revieweeWorkerId = toPositiveId(rating?.revieweeWorkerId);
      if (revieweeWorkerId) current.workerIds.add(revieweeWorkerId);

      const revieweeUserId = toPositiveId(rating?.revieweeUserId);
      if (revieweeUserId) current.workerUserIds.add(revieweeUserId);

      ratedWorkersByService.set(serviceId, current);
    }
  } catch (error) {
    console.log("[clientHistory] Failed to load client rating gates", error);
  }

  for (const serviceRaw of servicesRaw) {
    if (!serviceRaw || typeof serviceRaw !== "object") continue;
    const serviceOwnerId = toPositiveId(serviceRaw?.userId ?? serviceRaw?.client?.id);
    if (!serviceOwnerId || serviceOwnerId !== viewerUserId) continue;

    const serviceId = toPositiveId(serviceRaw?.id);
    const ratedForService = serviceId ? ratedWorkersByService.get(serviceId) : undefined;
    const ratedWorkerIds = ratedForService?.workerIds ?? new Set<number>();
    const ratedWorkerUserIds = ratedForService?.workerUserIds ?? new Set<number>();

    const offers = Array.isArray((serviceRaw as any)?.offers)
      ? ((serviceRaw as any).offers as any[])
      : [];

    const activeHireWorkerIds = new Set<number>();
    let activeHireCount = 0;
    let ratedActiveHireCount = 0;

    for (const offerRaw of offers) {
      const offer = offerRaw ?? {};
      const accepted = toFlag(offer?.accepted);
      const canceled = toFlag(offer?.canceled);
      const removed = toFlag(offer?.removed);

      const workerId = toPositiveId(offer?.workerId ?? offer?.worker_id ?? offer?.offerer?.id);
      const workerUserId = toPositiveId(
        offer?.offerer?.userId ??
          offer?.offerer?.user_id ??
          offer?.offerer?.personal_data?.id ??
          offer?.offerer?.personal_data?.userId ??
          offer?.offerer?.personal_data?.user_id
      );

      const ratedByClient = Boolean(
        (workerId && ratedWorkerIds.has(workerId)) ||
          (workerUserId && ratedWorkerUserIds.has(workerUserId))
      );

      const offerIsActiveForClient = accepted && !canceled && !removed;
      const workerCanceledOffer = !accepted && canceled && !removed;
      const clientRemovedOffer = removed && !canceled;
      const clientInteractionEnabled = offerIsActiveForClient;
      const clientCardDisabled = !clientInteractionEnabled;
      const clientDisableReason = workerCanceledOffer
        ? "worker_canceled"
        : clientRemovedOffer
        ? "client_removed"
        : canceled
        ? "canceled"
        : removed
        ? "removed"
        : "inactive";

      offer.rated_by_client = ratedByClient;
      offer.ratedByClient = ratedByClient;
      offer.client_can_rate = offerIsActiveForClient && !ratedByClient;
      offer.clientCanRate = offerIsActiveForClient && !ratedByClient;
      offer.client_can_open = clientInteractionEnabled;
      offer.clientCanOpen = clientInteractionEnabled;
      offer.client_interaction_enabled = clientInteractionEnabled;
      offer.clientInteractionEnabled = clientInteractionEnabled;
      offer.client_card_disabled = clientCardDisabled;
      offer.clientCardDisabled = clientCardDisabled;
      offer.client_disable_reason = clientDisableReason;
      offer.clientDisableReason = clientDisableReason;
      offer.worker_canceled = workerCanceledOffer;
      offer.workerCanceled = workerCanceledOffer;

      if (!(accepted && !canceled && !removed)) continue;
      if (!workerId || activeHireWorkerIds.has(workerId)) continue;

      activeHireWorkerIds.add(workerId);
      activeHireCount += 1;
      if (ratedByClient) ratedActiveHireCount += 1;
    }

    const allActiveHiresRated =
      activeHireCount > 0 && ratedActiveHireCount === activeHireCount;
    const clientAlreadyRatedWorker = allActiveHiresRated;
    const acceptedCount = toServiceAcceptedCount(serviceRaw);
    const statusId = toServiceStatusId(serviceRaw);
    const bucket = toServiceBucket(serviceRaw);

    (serviceRaw as any).client_rated_worker = clientAlreadyRatedWorker;
    (serviceRaw as any).clientRatedWorker = clientAlreadyRatedWorker;
    (serviceRaw as any).client_already_rated_worker = clientAlreadyRatedWorker;
    (serviceRaw as any).clientAlreadyRatedWorker = clientAlreadyRatedWorker;
    (serviceRaw as any).all_active_hires_rated = allActiveHiresRated;
    (serviceRaw as any).allActiveHiresRated = allActiveHiresRated;
    (serviceRaw as any).all_required_ratings_done = allActiveHiresRated;
    (serviceRaw as any).allRequiredRatingsDone = allActiveHiresRated;
    const clientCanRateWorker = activeHireCount > 0 && !clientAlreadyRatedWorker;
    (serviceRaw as any).client_can_rate_worker = clientCanRateWorker;
    (serviceRaw as any).clientCanRateWorker = clientCanRateWorker;

    // If client already rated and the service is still active with assigned worker,
    // keep "Finalize" available across app restarts even before manual close happens.
    const isCanceled = statusId === 5;
    const isManuallyClosed = hasManualClosedAt(serviceRaw);
    const canKeepFinalizeOn =
      clientAlreadyRatedWorker &&
      !isCanceled &&
      !isManuallyClosed &&
      acceptedCount > 0;

    if (canKeepFinalizeOn) {
      (serviceRaw as any).manual_close_required = true;
      (serviceRaw as any).manualCloseRequired = true;
      if (bucket === "searching") {
        (serviceRaw as any).client_bucket = "in_progress";
        (serviceRaw as any).clientBucket = "in_progress";
      }
    }
  }
};

const isWorkerInProgressService = (serviceRaw: any): boolean => {
  const workerFinalizedService = Boolean(
    (serviceRaw as any)?.worker_finalized_service ??
      (serviceRaw as any)?.workerFinalizedService
  );
  if (workerFinalizedService) return false;

  if (Boolean((serviceRaw as any)?.worker_pending_close ?? (serviceRaw as any)?.workerPendingClose)) {
    return true;
  }

  const statusId = toServiceStatusId(serviceRaw);
  if (statusId === 1) {
    return toServiceAcceptedCount(serviceRaw) > 0;
  }

  if (statusId === 4) {
    const workerRatedClient = Boolean(
      (serviceRaw as any)?.worker_rated_client ?? (serviceRaw as any)?.workerRatedClient
    );
    if (workerRatedClient) return false;
  }

  return isWorkerManualFlowInProgress(serviceRaw);
};

const isWorkerClosedService = (serviceRaw: any): boolean => {
  if (Boolean((serviceRaw as any)?.worker_pending_close ?? (serviceRaw as any)?.workerPendingClose)) {
    return false;
  }

  const workerFinalizedService = Boolean(
    (serviceRaw as any)?.worker_finalized_service ??
      (serviceRaw as any)?.workerFinalizedService
  );
  if (!workerFinalizedService) return false;

  return (
    toServiceStatusId(serviceRaw) !== 5 &&
    toServiceAcceptedCount(serviceRaw) > 0
  );
};

const isWorkerCanceledService = (serviceRaw: any): boolean => {
  return toServiceStatusId(serviceRaw) === 5;
};

const collapseWorkerPendingCloseBacklog = (
  servicesRaw: any[],
  allServicesRaw: any[] = servicesRaw
): any[] => {
  if (!Array.isArray(servicesRaw) || servicesRaw.length <= 1) return servicesRaw;

  const result: any[] = [];
  const seenPendingByOwner = new Set<number>();
  const latestWorkerFinalizedByOwner = new Map<number, number>();

  if (Array.isArray(allServicesRaw) && allServicesRaw.length) {
    for (const serviceRaw of allServicesRaw) {
      if (!serviceRaw || typeof serviceRaw !== "object") continue;
      const ownerUserId = toPositiveId(
        (serviceRaw as any).userId ?? (serviceRaw as any)?.client?.id
      );
      if (!ownerUserId) continue;

      const workerFinalizedService = Boolean(
        (serviceRaw as any)?.worker_finalized_service ??
          (serviceRaw as any)?.workerFinalizedService
      );
      if (!workerFinalizedService) continue;

      const ts = pickServiceChronologicalTs(serviceRaw);
      const prev = latestWorkerFinalizedByOwner.get(ownerUserId) ?? 0;
      if (ts > prev) latestWorkerFinalizedByOwner.set(ownerUserId, ts);
    }
  }

  for (const serviceRaw of servicesRaw) {
    if (!serviceRaw || typeof serviceRaw !== "object") continue;

    const isPending = Boolean(
      (serviceRaw as any).worker_pending_close ?? (serviceRaw as any).workerPendingClose
    );
    if (!isPending) {
      result.push(serviceRaw);
      continue;
    }

    const ownerUserId = toPositiveId(
      (serviceRaw as any).userId ?? (serviceRaw as any)?.client?.id
    );
    if (!ownerUserId) {
      result.push(serviceRaw);
      continue;
    }

    const pendingTs = pickServiceChronologicalTs(serviceRaw);
    const latestFinalizedTs = latestWorkerFinalizedByOwner.get(ownerUserId) ?? 0;
    // Hide stale pending-close backlog for an owner once a newer service from that
    // same owner has already been worker-finalized.
    if (latestFinalizedTs > 0 && latestFinalizedTs >= pendingTs) {
      continue;
    }

    // Keep only the newest pending-close card per client owner in onGoing/worker
    // to avoid surfacing a large historical backlog.
    if (seenPendingByOwner.has(ownerUserId)) continue;
    seenPendingByOwner.add(ownerUserId);
    result.push(serviceRaw);
  }

  return result;
};

export const gets = async (req: Request, res: Response) => {
  try {
    const summary = isSummaryMode((req.query as any)?.summary);
    const size = Math.min(Math.max(Number((req.query as any)?.size) || 20, 1), 20);
    const servicesRaw = summary ? await repository.getsSummary(size) : await repository.gets();
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);
    const relationshipByUserId = await attachRelationshipsToServices(req.userId, services);

    if (summary) {
      services = services.map((service: any) =>
        toServiceSummary(service, req.userId, relationshipByUserId)
      );
    }

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myonGoing = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.onGoing(req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    logger.error({ event: "error", error: error.toString() });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoing = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.onGoing(req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    logger.error({ event: "error", error: error.toString() });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const getsOnGoing = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const summary = isSummaryMode((req.query as any)?.summary);
    const servicesRaw = await (summary
      ? repository.getsOnGoingSummary
      : repository.getsOnGoing)(pageNum, sizeNum, req.userId);

    // ✅ findAndCountAll -> {count, rows}
    const safe = toPlain(servicesRaw) as any;

    let rows = ensureCurrencyOnList(safe.rows ?? []);
    rows = normalizeApplicantUsernamesOnList(rows);
    rows = enrichServicesApplicantsStatus(rows);
    rows = sortNewestFirst(rows);
    const relationshipByUserId = await attachRelationshipsToServices(req.userId, rows);
    await attachClientOwnerRatingState(rows, req.userId);
    const responseRows = summary
      ? rows.map((service: any) =>
          toServiceSummary(service, req.userId, relationshipByUserId)
        )
      : rows;

    const payload = {
      page: pageNum,
      size: sizeNum,
      count: toCount(safe.count),
      services: responseRows,
    };

    setCacheControl(res, {
      visibility: req.userId ? "private" : "public",
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 60,
      staleIfErrorSeconds: 120,
    });
    if (respondNotModifiedIfFresh(req, res, payload)) return;

    return formatResponse({
      res: res,
      success: true,
      body: payload,
    });
  } catch (error: any) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoingWorkers = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const [appliedRaw, finalizedRaw] = await Promise.all([
      repository.onGoingWorkers(req.workerId, req.userId),
      repository.historyWorkers(req.workerId, req.userId, undefined, [4]),
    ]);

    const appliedServices = toPlain(appliedRaw) as any[];
    const finalizedServices = (toPlain(finalizedRaw) as any[]).filter((serviceRaw: any) => {
      if (toServiceStatusId(serviceRaw) !== 4) return false;
      const closedAt = serviceRaw?.closed_at ?? serviceRaw?.closedAt;
      return Boolean(closedAt);
    });

    const byId = new Map<number, any>();
    for (const serviceRaw of [...appliedServices, ...finalizedServices]) {
      const id = toPositiveId((serviceRaw as any)?.id);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, serviceRaw);
    }

    let services = ensureCurrencyOnList([...byId.values()]);

    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);
    await attachWorkerClientRatingState(services, req.userId, req.workerId);
    reconcileWorkerRatingFlags(services);
    services = services.filter(isWorkerInProgressService);
    services = sortNewestFirst(services);
    services = collapseWorkerPendingCloseBacklog(services, [...byId.values()]);

    const totalCount = services.length;
    const start = pageNum * sizeNum;
    const end = start + sizeNum;
    const pagedServices = services.slice(start, end);
    const visibleCount = pagedServices.length;
    const hasMore = end < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        has_more: hasMore,
        services: pagedServices,
      },
    });
  } catch (error: any) {
    logger.error({ event: "error", error: error.toString() });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoingCanceledWorkers = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.onGoingCanceledWorkersPaged(
      req.workerId,
      req.userId,
      pageNum,
      sizeNum,
      historyDateRange
    );
    const safe = toPlain(servicesRaw) as any;
    let services = ensureCurrencyOnList(safe.rows ?? []);
    const totalCount = toCount(safe.count);

    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    await attachRelationshipsToServices(req.userId, services);
    const visibleCount = services.length;
    const hasMore = (pageNum + 1) * sizeNum < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        has_more: hasMore,
        services,
      },
    });
  } catch (error: any) {
    logger.error({ event: "error", error: error.toString() });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const historyWorkers = async (req: Request, res: Response) => {
  try {
    const scopeToken = resolveWorkerHistoryScopeToken(
      req.query as Record<string, unknown>
    );
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const workerHistoryStatusIds = resolveWorkerHistoryStatusIds(
      req.query as Record<string, unknown>
    );
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const servicesRaw = await repository.historyWorkers(
      req.workerId,
      req.userId,
      historyDateRange,
      workerHistoryStatusIds
    );
    let services = ensureCurrencyOnList(toPlain(servicesRaw) as any[]);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);
    await attachWorkerClientRatingState(services, req.userId, req.workerId);
    reconcileWorkerRatingFlags(services);
    services = sortNewestFirst(services);

    const countAssigned = services.filter(
      (service: any) => toServiceStatusId(service) === 2
    ).length;
    const countWorking = services.filter(
      (service: any) => toServiceStatusId(service) === 3
    ).length;
    const countCompleted = services.filter(
      (service: any) => toServiceStatusId(service) === 4
    ).length;
    const inProgressServices = services.filter(isWorkerInProgressService);
    const inProgressCollapsed = collapseWorkerPendingCloseBacklog(
      inProgressServices,
      services
    );
    const countInProgress = inProgressCollapsed.length;
    const countClosed = services.filter(isWorkerClosedService).length;

    let scopedServices = services;
    if (scopeToken === "in_progress" || scopeToken === "in-progress") {
      scopedServices = inProgressCollapsed;
    } else if (scopeToken === "closed") {
      scopedServices = services.filter(isWorkerClosedService);
      scopedServices = [...scopedServices].sort((a: any, b: any) => {
        const byWorkerClosed = pickWorkerClosedAtTs(b) - pickWorkerClosedAtTs(a);
        if (byWorkerClosed !== 0) return byWorkerClosed;
        return pickServiceChronologicalTs(b) - pickServiceChronologicalTs(a);
      });
    } else if (scopeToken === "canceled" || scopeToken === "cancelled") {
      scopedServices = services.filter(isWorkerCanceledService);
    }

    const totalCount = scopedServices.length;
    const start = pageNum * sizeNum;
    const end = start + sizeNum;
    const pagedServices = scopedServices.slice(start, end);
    const visibleCount = pagedServices.length;
    const hasMore = end < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        count_in_progress: countInProgress,
        count_closed: countClosed,
        count_assigned: countAssigned,
        count_working: countWorking,
        count_completed: countCompleted,
        has_more: hasMore,
        services: pagedServices,
      },
    });
  } catch (error: any) {
    logger.error({ event: "error", error: error.toString() });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const serviceRaw = await repository.get(id);
    let service = toPlain(serviceRaw);

    service = ensureCurrencyOnService(service);
    service = normalizeApplicantUsernamesOnService(service);
    service = enrichServiceApplicantsStatus(service);
    await attachRelationshipsToServices(req.userId, [service].filter(Boolean) as any[]);
    await attachClientOwnerRatingState([service].filter(Boolean) as any[], req.userId);
    await attachWorkerClientRatingState(
      [service].filter(Boolean) as any[],
      req.userId,
      req.workerId
    );
    reconcileWorkerRatingFlags([service].filter(Boolean) as any[]);

    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error: any) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myHistory = async (req: Request, res: Response) => {
  try {
    const { canceled } = req.query as Record<string, unknown>;
    const canceledBool = toBool(canceled, true);
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);

    const servicesRaw = await repository.history(req.userId, canceledBool, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = services.filter((serviceRaw: any) => {
      return toServiceBucket(serviceRaw) !== "in_progress";
    });
    services = sortNewestFirst(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);

    return formatResponse({ res, success: true, body: { services } });
  } catch (error: any) {
    console.error(error);
    return formatResponse({
      res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myHistoryCanceled = async (req: Request, res: Response) => {
  try {
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.historyCanceled(req.userId, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const history = async (req: Request, res: Response) => {
  try {
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.history(undefined, true, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = services.filter((serviceRaw: any) => {
      return toServiceBucket(serviceRaw) !== "in_progress";
    });
    services = sortNewestFirst(services);
    await attachRelationshipsToServices(req.userId, services);
    await attachClientOwnerRatingState(services, req.userId);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};
