import { IndexHints, Op, Sequelize, UniqueConstraintError } from "sequelize";
import Offer from "../../_models/offer/offer";
import Service from "../../_models/service/service";
import { serviceInclude } from "./service_includes";
import Service_Worker from "../../_models/service/service_worker";
import Worker from "../../_models/worker/worker";
import User from "../../_models/user/user";
import ServiceReport from "../../_models/service/service_report";
import ServiceRating from "../../_models/service/service_rating";
import Category from "../../_models/category/category";
import StatusService from "../../_models/status/statusService";
import { autoDisableUserByImpersonationReports } from "../user/user_repository";

const excludeKeys = ["createdAt", "updatedAt", "password"];
const SERVICE_REPORT_AUTO_DELETE_THRESHOLD = Math.max(
  20,
  Number(process.env.SERVICE_REPORT_AUTO_DELETE_THRESHOLD ?? 20) || 20
);
const IMPERSONATION_REPORT_REASON = "impersonation_or_identity_fraud";
const SERVICE_STATUS_COMPLETED = 4;
const SERVICE_STATUS_CANCELED = 5;

const nowDate = () => new Date();
const toIso = (value: any) => new Date(value ?? Date.now()).toISOString();

const notBlockedLiteral = () =>
  Sequelize.literal(`
    NOT EXISTS (
      SELECT 1
      FROM user_blocks ub
      WHERE
        (ub.blocker_id = :meId AND ub.blocked_id = \`service\`.\`userId\`)
        OR
        (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = :meId)
    )
  `);

const notBlockedLiteralWithMeId = (meIdRaw: any) => {
  const meId = Number.isFinite(Number(meIdRaw)) ? Math.trunc(Number(meIdRaw)) : -1;
  return Sequelize.literal(`
    NOT EXISTS (
      SELECT 1
      FROM user_blocks ub
      WHERE
        (ub.blocker_id = ${meId} AND ub.blocked_id = \`service\`.\`userId\`)
        OR
        (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = ${meId})
    )
  `);
};

const pagination = (page: any = 0, size: any = 10) => {
  const limit = Number(size);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;

  const p = Number(page);
  const safePage = Number.isFinite(p) && p >= 0 ? p : 0;

  return { limit: safeLimit, offset: safePage * safeLimit };
};

export type ServiceHistoryDateRange = {
  from?: Date | null;
  to?: Date | null;
};

const buildServiceDateWhere = (dateRange?: ServiceHistoryDateRange) => {
  const from = dateRange?.from instanceof Date ? dateRange.from : null;
  const to = dateRange?.to instanceof Date ? dateRange.to : null;

  if (from && to) {
    return { [Op.between]: [from, to] };
  }
  if (from) {
    return { [Op.gte]: from };
  }
  if (to) {
    return { [Op.lte]: to };
  }
  return null;
};

const serviceSummaryInclude = [
  {
    model: User,
    as: "client",
    attributes: [
      "id",
      "name",
      "last_name",
      "username",
      "image_profil",
      "verified",
      "profile_verified",
      "profile_verification_status",
      "language",
      "language_codes",
      "language_names",
      "city_residence_id",
      "state_residence_id",
      "country_residence_id",
      "cityId",
      "countryId",
    ],
  },
  {
    model: StatusService,
    as: "status",
    attributes: ["id", "status", "description"],
  },
  {
    model: Category,
    as: "category",
    attributes: ["id", "name", "es_name"],
  },
] as const;

const applicantsCountSummaryAttribute = [
  Sequelize.literal(`(
    SELECT COUNT(DISTINCT o.workerId)
    FROM offers o
    WHERE
      o.serviceId = \`service\`.\`id\`
      AND o.canceled = 0
      AND o.removed = 0
  )`),
  "applicants_count",
] as const;

const orderByNewestStable: any[] = [
  ["service_date", "DESC"],
  ["id", "DESC"],
];

