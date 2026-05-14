import { Op, UniqueConstraintError } from "sequelize";
import Service from "../../_models/service/service";
import Offer from "../../_models/offer/offer";
import Worker from "../../_models/worker/worker";
import User from "../../_models/user/user";
import ServiceRating from "../../_models/service/service_rating";

export type RatingRole = "worker" | "client";

export type NormalizedRatingPayload = {
  overall: number;
  quality: number;
  communication: number;
  reliability: number;
  comment: string | null;
};

type AcceptedWorkerRef = {
  workerId: number;
  userId: number;
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toNullableTrimmedText = (value: any, maxLength = 1000): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
};

const normalizeRole = (roleRaw: any): RatingRole | null => {
  const normalized = String(roleRaw ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "worker") return "worker";
  if (normalized === "client") return "client";
  return null;
};

const normalizeScore = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
};

export const normalizeRatingPayload = (body: any): NormalizedRatingPayload | null => {
  const overall = normalizeScore(
    body?.overall ?? body?.rating ?? body?.rate ?? body?.score ?? body?.stars
  );
  if (!overall) return null;

  // Backward compatibility: old clients may send only one score.
  const quality = normalizeScore(body?.quality ?? body?.overall_quality ?? overall) ?? overall;
  const communication =
    normalizeScore(body?.communication ?? body?.overall_communication ?? overall) ?? overall;
  const reliability =
    normalizeScore(body?.reliability ?? body?.overall_reliability ?? overall) ?? overall;

  return {
    overall,
    quality,
    communication,
    reliability,
    comment: toNullableTrimmedText(
      body?.comment ?? body?.review ?? body?.message ?? body?.description,
      2000
    ),
  };
};

const extractAcceptedWorkersFromService = (serviceRaw: any): AcceptedWorkerRef[] => {
  const service = serviceRaw ?? {};
  const offers = Array.isArray(service?.offers) ? service.offers : [];

  const seen = new Set<number>();
  const acceptedWorkers: AcceptedWorkerRef[] = [];

  for (const offerRaw of offers) {
    const offer = offerRaw ?? {};
    if (!offer.accepted || offer.canceled || offer.removed) continue;

    const workerId = toPositiveInt(offer?.workerId ?? offer?.offerer?.id);
    const userId = toPositiveInt(offer?.offerer?.userId ?? offer?.offerer?.personal_data?.id);

    if (!workerId || !userId) continue;
    if (seen.has(workerId)) continue;
    seen.add(workerId);
    acceptedWorkers.push({ workerId, userId });
  }

  return acceptedWorkers;
};

const getAcceptedWorkersForService = async (
  serviceId: number,
  transaction?: any
): Promise<AcceptedWorkerRef[]> => {
  const offers = await Offer.findAll({
    where: {
      serviceId,
      accepted: true,
      canceled: false,
      removed: false,
    },
    attributes: ["id", "serviceId", "workerId", "accepted", "canceled", "removed"],
    include: [
      {
        model: Worker,
        as: "offerer",
        attributes: ["id", "userId"],
      },
    ],
    transaction,
  });

  return extractAcceptedWorkersFromService({ offers });
};

const hasClientRatedWorkerForService = async ({
  serviceId,
  clientUserId,
  workerUserId,
  workerId,
  transaction,
}: {
  serviceId: number;
  clientUserId: number;
  workerUserId: number;
  workerId?: number | null;
  transaction?: any;
}) => {
  const where: Record<string, any> = {
    serviceId,
    reviewerUserId: clientUserId,
    revieweeUserId: workerUserId,
    revieweeRole: "worker",
  };

  if (Number.isFinite(Number(workerId)) && Number(workerId) > 0) {
    (where as any).revieweeWorkerId = {
      [Op.or]: [Math.trunc(Number(workerId)), null],
    };
  }

  const existing = await ServiceRating.findOne({
    where,
    attributes: ["id"],
    transaction,
    raw: true,
  });

  return Boolean(toPositiveInt((existing as any)?.id));
};

const serializeRating = (ratingRaw: any) => {
  const rating =
    ratingRaw && typeof ratingRaw.toJSON === "function" ? ratingRaw.toJSON() : ratingRaw ?? {};

  return {
    id: toPositiveInt(rating?.id),
    service_id: toPositiveInt(rating?.serviceId),
    serviceId: toPositiveInt(rating?.serviceId),
    reviewer_user_id: toPositiveInt(rating?.reviewerUserId),
    reviewerUserId: toPositiveInt(rating?.reviewerUserId),
    reviewer_worker_id: toPositiveInt(rating?.reviewerWorkerId),
    reviewerWorkerId: toPositiveInt(rating?.reviewerWorkerId),
    reviewee_user_id: toPositiveInt(rating?.revieweeUserId),
    revieweeUserId: toPositiveInt(rating?.revieweeUserId),
    reviewee_worker_id: toPositiveInt(rating?.revieweeWorkerId),
    revieweeWorkerId: toPositiveInt(rating?.revieweeWorkerId),
    reviewee_role: normalizeRole(rating?.revieweeRole),
    revieweeRole: normalizeRole(rating?.revieweeRole),
    overall: normalizeScore(rating?.overall) ?? 0,
    quality: normalizeScore(rating?.quality) ?? 0,
    communication: normalizeScore(rating?.communication) ?? 0,
    reliability: normalizeScore(rating?.reliability) ?? 0,
    comment: toNullableTrimmedText(rating?.comment, 2000),
    reported: Boolean(rating?.reported),
    report_reason: toNullableTrimmedText(rating?.reportReason, 255),
    reportReason: toNullableTrimmedText(rating?.reportReason, 255),
    reported_at: rating?.reportedAt ?? null,
    reportedAt: rating?.reportedAt ?? null,
    created_at: rating?.createdAt ?? null,
    createdAt: rating?.createdAt ?? null,
    updated_at: rating?.updatedAt ?? null,
    updatedAt: rating?.updatedAt ?? null,
    reviewer: rating?.reviewer
      ? {
          id: toPositiveInt(rating.reviewer?.id),
          name: String(rating.reviewer?.name ?? "").trim() || null,
          last_name: String(rating.reviewer?.last_name ?? "").trim() || null,
          username: String(rating.reviewer?.username ?? "").trim() || null,
          image_profil: String(rating.reviewer?.image_profil ?? "").trim() || null,
        }
      : null,
  };
};

