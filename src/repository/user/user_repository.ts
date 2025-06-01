import User from "../../_models/user/user";
import Post from "../../_models/post/post";
import { userIncludes } from "./user_include";
import MediaPost from "../../_models/post/media_post";
import Worker from "../../_models/worker/worker";
import Follower from "../../_models/follower/follower";
import Category from "../../_models/category/category";
import { Op } from "sequelize";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const gets = async () => {
  const user = await User.findAll({
    where: { available: true },
    include: userIncludes,
  });
  return user;
};

export const users = async (page: any = 0, size: any = 10) => {
  let option = {
    limit: +size,
    offset: +page * +size,
  };
  const users = await User.findAndCountAll({
    where: { available: 1 },
    ...option,
    include: userIncludes,
  });
  return users;
};

export const get = async (id: any) => {
  const user = await User.findOne({
    where: { id: id },
    include: [
      ...userIncludes,
      {
        model: Post,
        as: "posts",
        where: { is_delete: false },
        required: false,
        include: [
          {
            model: MediaPost,
            as: "post_media",
            attributes: ["url", "is_img"],
            separate: true, // Importante para ordenar internamente
            order: [["createdAt", "ASC"]],
          },
        ],
      },
    ],
    order: [[{ model: Post, as: "posts" }, "created_date", "DESC"]],
  });
  return user;
};

export const update = async (id: any, body: any) => {
  const userTemp = await User.findOne({
    where: { id: id },
    include: userIncludes,
  });
  const user = await userTemp?.update(body);
  return [user];
};

export const activeAlerts = async (id: any) => {
  const userTemp = await User.findOne({
    where: { id: id },
    include: userIncludes,
  });
  const user = await userTemp?.update({ alert: !userTemp!.alert });
  return user;
};

export const deleteuser = async () => {
  const user = await User.update({}, { where: { available: 1 } });
  return user;
};

export const follows = async (id: any) => {
  const follows = await Follower.findAll({
    attributes: ["id", "userId", "followerId"],
    where: { followerId: id },
    include: [
      {
        model: User,
        as: "following_data",
        attributes: [
          "id",
          "name",
          "last_name",
          "image_profil",
          "verified",
          "rate",
        ],
        include: [
          {
            model: Worker,
            as: "worker",
            attributes: ["id", "rate"],
            include: [
              {
                model: Category,
                as: "categories",
                attributes: ["id", "name", "es_name"],
                through: { attributes: [] },
              },
              {
                model: User,
                as: "personal_data",
                attributes: [
                  "id",
                  "name",
                  "last_name",
                  "image_profil",
                  "verified",
                  "rate",
                ],
              },
            ],
          },
          {
            model: Follower,
            as: "followers",
            //where: Sequelize.literal("`user->followers`.`userId`="),
            attributes: [
              "followerId", // Incluir el ID en la cláusula GROUP BY
            ],
            required: false,
          },
          {
            model: Follower,
            as: "followings",
            // where: Sequelize.literal("`followings`.`followerId`= user.id"),
            attributes: [
              "userId", // Incluir el ID en la cláusula GROUP BY
            ],
            required: false,
          },
        ],
      },
    ],
  });

  return follows;
};
export const followers = async (id: any) => {
  const followers = await Follower.findAll({
    attributes: ["id", "userId", "followerId"],
    where: { userId: id },
    include: [
      {
        model: User,
        as: "follower_data",
        attributes: [
          "id",
          "name",
          "last_name",
          "image_profil",
          "verified",
          "rate",
        ],
        include: [
          {
            model: Worker,
            as: "worker",
            attributes: ["id", "rate"],
            include: [
              {
                model: Category,
                as: "categories",
                attributes: ["id", "name", "es_name"],
                through: { attributes: [] },
              },
              {
                model: User,
                as: "personal_data",
                attributes: [
                  "id",
                  "name",
                  "last_name",
                  "image_profil",
                  "verified",
                  "rate",
                ],
              },
            ],
          },
          {
            model: Follower,
            as: "followers",
            //where: Sequelize.literal("`user->followers`.`userId`="),
            attributes: [
              "followerId", // Incluir el ID en la cláusula GROUP BY
            ],
            required: false,
          },
          {
            model: Follower,
            as: "followings",
            // where: Sequelize.literal("`followings`.`followerId`= user.id"),
            attributes: [
              "userId", // Incluir el ID en la cláusula GROUP BY
            ],
            required: false,
          },
        ],
      },
    ],
  });
  return followers;
};

export const getUuid = async (id: number) => {
  const user = await User.findOne({ where: { id: id, alert: true } });
  //const uuid = user?.map((user) => user!.uuid);
  return user?.uuid;
};
export const findByPhone = async (
  id: number,
  phone: string,
  dialing_code: string
) => {
  const user = await User.findOne({
    where: {
      id: { [Op.ne]: id }, // id distinto al recibido
      phone,
      //  dialing_code,
    },
  });
  return user;
};
export const findNewPhone = async (phone: string) => {
  const user = await User.findOne({
    where: {
      phone,
    },
  });
  return user;
};