const buildExcludeAppliedLiteral = (workerIdsRaw: number[]) => {
  const workerIds = (Array.isArray(workerIdsRaw) ? workerIdsRaw : [])
    .map((id) => Math.trunc(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!workerIds.length) return null;
  return Sequelize.literal(`
    NOT EXISTS (
      SELECT 1
      FROM offers o
      WHERE
        o.serviceId = \`service\`.\`id\`
        AND o.workerId IN (${workerIds.join(",")})
        AND o.canceled = 0
        AND o.removed = 0
    )
  `);
};

const buildServiceIncludeForWorkerOffer = (offerWhere: Record<string, any>) => {
  return (serviceInclude as any[]).map((include: any) => {
    if (include?.as !== "offers") return include;
    return {
      ...include,
      required: true,
      where: {
        ...offerWhere,
        [Op.and]: [notBlockedLiteral()],
      },
    };
  });
};

const buildWorkerOfferFilterInclude = (
  offerWhere: Record<string, any>,
  meId: any
) => ({
  model: Offer,
  as: "offers",
  attributes: [],
  required: true,
  where: {
    ...offerWhere,
    [Op.and]: [notBlockedLiteralWithMeId(meId)],
  },
});

const countServicesForWorkerScope = async (
  where: Record<string, any>,
  workerScopeWhere: Record<string, any>,
  meId: any
) => {
  return Service.count({
    where,
    include: [buildWorkerOfferFilterInclude(workerScopeWhere, meId)] as any,
    distinct: true,
  });
};

export const historyWorkersStatusCounts = async (
  workerId: number,
  meId: any,
  dateRange?: ServiceHistoryDateRange
) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    accepted: true,
    canceled: false,
    removed: false,
  });
  if (!workerScopeWhere) return {} as Record<number, number>;

  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { is_available: true };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  const rows = await Service.findAll({
    where,
    include: [buildWorkerOfferFilterInclude(workerScopeWhere, meId)] as any,
    attributes: [
      "statusId",
      [Sequelize.fn("COUNT", Sequelize.fn("DISTINCT", Sequelize.col("service.id"))), "count"],
    ],
    group: ["service.statusId"],
    raw: true,
  });

  const counts: Record<number, number> = {};
  for (const row of rows as any[]) {
    const statusId = Number((row as any)?.statusId ?? 0);
    const count = Number((row as any)?.count ?? 0);
    if (Number.isFinite(statusId) && statusId > 0) {
      counts[statusId] = Number.isFinite(count) ? count : 0;
    }
  }
  return counts;
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const resolveWorkerIdsForUser = async (
  workerIdRaw: any,
  userIdRaw: any
): Promise<number[]> => {
  const ids = new Set<number>();

  const directWorkerId = toPositiveInt(workerIdRaw);
  if (directWorkerId) {
    ids.add(directWorkerId);
  }

  const userId = toPositiveInt(userIdRaw);
  if (userId) {
    const rows = await Worker.findAll({
      where: { userId },
      attributes: ["id"],
      raw: true,
    });

    for (const row of rows as any[]) {
      const workerId = toPositiveInt((row as any)?.id);
      if (workerId) ids.add(workerId);
    }
  }

  return [...ids];
};

const buildWorkerScopeWhere = async (
  workerIdRaw: any,
  userIdRaw: any,
  extraWhere: Record<string, any> = {}
) => {
  const workerIds = await resolveWorkerIdsForUser(workerIdRaw, userIdRaw);
  if (!workerIds.length) return null;

  return {
    ...extraWhere,
    workerId: workerIds.length === 1 ? workerIds[0] : { [Op.in]: workerIds },
  };
};

export const add = async (body: any) => {
  const service = await Service.create(body);
  return Service.findByPk(service.id, {
    include: serviceInclude,
    attributes: { exclude: excludeKeys },
  });
};

