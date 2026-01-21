import crypto from "crypto";
import { Transaction } from "sequelize";
import User from "../_models/user/user";

export async function disableUser(id: number, t?: Transaction) {
  const rotated = crypto.randomUUID();

  const [updated] = await User.update(
    {
      disabled: true,
      available: false,
      auth_token: rotated, // 🔒 fuerza cierre inmediato de sesión
    },
    { where: { id }, transaction: t }
  );

  if (!updated) return null;
  return await User.findOne({
    where: { id },
    attributes: [
      "id",
      "email",
      "available",
      "disabled",
      "verified",
      "auth_token",
      "updatedAt",
      "createdAt",
    ],
    transaction: t,
  });
}

export async function enableUser(id: number, t?: Transaction) {
  const rotated = crypto.randomUUID();

  const [updated] = await User.update(
    {
      disabled: false,
      available: true,
      auth_token: rotated, // 🔁 requiere login nuevo
    },
    { where: { id }, transaction: t }
  );

  if (!updated) return null;
  return await User.findOne({
    where: { id },
    attributes: [
      "id",
      "email",
      "available",
      "disabled",
      "verified",
      "auth_token",
      "updatedAt",
      "createdAt",
    ],
    transaction: t,
  });
}
