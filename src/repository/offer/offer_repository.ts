import { Op, Sequelize } from "sequelize";
import Offer from "../../_models/offer/offer";
import Worker from "../../_models/worker/worker";
import { offerInclude, offerListInclude } from "./offer_includes";

const excludeKeys = ["createdAt", "updatedAt", "password"];

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
  if (directWorkerId) ids.add(directWorkerId);

  const userId = toPositiveInt(userIdRaw);
  if (!userId) return [...ids];

  const rows = await Worker.findAll({
    where: { userId },
    attributes: ["id"],
    raw: true,
  });

  for (const row of rows as any[]) {
    const workerId = toPositiveInt((row as any)?.id);
    if (workerId) ids.add(workerId);
  }

  return [...ids];
};

export const add = async (body: any) => {
  // ✅ Si existe una offer previa para (serviceId, workerId),
  // la reactivamos como Applicant:
  // - sale de Cancelled
  // - vuelve a Applicants
  const existing = await Offer.findOne({
    where: { serviceId: body.serviceId, workerId: body.workerId },
  });

  if (existing) {
    const updated = await existing.update({
      ...body,
      accepted: false,
      canceled: false,
      removed: false,
    });
    return updated;
  }

  // ✅ Nueva postulación
  const offer = await Offer.create({
    ...body,
    accepted: false,
    canceled: false,
    removed: false,
  });

  return offer;
};

export const gets = async (workerIdRaw?: any, userIdRaw?: any) => {
  const workerIds = await resolveWorkerIdsForUser(workerIdRaw, userIdRaw);
  if (!workerIds.length) return [];

  const offer = await Offer.findAll({
    where: {
      workerId: workerIds.length === 1 ? workerIds[0] : { [Op.in]: workerIds },
      canceled: false,
      removed: false,
    },
    include: offerListInclude,
    attributes: { exclude: excludeKeys },
    order: [["offer_date", "DESC"]],
  });
  return offer;
};

export const getsByService = async (serviceId: any) => {
  // ✅ CLAVE DEL FLUJO:
  // - NO filtrar canceled/removed aquí.
  // - Porque este endpoint alimenta Applicants / Accepted / Cancelled.
  // - El frontend decide en cuál pestaña cae cada offer.
  const offer = await Offer.findAll({
    where: {
      serviceId: serviceId,

      // ✅ Mantengo tu filtro de bloqueados (correcto)
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            JOIN workers w ON w.id = \`offer\`.\`workerId\`
            JOIN services s ON s.id = \`offer\`.\`serviceId\`
            WHERE
              (ub.blocker_id = w.userId AND ub.blocked_id = s.userId)
              OR
              (ub.blocker_id = s.userId AND ub.blocked_id = w.userId)
          )
        `),
      ],
    },
    include: offerListInclude,
    attributes: { exclude: excludeKeys },
    order: [["offer_date", "DESC"]],
  });

  return offer;
};

export const get = async (id: any) => {
  // ✅ No filtramos canceled/removed para que pueda verse en historial/detalle
  const offer = await Offer.findOne({
    where: { id: id },
    include: offerInclude,
    attributes: { exclude: excludeKeys },
    order: [["offer_date", "DESC"]],
  });
  return offer;
};

export const update = async (id: any, body: any) => {
  const offerTemp = await Offer.findByPk(id);
  const offer = await offerTemp?.update(body);
  return offer;
};

export const deleteoffer = async (id: any) => {
  // ✅ NO destruir.
  // En tu flujo "cliente cancela" debe mover a Cancelled:
  // removed=true (y accepted=false)
  const offerTemp = await Offer.findByPk(id);
  if (!offerTemp) return null;

  const updated = await offerTemp.update({
    accepted: false,
    removed: true,
    canceled: false, // opcional; Cancelled lo definimos por removed || canceled
  });

  return updated;
};