export const gets = async () => {
  return Service.findAll({
    where: { is_available: true },
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
};

export const getsSummary = async (size: any = 20) => {
  const { limit } = pagination(0, Math.min(Math.max(Number(size) || 20, 1), 20));
  return Service.findAll({
    where: { is_available: true },
    attributes: [
      "id",
      "userId",
      "categoryId",
      "description",
      "rate",
      "currencyCode",
      "currencyPrefix",
      "service_date",
      "statusId",
      "closedAt",
      "manualClosedAt",
      applicantsCountSummaryAttribute as any,
    ],
    include: serviceSummaryInclude as any,
    indexHints: [
      {
        type: IndexHints.USE,
        values: ["idx_services_available_date"],
      },
    ],
    order: [["service_date", "DESC"]],
    limit,
  });
};

export const getFeedServicesCandidates = async (
  size: any = 60,
  meId: any = -1
) => {
  const { limit } = pagination(0, Math.min(Math.max(Number(size) || 60, 1), 120));
  const workerIds = await resolveWorkerIdsForUser(undefined, meId);
  const whereAnd: any[] = [notBlockedLiteral()];
  const excludeAppliedLiteral = buildExcludeAppliedLiteral(workerIds);
  if (excludeAppliedLiteral) whereAnd.push(excludeAppliedLiteral);
  return Service.findAll({
    where: {
      is_available: true,
      statusId: 1,
      [Op.and]: whereAnd,
    },
    replacements: { meId },
    limit,
    include: serviceSummaryInclude as any,
    indexHints: [
      {
        type: IndexHints.USE,
        values: ["idx_services_available_date"],
      },
    ],
    order: orderByNewestStable,
    attributes: [
      "id",
      "userId",
      "categoryId",
      "description",
      "rate",
      "currencyCode",
      "currencyPrefix",
      "service_date",
      "statusId",
      "on_site",
      "longitude",
      "latitude",
      "address",
      "closedAt",
      "manualClosedAt",
      applicantsCountSummaryAttribute as any,
    ],
  });
};

export const history = async (
  userId?: number,
  canceled = true,
  dateRange?: ServiceHistoryDateRange
) => {
  const serviceDateWhere = buildServiceDateWhere(dateRange);

  if (userId != undefined) {
    const where: any = {
      userId,
      statusId: { [Op.notIn]: canceled ? [1, 2, 3] : [1, 2, 3, 5] },
    };
    if (serviceDateWhere) {
      where.service_date = serviceDateWhere;
    }

    return Service.findAll({
      where,
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
  }

  const where: any = { statusId: { [Op.notIn]: [1, 2, 3, 5] } };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAll({
    where,
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
};

export const historyCanceled = async (
  userId?: number,
  dateRange?: ServiceHistoryDateRange
) => {
  const serviceDateWhere = buildServiceDateWhere(dateRange);

  if (userId != undefined) {
    const where: any = { userId, statusId: 5 };
    if (serviceDateWhere) {
      where.service_date = serviceDateWhere;
    }

    return Service.findAll({
      where,
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
  }

  const where: any = { statusId: 5 };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAll({
    where,
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
};

export const onGoing = async (userId?: number) => {
  if (userId) {
    const hasAcceptedWorkerLiteral = Sequelize.literal(`
      EXISTS (
        SELECT 1
        FROM offers o
        WHERE
          o.serviceId = \`service\`.\`id\`
          AND o.accepted = 1
          AND o.canceled = 0
          AND o.removed = 0
      )
    `);

    return Service.findAll({
      where: {
        is_available: true,
        userId,
        [Op.or]: [
          { statusId: 1 },
          { statusId: 2 },
          { statusId: 3 },
          {
            statusId: 4,
            closedAt: { [Op.ne]: null },
            manualClosedAt: null,
            [Op.and]: [hasAcceptedWorkerLiteral],
          },
        ],
      },
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
  }

  return Service.findAll({
    where: { is_available: true, statusId: 1 },
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
};

export const getsOnGoing = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1
) => {
  const { limit, offset } = pagination(page, size);

  return Service.findAndCountAll({
    where: {
      is_available: true,
      statusId: 1,
      [Op.and]: [notBlockedLiteral()],
    },
    replacements: { meId },
    limit,
    offset,
    include: serviceInclude,
    order: orderByNewestStable,
    attributes: { exclude: excludeKeys },
    distinct: true,
  });
};

/**
 * Worker - Servicios activos del worker (aceptado),
 * no cancelado/removed.
 */
export const onGoingWorkers = async (workerId: number, meId: any) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    accepted: true,
    canceled: false,
    removed: false,
  });
  if (!workerScopeWhere) return [];

  return Service.findAll({
    where: { is_available: true, statusId: 1 },
    include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
    replacements: { meId },
    order: orderByNewestStable,
  });
};

export const onGoingWorkersPaged = async (
  workerId: number,
  meId: any,
  page: any = 0,
  size: any = 10
) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    accepted: true,
    canceled: false,
    removed: false,
  });
  if (!workerScopeWhere) return { count: 0, rows: [] } as any;

  const { limit, offset } = pagination(page, size);
  const where = { is_available: true, statusId: 1 };
  const [count, rows] = await Promise.all([
    countServicesForWorkerScope(where, workerScopeWhere, meId),
    Service.findAll({
      where,
      include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
      replacements: { meId },
      order: orderByNewestStable,
      limit,
      offset,
    }),
  ]);

  return { count, rows } as any;
};

/**
 * Worker - Cancelados (para historial / pestaña cancelados)
 */
export const onGoingCanceledWorkers = async (workerId: number, meId: any) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    canceled: false,
  });
  if (!workerScopeWhere) return [];

  const meUserId = toPositiveInt(meId);
  const where: any = { statusId: 5 };
  if (meUserId) {
    where.userId = { [Op.ne]: meUserId };
  }

  return Service.findAll({
    where,
    include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
    replacements: { meId },
    order: orderByNewestStable,
  });
};

export const onGoingCanceledWorkersPaged = async (
  workerId: number,
  meId: any,
  page: any = 0,
  size: any = 10,
  dateRange?: ServiceHistoryDateRange
) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    canceled: false,
  });
  if (!workerScopeWhere) return { count: 0, rows: [] } as any;

  const { limit, offset } = pagination(page, size);
  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const meUserId = toPositiveInt(meId);
  const where: any = { statusId: 5 };
  if (meUserId) {
    where.userId = { [Op.ne]: meUserId };
  }
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  const [count, rows] = await Promise.all([
    countServicesForWorkerScope(where, workerScopeWhere, meId),
    Service.findAll({
      where,
      include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
      replacements: { meId },
      order: orderByNewestStable,
      limit,
      offset,
    }),
  ]);

  return { count, rows } as any;
};

/**
 * ✅ Worker - Accepted:
 * IMPORTANTE: accepted true PERO canceled/removed false.
 * Si no haces esto, un accepted-canceled se “cuela” como Accepted.
 */
export const historyWorkers = async (
  workerId: number,
  meId: any,
  dateRange?: ServiceHistoryDateRange,
  statusIds?: number[]
) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    accepted: true,
    canceled: false,
    removed: false,
  });
  if (!workerScopeWhere) return [];

  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { is_available: true };
  if (Array.isArray(statusIds) && statusIds.length > 0) {
    where.statusId = statusIds.length === 1 ? statusIds[0] : { [Op.in]: statusIds };
  }
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAll({
    where,
    include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
    replacements: { meId },
    order: orderByNewestStable,
  });
};

