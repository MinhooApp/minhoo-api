import User from "../_models/user/user";

const normalizeUsername = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return value.startsWith("@") ? value : `@${value}`;
};

const normalizeNamePart = (raw: any): string => {
  return String(raw ?? "").trim();
};

export const resolvePushActorLabel = async (userIdRaw: any): Promise<string> => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return "Someone";

  try {
    const user = (await User.findOne({
      where: { id: userId },
      attributes: ["username", "name", "last_name"],
      raw: true,
    })) as {
      username?: string | null;
      name?: string | null;
      last_name?: string | null;
    } | null;

    const username = normalizeUsername(user?.username);
    if (username) return username;

    const fullName = `${normalizeNamePart(user?.name)} ${normalizeNamePart(user?.last_name)}`.trim();
    if (fullName) return fullName;
  } catch (_error) {
    return "Someone";
  }

  return "Someone";
};