export const createClientToWorkerRating = async ({
  serviceIdRaw,
  workerIdRaw,
  reviewerUserIdRaw,
  payload,
}: {
  serviceIdRaw: any;
  workerIdRaw: any;
  reviewerUserIdRaw: any;
  payload: NormalizedRatingPayload;
}) => {
  const serviceId = toPositiveInt(serviceIdRaw);
  const workerId = toPositiveInt(workerIdRaw);
  const reviewerUserId = toPositiveInt(reviewerUserIdRaw);

  if (!serviceId || !workerId || !reviewerUserId) {
    return { invalid: true };
  }

  const sequelize = (ServiceRating as any).sequelize;

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId },
      attributes: ["id", "userId"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) return { notFound: true };

    if (Number((service as any).userId) !== reviewerUserId) {
      return { forbidden: true };
    }

    const acceptedWorkers = await getAcceptedWorkersForService(serviceId, transaction);
    const targetWorker = acceptedWorkers.find((worker) => worker.workerId === workerId);
    if (!targetWorker) return { invalidTarget: true };
    if (targetWorker.userId === reviewerUserId) return { invalidTarget: true };

    try {
      const rating = await ServiceRating.create(
        {
          serviceId,
          reviewerUserId,
          reviewerWorkerId: null,
          revieweeUserId: targetWorker.userId,
          revieweeWorkerId: targetWorker.workerId,
          revieweeRole: "worker",
          ...payload,
        },
        { transaction }
      );

      const fullRating = await ServiceRating.findByPk(rating.id, {
        transaction,
        include: [
          {
            model: User,
            as: "reviewer",
            attributes: ["id", "name", "last_name", "username", "image_profil"],
          },
        ],
      });

      return {
        success: true,
        rating: serializeRating(fullRating ?? rating),
      };
    } catch (error: any) {
      if (error instanceof UniqueConstraintError) return { duplicate: true };
      throw error;
    }
  });
};

export const createWorkerToClientRating = async ({
  serviceIdRaw,
  clientUserIdRaw,
  reviewerUserIdRaw,
  reviewerWorkerIdRaw,
  payload,
}: {
  serviceIdRaw: any;
  clientUserIdRaw: any;
  reviewerUserIdRaw: any;
  reviewerWorkerIdRaw?: any;
  payload: NormalizedRatingPayload;
}) => {
  const serviceId = toPositiveInt(serviceIdRaw);
  const clientUserId = toPositiveInt(clientUserIdRaw);
  const reviewerUserId = toPositiveInt(reviewerUserIdRaw);
  const reviewerWorkerId = toPositiveInt(reviewerWorkerIdRaw);

  if (!serviceId || !clientUserId || !reviewerUserId) {
    return { invalid: true };
  }

  const sequelize = (ServiceRating as any).sequelize;

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId },
      attributes: ["id", "userId"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) return { notFound: true };

    const ownerUserId = toPositiveInt((service as any).userId);
    if (!ownerUserId || ownerUserId !== clientUserId) return { invalidTarget: true };

    const acceptedWorkers = await getAcceptedWorkersForService(serviceId, transaction);
    const reviewerWorker = acceptedWorkers.find((worker) => {
      if (worker.userId === reviewerUserId) return true;
      if (reviewerWorkerId && worker.workerId === reviewerWorkerId) return true;
      return false;
    });

    if (!reviewerWorker) return { forbidden: true };
    if (ownerUserId === reviewerUserId) return { forbidden: true };

    const ratingRequestedForWorker = await hasClientRatedWorkerForService({
      serviceId,
      clientUserId: ownerUserId,
      workerUserId: reviewerUserId,
      workerId: reviewerWorker.workerId,
      transaction,
    });
    if (!ratingRequestedForWorker) {
      return { ratingNotRequested: true };
    }

    try {
      const rating = await ServiceRating.create(
        {
          serviceId,
          reviewerUserId,
          reviewerWorkerId: reviewerWorker.workerId,
          revieweeUserId: ownerUserId,
          revieweeWorkerId: null,
          revieweeRole: "client",
          ...payload,
        },
        { transaction }
      );

      const fullRating = await ServiceRating.findByPk(rating.id, {
        transaction,
        include: [
          {
            model: User,
            as: "reviewer",
            attributes: ["id", "name", "last_name", "username", "image_profil"],
          },
        ],
      });

      return {
        success: true,
        rating: serializeRating(fullRating ?? rating),
      };
    } catch (error: any) {
      if (error instanceof UniqueConstraintError) return { duplicate: true };
      throw error;
    }
  });
};
