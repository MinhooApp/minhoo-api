import { worker } from "./../../useCases/worker/get/get";
import { Op, Sequelize } from "sequelize";
import Offer from "../../_models/offer/offer";
import Service from "../../_models/service/service";
import { serviceInclude } from "./service_includes";
import Service_Worker from "../../_models/service/service_worker";
import { workerIncludes } from "repository/worker/worker_includes";
import Worker from "../../_models/worker/worker";
import User from "../../_models/user/user";
import { finalized } from "../../useCases/service/update/update";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const add = async (body: any) => {
  const service = await Service.create(body);
  const response = await Service.findByPk(
    service.id,

    { include: serviceInclude, attributes: { exclude: excludeKeys } }
  );
  return response;
};

export const gets = async () => {
  const service = await Service.findAll({
    where: { is_available: true },
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
  return service;
};

export const history = async (userId?: number, canceled = true) => {
  if (userId != undefined) {
    const service = await Service.findAll({
      where: {
        userId: userId,
        statusId: { [Op.notIn]: canceled ? [1] : [1, 5] },
      },
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
    return service;
  } else {
    const service = await Service.findAll({
      where: {
        statusId: { [Op.notIn]: [1, 5] },
      },
      order: [["service_date", "DESC"]],
    });
    return service;
  }
};
export const historyCanceled = async (userId?: number) => {
  if (userId != undefined) {
    const service = await Service.findAll({
      where: {
        userId: userId,
        statusId: 5,
      },
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
    return service;
  } else {
    const service = await Service.findAll({
      where: {
        statusId: 5,
      },
      order: [["service_date", "DESC"]],
    });
    return service;
  }
};
export const onGoing = async (userId?: number) => {
  if (userId) {
    const service = await Service.findAll({
      where: {
        is_available: true,
        statusId: 1,
        userId: userId,
      },

      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
    return service;
  } else {
    const service = await Service.findAll({
      where: { is_available: true, statusId: 1 },
      include: serviceInclude,
      order: [["service_date", "DESC"]],
    });
    return service;
  }
};
export const getsOnGoing = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1
) => {
  let option = {
    limit: +size,
    offset: +page * +size,
  };
  const services = await Service.findAndCountAll({
    where: {
      is_available: true,
      statusId: 1,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`service\`.\`userId\`)
              OR
              (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    replacements: { meId },
    ...option,
    include: serviceInclude,

    order: [["service_date", "DESC"]],
    attributes: { exclude: excludeKeys },
  });

  return services;
};
export const onGoingWorkers = async (workerId: number, meId: any) => {
  const service = await Service.findAll({
    where: {
      is_available: true,
      statusId: 1,
    },

    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId: workerId,
          canceled: false,
          [Op.and]: [
            Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`service\`.\`userId\`)
              OR
              (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
          ],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: [["service_date", "DESC"]],
  });
  return service;
};
export const onGoingCanceledWorkers = async (workerId: number, meId: any) => {
  const service = await Service.findAll({
    where: {
      statusId: 5,
    },

    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId: workerId,
          [Op.and]: [
            Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`service\`.\`userId\`)
              OR
              (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
          ],
        },

        required: true,
      },
    ],
    replacements: { meId },
    order: [["service_date", "DESC"]],
  });
  return service;
};
export const historyWorkers = async (workerId: number, meId: any) => {
  const service = await Service.findAll({
    where: {
      is_available: true,
      /*[Op.not]: [
        {
          //statusId: 1,
        },
      ],*/
    },

    include: [
      ...serviceInclude,
      {
        model: Offer,
        as: "offers",
        where: {
          workerId: workerId,
          accepted: true,
          [Op.and]: [
            Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`service\`.\`userId\`)
              OR
              (ub.blocker_id = \`service\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
          ],
        },
        required: true,
      },
    ],
    replacements: { meId },
    order: [["service_date", "DESC"]],
  });
  return service;
};
export const get = async (id: any) => {
  const service = await Service.findOne({
    where: { id: id },
    include: serviceInclude,
  });
  return service;
};
export const getByUser = async (id: any, userId: any) => {
  const service = await Service.findOne({
    where: { id: id, userId: userId },
    include: serviceInclude,
    order: [["service_date", "DESC"]],
  });
  return service;
};

export const workersByService = async (id: any, userId: any) => {
  const service = await Service.findOne({
    where: {
      id: id,
    },
    include: [
      {
        model: Offer,
        as: "offers",
        where: {
          accepted: true,
        },
        required: true,
        include: [
          {
            model: Worker,
            as: "offerer",
            include: [
              {
                model: User,
                as: "personal_data",
              },
            ],
          },
        ],
      },
    ],
    order: [["service_date", "DESC"]],
  });

  if (!service || !service.offers) return [];

  const offerers = service.offers
    .map((offer: any) => offer.offerer)
    .filter((offerer: any) => !!offerer); // por si acaso

  return offerers;
};

export const update = async (id: any, body: any) => {
  const serviceTemp = await Service.findByPk(id);
  const service = await serviceTemp?.update(body);
  return [service];
}; //
export const assignWorker = async (
  workerId: any,
  request: Service,
  assigend: boolean
) => {
  // const serviceTemp = await Service.findByPk(id,);

  await request.addWorker(workerId, { through: { removed: false } });
  if (assigend) {
    await request.update({ statusId: 2 });
  }
  const service = await Service_Worker.findOne({
    where: { serviceId: request.id, workerId: workerId },
  });
  return service;
};
export const removeWorker = async (serviceId: any, workerId: any) => {
  // const serviceTemp = await Service.findByPk(id,);
  const temp = await Service_Worker.findOne({
    where: { serviceId: serviceId, workerId: workerId },
  });
  const worker = temp?.update({ removed: true, canceled: false });

  return worker;
};
export const finalizedService = async (id: any) => {
  const serviceTemp = await Service.findByPk(id);
  await serviceTemp!.update({ statusId: 2 });
  const service = await Service.findOne({
    where: { id: id },
    include: serviceInclude,
  });
  return service;
};
export const cancelWorker = async (
  serviceId: any,
  workerId: any,
  removed: boolean
) => {
  // const serviceTemp = await Service.findByPk(id,);
  const temp = await Offer.findOne({
    where: { serviceId: serviceId, workerId: workerId },
  });
  const worker = temp?.update({ removed: removed, canceled: true });

  return worker;
};

export const deleteservice = async (id: any) => {
  await Service.update(
    { is_available: false, statusId: 5 },
    { where: { id: id } }
  );
};
