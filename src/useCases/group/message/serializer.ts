const toText = (value: any): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? {};

const normalizeSender = (value: any, fallbackId?: number | null) => {
  const sender = toPlain(value);
  const id = toPositiveInt((sender as any)?.id) ?? toPositiveInt(fallbackId) ?? null;
  const name = toText((sender as any)?.name);
  const lastName = toText((sender as any)?.last_name);
  const username = toText((sender as any)?.username);
  const fullName = [name, lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || username || (id ? `User ${id}` : null);
  const avatarUrl =
    toText((sender as any)?.image_profil) ||
    toText((sender as any)?.avatarUrl) ||
    toText((sender as any)?.avatar_url);

  return {
    id,
    name,
    last_name: lastName,
    username,
    display_name: displayName,
    image_profil: avatarUrl,
    avatar_url: avatarUrl,
  };
};

export const serializeGroupMessage = (value: any) => {
  const message = toPlain(value);
  const sender = normalizeSender((message as any)?.sender, (message as any)?.senderId);
  return {
    ...message,
    sender,
    sender_name: sender.display_name,
    sender_username: sender.username,
    sender_avatar_url: sender.avatar_url,
  };
};

export const serializeGroupMessages = (values: any[]) =>
  Array.isArray(values) ? values.map((item) => serializeGroupMessage(item)) : [];
