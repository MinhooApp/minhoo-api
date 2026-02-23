const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const toIsoDateString = (value: any): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toText = (value: any): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? {};

const normalizeUser = (value: any, fallbackUserId?: number | null) => {
  const user = toPlain(value);
  const id = toPositiveInt((user as any)?.id) ?? toPositiveInt(fallbackUserId) ?? null;
  const firstName = toText((user as any)?.name);
  const lastName = toText((user as any)?.last_name);
  const username = toText((user as any)?.username);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || username || null;
  const avatarUrl =
    toText((user as any)?.image_profil) ||
    toText((user as any)?.avatarUrl) ||
    toText((user as any)?.avatar_url);

  return {
    id,
    name: firstName,
    last_name: lastName,
    username,
    full_name: fullName || null,
    display_name: displayName,
    image_profil: avatarUrl,
    avatar_url: avatarUrl,
  };
};

export const serializeJoinRequest = (value: any) => {
  const row = toPlain(value);
  const requestUser = normalizeUser((row as any)?.request_user, (row as any)?.userId);
  const reviewerUser = normalizeUser(
    (row as any)?.reviewer_user,
    (row as any)?.reviewedByUserId
  );

  return {
    ...row,
    group_id: toPositiveInt((row as any)?.groupId),
    user_id: toPositiveInt((row as any)?.userId),
    invite_id: toPositiveInt((row as any)?.inviteId),
    reviewed_by_user_id: toPositiveInt((row as any)?.reviewedByUserId),
    created_at: toIsoDateString((row as any)?.createdAt),
    updated_at: toIsoDateString((row as any)?.updatedAt),
    reviewed_at: toIsoDateString((row as any)?.reviewedAt),
    request_user: requestUser,
    reviewer_user: reviewerUser,
    applicant: requestUser,
    reviewer: reviewerUser,
    applicant_name: requestUser.full_name || requestUser.name || null,
    applicant_username: requestUser.username,
    applicant_avatar_url: requestUser.avatar_url,
    reviewer_name: reviewerUser.full_name || reviewerUser.name || null,
    reviewer_username: reviewerUser.username,
    reviewer_avatar_url: reviewerUser.avatar_url,
  };
};

export const serializeJoinRequests = (values: any[]) =>
  Array.isArray(values) ? values.map((item) => serializeJoinRequest(item)) : [];
