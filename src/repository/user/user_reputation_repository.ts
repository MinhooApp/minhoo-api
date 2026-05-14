import { col, fn, literal, Op } from "sequelize";
import Offer from "../../_models/offer/offer";
import Service from "../../_models/service/service";
import ServiceRating from "../../_models/service/service_rating";
import User from "../../_models/user/user";
import Worker from "../../_models/worker/worker";

const SERVICE_STATUS_COMPLETED = 4;
const SERVICE_STATUS_CANCELED = 5;

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const normalizePage = (raw: any) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.trunc(parsed);
};

const normalizeLimit = (raw: any) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
};

const toOneDecimal = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  // Truncate (not round) so slight drops remain visible in UI (e.g. 4.97 -> 4.9).
  const bounded = Math.min(Math.max(parsed, 0), 5);
  return Math.floor(bounded * 10) / 10;
};

const toStars = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.round(parsed), 0), 5);
};

const toTrimmedOrNull = (value: any): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized;
};

const toReviewerName = (reviewer: any): string => {
  const name = String(reviewer?.name ?? "").trim();
  const lastName = String(reviewer?.last_name ?? "").trim();
  const fullName = `${name} ${lastName}`.trim();
  if (fullName) return fullName;

  const username = String(reviewer?.username ?? "").trim();
  if (username) return username;

  return "Usuario";
};

const toReviewDate = (value: any) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const buildReviewsList = (ratingsRaw: any[]) => {
  const ratings = Array.isArray(ratingsRaw) ? ratingsRaw : [];
  return ratings.map((ratingRaw: any) => {
    const rating =
      ratingRaw && typeof ratingRaw.toJSON === "function"
        ? ratingRaw.toJSON()
        : ratingRaw ?? {};

    const reviewer = rating?.reviewer ?? null;
    return {
      id: String(rating?.id ?? ""),
      reviewer_name: toReviewerName(reviewer),
      reviewer_username: toTrimmedOrNull(reviewer?.username),
      reviewerUsername: toTrimmedOrNull(reviewer?.username),
      reviewer_avatar: toTrimmedOrNull(reviewer?.image_profil),
      stars: toStars(rating?.overall),
      comment: toTrimmedOrNull(rating?.comment) ?? "",
      date: toReviewDate(rating?.createdAt),
    };
  });
};

const loadRoleRatingsAggregateOnCompletedServices = async ({
  revieweeUserId,
  revieweeRole,
}: {
  revieweeUserId: number;
  revieweeRole: "client" | "worker";
}) => {
  const aggregateRaw = (await ServiceRating.findOne({
    where: {
      revieweeUserId,
      revieweeRole,
    },
    include: [
      {
        model: Service,
        as: "service",
        required: true,
        attributes: [],
        where: {
          statusId: SERVICE_STATUS_COMPLETED,
        },
      },
    ],
    attributes: [
      [fn("COUNT", col("service_rating.id")), "reviews_count"],
      [
        fn(
          "AVG",
          literal(
            "((`service_rating`.`quality` + `service_rating`.`communication` + `service_rating`.`reliability`) / 3)"
          )
        ),
        "avg_job_score",
      ],
      [fn("AVG", col("service_rating.quality")), "avg_quality"],
      [fn("AVG", col("service_rating.communication")), "avg_communication"],
      [fn("AVG", col("service_rating.reliability")), "avg_reliability"],
    ],
    raw: true,
  })) as any;

  return {
    reviews_count: Number(aggregateRaw?.reviews_count ?? 0) || 0,
    avg_job_score: toOneDecimal(aggregateRaw?.avg_job_score),
    avg_quality: toOneDecimal(aggregateRaw?.avg_quality),
    avg_communication: toOneDecimal(aggregateRaw?.avg_communication),
    avg_reliability: toOneDecimal(aggregateRaw?.avg_reliability),
  };
};

