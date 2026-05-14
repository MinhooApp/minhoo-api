const readFirstToken = (source: any, keys: string[]): string => {
  for (const key of keys) {
    const value = String(source?.[key] ?? "").trim();
    if (!value) continue;
    if (value.toLowerCase().startsWith("bearer ")) {
      return value.slice(7).trim();
    }
    return value;
  }
  return "";
};

const toPlainObject = (value: any): any => {
  if (!value) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") {
    return { ...value.dataValues };
  }
  return value;
};

export const buildAuthSessionResponseBody = (
  userRaw: any,
  extras?: Record<string, any>
) => {
  const user = toPlainObject(userRaw) ?? {};
  const accessToken = readFirstToken(user, [
    "access_token",
    "accessToken",
    "auth_token",
    "authToken",
    "token",
  ]);
  const refreshToken = readFirstToken(user, [
    "refresh_token",
    "refreshToken",
  ]);
  const userId = Number(user?.id ?? user?.user_id ?? user?.userId ?? 0);
  const normalizedUserId = Number.isFinite(userId) && userId > 0 ? Math.floor(userId) : null;

  const normalizedUser =
    user && typeof user === "object"
      ? {
          ...user,
          access_token: accessToken || null,
          refresh_token: refreshToken || null,
        }
      : user;

  return {
    user: normalizedUser,
    access_token: accessToken || null,
    auth_token: accessToken || null,
    token: accessToken || null,
    refresh_token: refreshToken || null,
    user_id: normalizedUserId,
    session_user_id: normalizedUserId,
    ...(extras && typeof extras === "object" ? extras : {}),
  };
};
