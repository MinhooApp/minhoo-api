import { Op, Sequelize, UniqueConstraintError } from "sequelize";
import Offer from "../../_models/offer/offer";
import Service from "../../_models/service/service";
import { serviceInclude } from "./service_includes";
import Service_Worker from "../../_models/service/service_worker";
import Worker from "../../_models/worker/worker";
import User from "../../_models/user/user";
import ServiceReport from "../../_models/service/service_report";
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
    attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
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
      applicantsCountSummaryAttribute as any,
    ],
    include: serviceSummaryInclude as any,
    order: [["service_date", "DESC"]],
    limit,
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
      statusId: { [Op.notIn]: canceled ? [1] : [1, 5] },
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

  const where: any = { statusId: { [Op.notIn]: [1, 5] } };
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
    return Service.findAll({
      where: { is_available: true, statusId: 1, userId },
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
    order: [["service_date", "DESC"]],
    attributes: { exclude: excludeKeys },
  });
};

/**
 * Worker - Servicios donde el worker está participando (aplicó),
 * no cancelado/removed (para que no aparezca “pegado”).
 */
export const onGoingWorkers = async (workerId: number, meId: any) => {
  return Service.findAll({
    where: { is_available: true, statusId: 1 },
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          canceled: false,
          removed: false,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
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
  const { limit, offset } = pagination(page, size);
  return Service.findAndCountAll({
    where: { is_available: true, statusId: 1 },
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          canceled: false,
          removed: false,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: orderByNewestStable,
    limit,
    offset,
    distinct: true,
    col: "service.id",
  });
};

/**
 * Worker - Cancelados (para historial / pestaña cancelados)
 */
export const onGoingCanceledWorkers = async (workerId: number, meId: any) => {
  return Service.findAll({
    where: { statusId: 5 },
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
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
  const { limit, offset } = pagination(page, size);
  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { statusId: 5 };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAndCountAll({
    where,
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: orderByNewestStable,
    limit,
    offset,
    distinct: true,
    col: "service.id",
  });
};

/**
 * ✅ Worker - Accepted:
 * IMPORTANTE: accepted true PERO canceled/removed false.
 * Si no haces esto, un accepted-canceled se “cuela” como Accepted.
 */
export const historyWorkers = async (
  workerId: number,
  meId: any,
  dateRange?: ServiceHistoryDateRange
) => {
  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { is_available: true };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAll({
    where,
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          accepted: true,
          canceled: false,
          removed: false,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: orderByNewestStable,
  });
};

export const historyWorkersPaged = async (
  workerId: number,
  meId: any,
  page: any = 0,
  size: any = 10,
  dateRange?: ServiceHistoryDateRange
) => {
  const { limit, offset } = pagination(page, size);
  const serviceDateWhere = buildServiceDateWhere(dateRange);
  const where: any = { is_available: true };
  if (serviceDateWhere) {
    where.service_date = serviceDateWhere;
  }

  return Service.findAndCountAll({
    where,
    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId,
          accepted: true,
          canceled: false,
          removed: false,
          [Op.and]: [notBlockedLiteral()],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: orderByNewestStable,
    limit,
    offset,
    distinct: true,
    col: "service.id",
  });
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

export const finalizedService = async (id: any) => {
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

    const acceptedCount = await Offer.count({
      where: {
        serviceId,
        accepted: true,
        canceled: false,
        removed: false,
      },
      transaction,
    });

    const currentStatusId = Number((service as any).statusId ?? 0);
    const alreadyFinal =
      currentStatusId === SERVICE_STATUS_COMPLETED ||
      currentStatusId === SERVICE_STATUS_CANCELED;

    if (!alreadyFinal) {
      const nextStatusId =
        Number(acceptedCount) > 0
          ? SERVICE_STATUS_COMPLETED
          : SERVICE_STATUS_CANCELED;

      // Atomic transition: no workers accepted => CANCELED, otherwise COMPLETED.
      await service.update({ statusId: nextStatusId }, { transaction });
    }

    await service.reload({ transaction });

    const statusId = Number((service as any).statusId ?? 0);
    const status =
      statusId === SERVICE_STATUS_CANCELED ? "CANCELED" : "COMPLETED";
    const closedAt = new Date(
      (service as any).updatedAt ?? Date.now()
    ).toISOString();

    const fullService = await Service.findOne({
      where: { id: serviceId },
      include: serviceInclude,
      transaction,
    });

    return {
      id: serviceId,
      status,
      statusId,
      acceptedCount: Number(acceptedCount) || 0,
      closedAt,
      alreadyFinal,
      service: fullService,
    };
  });
};

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
  await Service.update({ is_available: false, statusId: 5 }, { where: { id } });
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
    order: [["service_date", "DESC"]],
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
  });
};
