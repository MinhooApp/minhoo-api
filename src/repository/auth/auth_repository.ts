import User from "../../_models/user/user";
import Role from "../../_models/role/role";
import Plan from "../../_models/plan/plan";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import generarJWT from "../../libs/helper/generate_jwt";
const excludeKeys = ["createdAt", "updatedAt", "password"];
import Verification from "../../_models/verification/verification";
interface JWTOptions {
  userId: number | null;
  uuid: String;
  workerId?: number | null;
  name?: string;
  username?: string;
  roles?: number[];
} //
const userIncludes = [
  {
    model: Role,
    as: "roles",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
  },
  {
    model: Worker,
    as: "worker",
    attributes: { exclude: excludeKeys },
    include: [
      {
        model: Category,
        as: "categories",
        attributes: {
          exclude: excludeKeys,
        },
        through: { attributes: [] },
      },
    ],
  },
  {
    model: Category,
    as: "categories",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
  },
  {
    model: Plan,
    as: "plan",
    attributes: { exclude: excludeKeys },
  },
];
export const add = async (body: any) => {
  const user = await User.create(body);
  await user.addRole(body.roles);
  await user.addCategory(body.categories);
  const result = await User.findOne({
    where: { email: body.email },
    include: userIncludes,
  });
  return result;
};
export const findByEmail = async (email: String) => {
  const user = await User.findOne({
    where: { email: email },
    include: userIncludes,
  });
  return user;
};
export const findById = async (id: number) => {
  const user = await User.findOne({
    where: { id: id },
    include: userIncludes,
  });
  return user;
};
import { Op } from "sequelize";
//
export const findByEmailAndCode = async (email: string, code: string) => {
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000); // Calcula la fecha/hora de hace 10 minutos

  const user = await User.findOne({
    where: {
      email: email,
      temp_code: code,
      created_temp_code: {
        [Op.gte]: tenMinutesAgo, // Verifica que created_temp_code sea mayor o igual a hace 10 minutos
      },
    },
    include: userIncludes,
  });

  return user;
};

//
export const saveToken = async ({
  userId: userId,
  uuid: uuid,
  roles,
  workerId,
}: JWTOptions) => {
  ///Genero el token
  const token = await generarJWT({
    userId: userId,
    roles: roles,
    workerId: workerId,
  });

  const body = { auth_token: token, uuid: uuid };
  console.log("HOLAAA " + uuid);
  const userTemp = await User.findOne({
    where: {
      id: userId,
      available: true,
    },
    include: userIncludes,
  });
  await userTemp?.update(body);

  const user = await User.findOne({
    where: { id: userId, available: true },
    include: userIncludes,
    attributes: {
      exclude: excludeKeys,
    },
  });

  return user;
};
export const registerCode = async (body: any) => {
  const code = await Verification.create(body);
  return code;
};

export const verifyEmailCode = async (email: any, code: any) => {
  const response = await Verification.findOne({
    where: { email: email, code: code },
    order: [["id", "DESC"]],
  });
  await response?.update({ verified: true });
  return response;
};