export const historyWorkersPaged = async (
  workerId: number,
  meId: any,
  page: any = 0,
  size: any = 10,
  dateRange?: ServiceHistoryDateRange,
  statusIds?: number[]
) => {
  const workerScopeWhere = await buildWorkerScopeWhere(workerId, meId, {
    accepted: true,
    canceled: false,
    removed: false,
  });
  if (!workerScopeWhere) return { count: 0, rows: [] } as any;

  const { limit, offset } = pagination(page, size);
  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { is_available: true };
  if (Array.isArray(statusIds) && statusIds.length > 0) {
    where.statusId = statusIds.length === 1 ? statusIds[0] : { [Op.in]: statusIds };
  }
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  const [count, rows] = await Promise.all([
    countServicesForWorkerScope(where, workerScopeWhere, meId),
    Service.findAll({
      where,
      include: buildServiceIncludeForWorkerOffer(workerScopeWhere),
      replacements: { meId },
      order: orderByNewestStable,
      limit,
      offset,
    }),
  ]);

  return { count, rows } as any;
};

export const get = async (id: any) => {
  return Service.findOne({
    where: { id },
    include: serviceInclude,
  });
};

export const getByUser = async (id: any, userId: any) => {
  return Service.findOne({
    where: { id, userId },
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
};

/**
 * ✅ Workers asignados al servicio (Accepted del lado del cliente):
 * Filtra canceled:false y removed:false sí o sí.
 */
export const workersByService = async (id: any, userId: any) => {
  const service = await Service.findOne({
    where: { id },
    include: [
      {
        model: Offer,
        as: "offers",
        where: {
          accepted: true,
          canceled: false,
          removed: false,
        },
        required: true,
        include: [
          {
            model: Worker,
            as: "offerer",
            include: [{ model: User, as: "personal_data" }],
          },
        ],
      },
    ],
    order: [["service_date", "DESC"]],
  });

  if (!service || !(service as any).offers) return [];

  const offers = (service as any).offers as any[];
  return offers.map((o) => o.offerer).filter(Boolean);
};

export const update = async (id: any, body: any) => {
  const serviceTemp = await Service.findByPk(id);
  const service = await serviceTemp?.update(body);
  return [service];
};

export const assignWorker = async (
  workerId: any,
  request: Service,
  assigend: boolean
) => {
  await request.addWorker(workerId, { through: { removed: false } });

  if (assigend) {
    await request.update({ statusId: 2 });
  }

  return Service_Worker.findOne({
    where: { serviceId: request.id, workerId },
  });
};

export const removeWorker = async (serviceId: any, workerId: any) => {
  const temp = await Service_Worker.findOne({
    where: { serviceId, workerId },
  });

  return temp?.update({ removed: true, canceled: false });
};

const countAcceptedWorkers = async (serviceId: number, transaction: any) => {
  const acceptedCount = await Offer.count({
    where: {
      serviceId,
      accepted: true,
      canceled: false,
      removed: false,
    },
    transaction,
  });
  return Number(acceptedCount) || 0;
};

export const finalizeSearchService = async (id: any) => {
  const serviceId = Number(id);
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return { invalidServiceId: true };
  }

  const sequelize = (Service as any).sequelize;
  if (!sequelize) {
    throw new Error("Service sequelize instance is not available");
  }

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) {
      return { notFound: true };
    }

    const acceptedCount = await countAcceptedWorkers(serviceId, transaction);

    const currentStatusId = Number((service as any).statusId ?? 0);
    if (currentStatusId === SERVICE_STATUS_CANCELED) {
      return { canceledService: true };
    }

    const closedAtDate = nowDate();
    const updatePayload: Record<string, any> = {
      statusId: SERVICE_STATUS_COMPLETED,
    };
    const alreadyFinalized = currentStatusId === SERVICE_STATUS_COMPLETED;

    if (!alreadyFinalized) {
      updatePayload.closedAt = closedAtDate;
      updatePayload.manualClosedAt = null;
    } else if (!(service as any).closedAt) {
      updatePayload.closedAt = closedAtDate;
    }

    await service.update(updatePayload, { transaction });

    await service.reload({ transaction });

    const fullService = await Service.findOne({
      where: { id: serviceId },
      include: serviceInclude,
      transaction,
    });

    return {
      id: serviceId,
      status: "FINALIZED",
      statusId: SERVICE_STATUS_COMPLETED,
      acceptedCount,
      closedAt: toIso((service as any).closedAt ?? closedAtDate),
      service: fullService,
    };
  });
};

