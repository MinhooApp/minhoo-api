const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const toText = (value: any): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? {};

const normalizeOwner = (ownerRaw: any, fallbackOwnerUserId?: number | null) => {
  const owner = toPlain(ownerRaw);
  const id =
    toPositiveInt((owner as any)?.id) ?? toPositiveInt(fallbackOwnerUserId) ?? null;
  const name = toText((owner as any)?.name);
  const lastName = toText((owner as any)?.last_name);
  const username = toText((owner as any)?.username);
  const fullName = [name, lastName].filter(Boolean).join(" ").trim();
  const displayName = fullName || username || (id ? `User ${id}` : null);
  const avatarUrl =
    toText((owner as any)?.image_profil) ||
    toText((owner as any)?.avatar_url) ||
    toText((owner as any)?.avatarUrl);

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

export const serializeGroup = (
  groupRaw: any,
  opts?: {
    activeMembers?: number | null;
    unreadCount?: number | null;
  }
) => {
  const group = toPlain(groupRaw);
  const owner = normalizeOwner((group as any)?.owner, (group as any)?.ownerUserId);
  const groupAvatar =
    toText((group as any)?.avatarUrl) ||
    toText((group as any)?.avatar_url) ||
    owner.avatar_url;

  const name = toText((group as any)?.name) || null;
  const id = toPositiveInt((group as any)?.id);

  return {
    ...group,
    id,
    ownerUserId: toPositiveInt((group as any)?.ownerUserId),
    owner_user_id: toPositiveInt((group as any)?.ownerUserId),
    ownerUsername: toText((group as any)?.ownerUsername),
    owner_username: toText((group as any)?.ownerUsername),
    name,
    display_name: name || (id ? `Group ${id}` : null),
    description: toText((group as any)?.description),
    avatarUrl: groupAvatar,
    avatar_url: groupAvatar,
    display_avatar_url: groupAvatar,
    chatId: toPositiveInt((group as any)?.chatId),
    chat_id: toPositiveInt((group as any)?.chatId),
    maxMembers: toPositiveInt((group as any)?.maxMembers),
    max_members: toPositiveInt((group as any)?.maxMembers),
    joinMode: toText((group as any)?.joinMode),
    join_mode: toText((group as any)?.joinMode),
    writeMode: toText((group as any)?.writeMode),
    write_mode: toText((group as any)?.writeMode),
    isActive: Boolean((group as any)?.isActive),
    is_active: Boolean((group as any)?.isActive),
    active_members:
      opts && typeof opts.activeMembers === "number" && Number.isFinite(opts.activeMembers)
        ? Math.max(0, Math.trunc(opts.activeMembers))
        : null,
    unread_count:
      opts && typeof opts.unreadCount === "number" && Number.isFinite(opts.unreadCount)
        ? Math.max(0, Math.trunc(opts.unreadCount))
        : 0,
    owner,
  };
};

export const serializeGroups = (
  groups: any[],
  activeMembersByGroupId?: Map<number, number>,
  unreadByGroupId?: Map<number, number>
) =>
  Array.isArray(groups)
    ? groups.map((group) => {
        const plain = toPlain(group);
        const gid = toPositiveInt((plain as any)?.id) ?? -1;
        return serializeGroup(group, {
          activeMembers:
            activeMembersByGroupId && activeMembersByGroupId.has(gid)
              ? Number(activeMembersByGroupId.get(gid))
              : null,
          unreadCount:
            unreadByGroupId && unreadByGroupId.has(gid)
              ? Number(unreadByGroupId.get(gid))
              : 0,
        });
      })
    : [];
