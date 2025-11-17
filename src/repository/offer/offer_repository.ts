import { Op, Sequelize } from "sequelize";
import Offer from "../../_models/offer/offer";
import { offerInclude } from "./offer_includes";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const add = async (body: any) => {
  const temp = await Offer.findOne({
    where: { serviceId: body.serviceId, workerId: body.workerId },
  });
  await temp?.destroy();
  const offer = await Offer.create(body);

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
  const offer = await Offer.findAll({
    where: {
      serviceId: serviceId,
      canceled: false,
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
  const offer = await Offer.findOne({
    where: { id: id, canceled: false },
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
  const offerTemp = await Offer.findByPk(id);

  await offerTemp?.destroy();
};
