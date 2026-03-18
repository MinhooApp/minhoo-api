const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const toIsoDate = (value: any): string | null => {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
};

const toLastMessage = (value: any) => {
  if (!value || typeof value !== "object") return null;
  const message = toPlain(value);

  const id = toPositiveInt((message as any)?.id);
  const chatId = toPositiveInt((message as any)?.chatId ?? (message as any)?.chat_id);
  const senderId = toPositiveInt(
    (message as any)?.senderId ?? (message as any)?.sender_id
  );
  const messageType = toText(
    (message as any)?.messageType ?? (message as any)?.message_type
  );

  if (!id || !chatId || !senderId || !messageType) {
    return null;
  }

  return {
    id,
    chatId,
    senderId,
    text: toText((message as any)?.text),
    messageType,
    mediaUrl: toText((message as any)?.mediaUrl ?? (message as any)?.media_url),
    mediaMime: toText((message as any)?.mediaMime ?? (message as any)?.media_mime),
    date: toIsoDate((message as any)?.date),
    status: toText((message as any)?.status),
    replyToMessageId: toPositiveInt(
      (message as any)?.replyToMessageId ?? (message as any)?.reply_to_message_id
    ),
  };
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
  const lastMessage = toLastMessage(
    (group as any)?.lastMessage ?? (group as any)?.last_message
  );
  const fallbackInteractionDate = toIsoDate(
    (group as any)?.updatedAt ?? (group as any)?.createdAt ?? null
  );
  const lastInteractionAt =
    toIsoDate(
      (group as any)?.lastInteractionAt ??
        (group as any)?.last_interaction_at ??
        (lastMessage as any)?.date
    ) ?? fallbackInteractionDate;

  const name = toText((group as any)?.name) || null;
  const id = toPositiveInt((group as any)?.id);
  const membershipStatus =
    toText((group as any)?.membershipStatus ?? (group as any)?.membership_status) ||
    "member";
  const pendingRequestId = toPositiveInt(
    (group as any)?.pendingRequestId ?? (group as any)?.pending_request_id
  );
  const pendingRequestStatus = toText(
    (group as any)?.pendingRequestStatus ?? (group as any)?.pending_request_status
  );
  const pendingRequestAt = toIsoDate(
    (group as any)?.pendingRequestAt ?? (group as any)?.pending_request_at
  );
  const canViewChatRaw = (group as any)?.canViewChat ?? (group as any)?.can_view_chat;
  const canInteractRaw = (group as any)?.canInteract ?? (group as any)?.can_interact;
  const canViewChat =
    typeof canViewChatRaw === "boolean"
      ? canViewChatRaw
      : membershipStatus === "pending"
      ? false
      : null;
  const canInteract =
    typeof canInteractRaw === "boolean"
      ? canInteractRaw
      : membershipStatus === "pending"
      ? false
      : null;

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
    groupDescription: toText((group as any)?.description),
    group_description: toText((group as any)?.description),
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
    membershipStatus,
    membership_status: membershipStatus,
    is_pending: membershipStatus === "pending",
    pendingRequestId,
    pending_request_id: pendingRequestId,
    pendingRequestStatus,
    pending_request_status: pendingRequestStatus,
    pendingRequestAt,
    pending_request_at: pendingRequestAt,
    canViewChat,
    can_view_chat: canViewChat,
    canInteract,
    can_interact: canInteract,
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
    lastMessage,
    last_message: lastMessage,
    lastInteractionAt,
    last_interaction_at: lastInteractionAt,
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
