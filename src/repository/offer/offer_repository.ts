import { Op, Sequelize } from "sequelize";
import Offer from "../../_models/offer/offer";
import { offerInclude } from "./offer_includes";

const excludeKeys = ["createdAt", "updatedAt", "password"];

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

export const gets = async () => {
  const offer = await Offer.findAll({
    where: {},
    include: offerInclude,
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
    include: offerInclude,
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