const loadRoleRatingsReviewsOnCompletedServices = async ({
  revieweeUserId,
  revieweeRole,
  limit,
  offset,
}: {
  revieweeUserId: number;
  revieweeRole: "client" | "worker";
  limit: number;
  offset: number;
}) => {
  const ratingsRaw = await ServiceRating.findAll({
    where: {
      revieweeUserId,
      revieweeRole,
    },
    include: [
      {
        model: User,
        as: "reviewer",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
      {
        model: Service,
        as: "service",
        required: true,
        attributes: [],
        where: {
          statusId: SERVICE_STATUS_COMPLETED,
        },
      },
    ],
    attributes: ["id", "overall", "comment", "createdAt"],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    offset,
  });

  return buildReviewsList(ratingsRaw as any[]);
};

const loadCustomerHiresCount = async (userId: number) => {
  const count = await Offer.count({
    where: {
      accepted: true,
      canceled: false,
      removed: false,
    },
    include: [
      {
        model: Service,
        as: "service",
        required: true,
        attributes: [],
        where: {
          userId,
          statusId: SERVICE_STATUS_COMPLETED,
        },
      },
    ],
  });

  return Number(count) || 0;
};

const loadCustomerCanceledCount = async (userId: number) => {
  const count = await Service.count({
    where: {
      userId,
      statusId: SERVICE_STATUS_CANCELED,
    },
  });
  return Number(count) || 0;
};

const loadWorkerProfiles = async (userId: number) => {
  const rows = await Worker.findAll({
    where: { userId },
    attributes: ["id", "rate"],
    raw: true,
  });
  return Array.isArray(rows) ? rows : [];
};

const loadWorkerJobsCompletedCount = async (workerIds: number[]) => {
  if (!Array.isArray(workerIds) || !workerIds.length) return 0;

  const count = await Offer.count({
    where: {
      workerId: { [Op.in]: workerIds },
      accepted: true,
      canceled: false,
      removed: false,
      workerClosedAt: { [Op.ne]: null },
    },
    include: [
      {
        model: Service,
        as: "service",
        required: true,
        attributes: [],
        where: {
          statusId: SERVICE_STATUS_COMPLETED,
        },
      },
    ],
  });

  return Number(count) || 0;
};

const loadWorkerCanceledCount = async (workerIds: number[]) => {
  if (!Array.isArray(workerIds) || !workerIds.length) return 0;

  const count = await Offer.count({
    where: {
      workerId: { [Op.in]: workerIds },
      canceled: true,
    },
  });
  return Number(count) || 0;
};

export const getUserReputation = async ({
  userIdRaw,
  pageRaw,
  limitRaw,
}: {
  userIdRaw: any;
  pageRaw?: any;
  limitRaw?: any;
}) => {
  const userId = toPositiveInt(userIdRaw);
  if (!userId) return { invalidUserId: true };

  const page = normalizePage(pageRaw);
  const limit = normalizeLimit(limitRaw);
  const offset = (page - 1) * limit;

  const user = await User.findOne({
    where: {
      id: userId,
      available: true,
      disabled: false,
      is_deleted: false,
    },
    attributes: ["id"],
    raw: true,
  });

  if (!user) return { notFound: true };

  const workerProfiles = await loadWorkerProfiles(userId);
  const hasWorkerProfile = workerProfiles.length > 0;
  const workerIds = workerProfiles
    .map((worker) => toPositiveInt((worker as any)?.id))
    .filter((id): id is number => Boolean(id));
  const [
    customerAggregate,
    customerReviews,
    customerHires,
    customerCanceled,
    workerAggregate,
    workerReviews,
    workerJobsCompleted,
    workerCanceled,
  ] = await Promise.all([
    loadRoleRatingsAggregateOnCompletedServices({
      revieweeUserId: userId,
      revieweeRole: "client",
    }),
    loadRoleRatingsReviewsOnCompletedServices({
      revieweeUserId: userId,
      revieweeRole: "client",
      limit,
      offset,
    }),
    loadCustomerHiresCount(userId),
    loadCustomerCanceledCount(userId),
    hasWorkerProfile
      ? loadRoleRatingsAggregateOnCompletedServices({
          revieweeUserId: userId,
          revieweeRole: "worker",
        })
      : Promise.resolve(null),
    hasWorkerProfile
      ? loadRoleRatingsReviewsOnCompletedServices({
          revieweeUserId: userId,
          revieweeRole: "worker",
          limit,
          offset,
        })
      : Promise.resolve([] as any[]),
    hasWorkerProfile ? loadWorkerJobsCompletedCount(workerIds) : Promise.resolve(0),
    hasWorkerProfile ? loadWorkerCanceledCount(workerIds) : Promise.resolve(0),
  ]);

  const customerRate = toOneDecimal(customerAggregate.avg_job_score);
  const customer = {
    rate: customerRate,
    rating: customerRate,
    hires: customerHires,
    jobs_completed: customerHires,
    canceled: customerCanceled,
    jobs_canceled_by_user: customerCanceled,
    reviews_count: customerAggregate.reviews_count,
    sub_ratings: {
      request_quality: customerAggregate.avg_quality,
      payments_agreements: customerAggregate.avg_reliability,
      communication: customerAggregate.avg_communication,
    },
    reviews: customerReviews,
  };

  const worker = hasWorkerProfile
    ? {
        rate: toOneDecimal(workerAggregate?.avg_job_score),
        rating: toOneDecimal(workerAggregate?.avg_job_score),
        jobs_completed: workerJobsCompleted,
        canceled: workerCanceled,
        jobs_canceled_by_user: workerCanceled,
        reviews_count: Number(workerAggregate?.reviews_count ?? 0),
        sub_ratings: {
          quality_of_work: toOneDecimal(workerAggregate?.avg_quality),
          communication: toOneDecimal(workerAggregate?.avg_communication),
          reliability: toOneDecimal(workerAggregate?.avg_reliability),
        },
        reviews: workerReviews,
      }
    : null;

  return {
    success: true,
    page,
    limit,
    data: {
      customer,
      worker,
    },
  };
};
