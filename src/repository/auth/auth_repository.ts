import User from "../../_models/user/user";
import Role from "../../_models/role/role";
import Plan from "../../_models/plan/plan";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import generarJWT from "../../libs/helper/generate_jwt";
const excludeKeys = ["createdAt", "updatedAt", "password"];
import Verification from "../../_models/verification/verification";
import {
  registerUserAuthSession,
  revokeAuthSessionsByDeviceUuid,
} from "../../libs/auth/user_auth_session";
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
    where: { available: true },
    required: false,
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
const loginIncludes = [
  {
    model: Role,
    as: "roles",
    attributes: ["id"],
    through: { attributes: [] },
  },
  {
    model: Worker,
    as: "worker",
    where: { available: true },
    required: false,
    attributes: ["id"],
  },
];

const sanitizeSignUpDraft = (input: any) => {
  const body = { ...(input ?? {}) };
  const fieldsToNull = [
    "dialing_code",
    "iso_code",
    "phone",
    "language",
    "language_ids",
    "language_codes",
    "language_names",
    "countryId",
    "cityId",
    "country_origin_id",
    "country_origin_code",
    "country_residence_id",
    "state_residence_id",
    "state_residence_code",
    "city_residence_id",
    "city_residence_name",
    "last_longitude",
    "last_latitude",
  ];

  for (const key of fieldsToNull) {
    body[key] = null;
  }

  return body;
};
export const add = async (body: any) => {
  const sanitizedBody = sanitizeSignUpDraft(body);
  const user = await User.create(sanitizedBody);
  await user.addRole(sanitizedBody.roles);
  await user.addCategory(sanitizedBody.categories);
  const result = await User.findOne({
    where: { email: sanitizedBody.email },
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
export const findByEmailForLogin = async (email: string) => {
  const user = await User.findOne({
    where: { email },
    attributes: ["id", "email", "password", "is_deleted", "disabled", "available"],
    include: loginIncludes,
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
  const currentUser = await User.findOne({
    where: { id: userId },
    attributes: ["auth_token", "uuid"],
    raw: true,
  });
  const previousAuthToken = String((currentUser as any)?.auth_token ?? "").trim();
  const previousDeviceUuid = String((currentUser as any)?.uuid ?? "").trim();

  ///Genero el token
  const token = await generarJWT({
    userId: userId,
    roles: roles,
    workerId: workerId,
  });

  const normalizedUuid = String(uuid ?? "").trim();
  if (normalizedUuid) {
    // Un mismo token de dispositivo solo debe pertenecer a una cuenta activa.
    await User.update(
      { uuid: null },
      {
        where: {
          uuid: normalizedUuid,
          id: { [Op.ne]: userId },
        },
      }
    );
    await revokeAuthSessionsByDeviceUuid(normalizedUuid, {
      excludeUserId: Number(userId),
    });
  }

  const body: any = { auth_token: token };
  if (normalizedUuid) body.uuid = normalizedUuid;

  await User.update(body, {
    where: {
      id: userId,
      available: true,
    },
  });

  await registerUserAuthSession(userId, token, {
    deviceUuid: normalizedUuid || null,
  });

  const sameDeviceTokenRotation =
    Boolean(normalizedUuid) &&
    Boolean(previousDeviceUuid) &&
    previousDeviceUuid === normalizedUuid;
  if (previousAuthToken && previousAuthToken !== token && !sameDeviceTokenRotation) {
    const previousSessionDeviceUuid =
      previousDeviceUuid && previousDeviceUuid !== normalizedUuid
        ? previousDeviceUuid
        : null;
    await registerUserAuthSession(userId, previousAuthToken, {
      deviceUuid: previousSessionDeviceUuid,
    });
  }

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