export const moveServiceToHistory = async (id: any) => {
  const serviceId = Number(id);
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return { invalidServiceId: true };
  }

  const sequelize = (Service as any).sequelize;
  if (!sequelize) {
    throw new Error("Service sequelize instance is not available");
  }

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) {
      return { notFound: true };
    }

    const statusId = Number((service as any).statusId ?? 0);
    if (statusId !== SERVICE_STATUS_COMPLETED) {
      return { invalidStatus: true, statusId };
    }

    const acceptedCount = await countAcceptedWorkers(serviceId, transaction);
    const manualClosedAtDate = nowDate();
    const persistedClosedAt = (service as any).closedAt ?? nowDate();
    const existingManualClosedAt = (service as any).manualClosedAt;

    if (acceptedCount > 0 && !existingManualClosedAt) {
      await service.update(
        {
          manualClosedAt: manualClosedAtDate,
          closedAt: persistedClosedAt,
        },
        { transaction }
      );
      await service.reload({ transaction });
    }

    const fullService = await Service.findOne({
      where: { id: serviceId },
      include: serviceInclude,
      transaction,
    });

    return {
      id: serviceId,
      status: "FINALIZED",
      statusId: SERVICE_STATUS_COMPLETED,
      acceptedCount,
      closedAt: toIso((service as any).closedAt ?? persistedClosedAt),
      manualClosedAt:
        acceptedCount > 0
          ? toIso((service as any).manualClosedAt ?? existingManualClosedAt ?? manualClosedAtDate)
          : null,
      service: fullService,
    };
  });
};

export const finalizeServiceForWorker = async (
  id: any,
  workerIdRaw: any,
  workerUserIdRaw: any
) => {
  const serviceId = Number(id);
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return { invalidServiceId: true };
  }

  const workerUserId = toPositiveInt(workerUserIdRaw);
  if (!workerUserId) {
    return { workerUnauthorized: true };
  }

  const sequelize = (Service as any).sequelize;
  if (!sequelize) {
    throw new Error("Service sequelize instance is not available");
  }

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) return { notFound: true };

    const statusId = Number((service as any).statusId ?? 0);
    if (statusId === SERVICE_STATUS_CANCELED) {
      return { invalidStatus: true, statusId, canceledService: true };
    }
    if (![1, 2, 3, SERVICE_STATUS_COMPLETED].includes(statusId)) {
      return { invalidStatus: true, statusId };
    }

    const workerIds = await resolveWorkerIdsForUser(workerIdRaw, workerUserIdRaw);
    if (!workerIds.length) {
      return { workerUnauthorized: true };
    }

    const acceptedOffer = await Offer.findOne({
      where: {
        serviceId,
        workerId: { [Op.in]: workerIds },
        accepted: true,
        canceled: false,
        removed: false,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!acceptedOffer) {
      return { workerNotAssigned: true };
    }

    const workerRatedClient = await ServiceRating.findOne({
      where: {
        serviceId,
        reviewerUserId: workerUserId,
        revieweeRole: "client",
        [Op.or]: [
          { reviewerWorkerId: { [Op.in]: workerIds } },
          { reviewerWorkerId: null },
        ],
      },
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    if (!workerRatedClient) {
      return { ratingRequired: true };
    }

    if (!(acceptedOffer as any).workerClosedAt) {
      await acceptedOffer.update(
        {
          workerClosedAt: nowDate(),
        },
        { transaction }
      );
    }

    await service.reload({ transaction });

    const fullService = await Service.findOne({
      where: { id: serviceId },
      include: serviceInclude,
      transaction,
    });

    return {
      id: serviceId,
      status: "FINALIZED",
      statusId,
      service: fullService,
      workerClosedAt: toIso((acceptedOffer as any).workerClosedAt ?? nowDate()),
      workerFinalized: true,
    };
  });
};

export const finalizedService = async (id: any) => finalizeSearchService(id);

/**
 * ✅ FIX:
 * Si el worker cancela (aunque estaba accepted),
 * pasa a canceled:true y accepted:false.
 * Además fuerza updatedAt para que el front refresque siempre.
 */
export const cancelWorker = async (
  serviceId: any,
  workerId: any,
  removed: boolean
) => {
  const [affected] = await Offer.update(
    {
      removed,
      canceled: true,
      accepted: false, // 👈 clave
      updatedAt: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
    { where: { serviceId, workerId } }
  );

  if (!affected) {
    return Offer.create({
      serviceId,
      workerId,
      removed,
      canceled: true,
      accepted: false,
    });
  }

  return Offer.findOne({ where: { serviceId, workerId } });
};

/**
 * ✅ Re-aplicar:
 * SIEMPRE vuelve a Applicants => accepted:false, canceled:false, removed:false
 * aunque antes haya estado accepted y haya cancelado.
 */
export const reApplyWorker = async (
  serviceId: number,
  workerId: number,
  data?: { price?: number; message?: string }
) => {
  await Offer.upsert({
    serviceId,
    workerId,
    accepted: false,  // 👈 applicants
    canceled: false,  // 👈 reabre postulación
    removed: false,
    ...(data ?? {}),
    updatedAt: Sequelize.literal("CURRENT_TIMESTAMP") as any,
  } as any);

  return Offer.findOne({ where: { serviceId, workerId } });
};

export const deleteservice = async (id: any) => {
  await Service.update(
    {
      is_available: false,
      statusId: SERVICE_STATUS_CANCELED,
      closedAt: nowDate(),
      manualClosedAt: null,
    },
    { where: { id } }
  );
};

export const hasClientRatedWorkerForService = async (
  serviceIdRaw: any,
  clientUserIdRaw: any
) => {
  const serviceId = Number(serviceIdRaw);
  const clientUserId = Number(clientUserIdRaw);
  if (!Number.isFinite(serviceId) || serviceId <= 0) return false;
  if (!Number.isFinite(clientUserId) || clientUserId <= 0) return false;

  const rating = await ServiceRating.findOne({
    where: {
      serviceId,
      reviewerUserId: clientUserId,
      revieweeRole: "worker",
    },
    attributes: ["id"],
    raw: true,
  });

  return Boolean(Number((rating as any)?.id ?? 0));
};

export const reportService = async ({
  serviceIdRaw,
  reporterIdRaw,
  reason,
  details,
}: {
  serviceIdRaw: any;
  reporterIdRaw: any;
  reason: string;
  details?: string | null;
}) => {
  const serviceId = Number(serviceIdRaw);
  const reporterId = Number(reporterIdRaw);
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    return { notFound: true };
  }
  if (!Number.isFinite(reporterId) || reporterId <= 0) {
    return { invalidReporter: true };
  }

  const sequelize = (Service as any).sequelize;
  const normalizedDetails = String(details ?? "").trim().slice(0, 4000) || null;

  return sequelize.transaction(async (transaction: any) => {
    const service = await Service.findOne({
      where: { id: serviceId, is_available: true },
      attributes: ["id", "userId", "is_available", "statusId"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!service) {
      return { notFound: true };
    }

    const ownerId = Number((service as any)?.userId ?? 0);
    if (ownerId > 0 && ownerId === reporterId) {
      return { selfReport: true };
    }

    const existing = await ServiceReport.findOne({
      where: { serviceId, reporterId },
      attributes: ["id"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    let alreadyReported = false;
    if (!existing) {
      try {
        await ServiceReport.create(
          {
            serviceId,
            reporterId,
            reason,
            details: normalizedDetails,
          },
          { transaction }
        );
      } catch (error: any) {
        if (error instanceof UniqueConstraintError) {
          alreadyReported = true;
        } else {
          throw error;
        }
      }
    } else {
      alreadyReported = true;
    }

    const reportsCount = await ServiceReport.count({
      where: { serviceId },
      distinct: true,
      col: "reporterId",
      transaction,
    });

    const shouldAutoDelete =
      Number(reportsCount) >= SERVICE_REPORT_AUTO_DELETE_THRESHOLD &&
      Boolean((service as any)?.is_available);

    let autoDeleted = false;
    if (shouldAutoDelete) {
      await Service.update(
        {
          is_available: false,
          statusId: 5,
        },
        {
          where: { id: serviceId },
          transaction,
        }
      );
      autoDeleted = true;
    }

    let ownerAutoDisabled = false;
    if (ownerId > 0 && reason === IMPERSONATION_REPORT_REASON) {
      const autoDisable = await autoDisableUserByImpersonationReports({
        userIdRaw: ownerId,
        transaction,
      });
      ownerAutoDisabled = Boolean(autoDisable?.disabledNow);
    }

    return {
      notFound: false,
      invalidReporter: false,
      selfReport: false,
      alreadyReported,
      reportsCount: Number(reportsCount) || 0,
      threshold: SERVICE_REPORT_AUTO_DELETE_THRESHOLD,
      autoDeleted,
      ownerAutoDisabled,
      serviceId,
      ownerId,
    };
  });
};

export const getsOnGoingSummary = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1
) => {
  const { limit, offset } = pagination(page, Math.min(Math.max(Number(size) || 10, 1), 20));

  return Service.findAndCountAll({
    where: {
      is_available: true,
      statusId: 1,
      [Op.and]: [notBlockedLiteral()],
    },
    replacements: { meId },
    limit,
    offset,
    include: serviceSummaryInclude as any,
    order: orderByNewestStable,
    attributes: [
      "id",
      "userId",
      "categoryId",
      "description",
      "rate",
      "currencyCode",
      "currencyPrefix",
      "service_date",
      "statusId",
      applicantsCountSummaryAttribute as any,
    ],
    distinct: true,
  });
};
