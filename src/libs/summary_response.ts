import { AppLocale } from "./localization/locale";
import { formatRelativeTime } from "./localization/relative_time";

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? null;

const toText = (value: any) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const toBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const truncateText = (value: any, max = 120) => {
  const text = toText(value);
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
};

const toIsoDate = (value: any) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toCount = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const toUserSummary = (userRaw: any) => {
  const user = toPlain(userRaw);
  if (!user) return null;
  const username = toText(user.username ?? user.user_name);
  const activeOrbitReelId =
    Number(user.active_orbit_reel_id ?? user.activeOrbitReelId ?? 0) || null;
  const orbitRingUntil = toIsoDate(user.orbit_ring_until ?? user.orbitRingUntil);
  const explicitHasActiveOrbit = toBoolOrNull(
    user.has_active_orbit ??
      user.hasActiveOrbit ??
      user.has_orbit_ring ??
      user.hasOrbitRing
  );
  const hasActiveOrbit =
    explicitHasActiveOrbit ??
    Boolean(activeOrbitReelId && orbitRingUntil && new Date(orbitRingUntil).getTime() > Date.now());

  return {
    id: Number(user.id ?? 0) || null,
    username,
    name: [toText(user.name), toText(user.last_name)].filter(Boolean).join(" ") || null,
    avatar: toText(user.image_profil),
    verified: Boolean(user.verified),
    has_active_orbit: hasActiveOrbit,
    hasActiveOrbit: hasActiveOrbit,
    has_orbit_ring: hasActiveOrbit,
    hasOrbitRing: hasActiveOrbit,
    active_orbit_reel_id: hasActiveOrbit ? activeOrbitReelId : null,
    activeOrbitReelId: hasActiveOrbit ? activeOrbitReelId : null,
    orbit_ring_until: hasActiveOrbit ? orbitRingUntil : null,
    orbitRingUntil: hasActiveOrbit ? orbitRingUntil : null,
  };
};

const pickPrimaryMedia = (itemsRaw: any) => {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const item = items[0] ? toPlain(items[0]) : null;
  if (!item) return null;
  return {
    url: toText(item.url ?? item.mediaUrl),
    is_image: Boolean(item.is_img ?? item.isImage ?? false),
  };
};

const buildCounts = (source: any, extra?: Record<string, number>) => ({
  likes: toCount(source?.likes_count ?? source?.likes?.length),
  comments: toCount(source?.comments_count ?? source?.comments?.length),
  saves: toCount(source?.saved_count ?? source?.savedCount ?? source?.saves_count),
  shares: toCount(source?.shares_count),
  ...(extra ?? {}),
});

const summarizeMessage = (messageRaw: any, locale: AppLocale = "en") => {
  const message = toPlain(messageRaw);
  if (!message) return null;
  const dateIso = toIsoDate(message.date ?? message.createdAt ?? message.updatedAt);
  const relativeTime = formatRelativeTime(dateIso, locale);
  return {
    id: Number(message.id ?? 0) || null,
    text: truncateText(message.text, 90),
    type: toText(message.messageType ?? message.message_type) ?? "text",
    senderId: Number(message.senderId ?? 0) || null,
    date: dateIso,
    status: toText(message.status),
    mediaUrl: toText(message.mediaUrl),
    relativeTime,
    relative_time: relativeTime,
  };
};

export const isSummaryMode = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

export const toPostSummary = (postRaw: any, viewerIdRaw?: any) => {
  const post = toPlain(postRaw);
  const viewerId = Number(viewerIdRaw ?? 0);
  const likes = Array.isArray(post?.likes) ? post.likes : [];
  return {
    id: Number(post?.id ?? 0) || null,
    excerpt: truncateText(post?.post, 140),
    createdAt: toIsoDate(post?.created_date ?? post?.createdAt ?? post?.updatedAt),
    counts: buildCounts(post),
    media: pickPrimaryMedia(post?.post_media),
    author: toUserSummary(post?.user),
    liked:
      Boolean(post?.is_liked ?? post?.isLiked) ||
      likes.some((like: any) => Number(like?.userId) === viewerId),
    saved: Boolean(post?.is_saved),
  };
};

export const toReelSummary = (reelRaw: any) => {
  const reel = toPlain(reelRaw);
  return {
    id: Number(reel?.id ?? 0) || null,
    description: truncateText(reel?.description, 140),
    thumbnail_url: toText(reel?.thumbnail_url),
    stream_url: toText(reel?.stream_url),
    video_uid: toText(reel?.video_uid),
    createdAt: toIsoDate(reel?.createdAt ?? reel?.updatedAt),
    counts: {
      likes: toCount(reel?.likes_count),
      comments: toCount(reel?.comments_count),
      saves: toCount(reel?.saves_count),
      views: toCount(reel?.views_count),
    },
    creator: toUserSummary(reel?.user),
  };
};

export const toServiceSummary = (serviceRaw: any) => {
  const service = toPlain(serviceRaw);
  const categoryName = toText(service?.category?.name ?? service?.category?.es_name);
  const description = truncateText(service?.description, 120);
  const currency = toText(service?.currencyPrefix ?? service?.currency_prefix) ?? "";
  const rate = Number(service?.rate);
  const price = Number.isFinite(rate) ? `${currency}${rate}`.trim() : null;
  const provider =
    toUserSummary(service?.client) ??
    toUserSummary(service?.workers?.[0]?.personal_data) ??
    toUserSummary(service?.offers?.[0]?.offerer?.personal_data);

  return {
    id: Number(service?.id ?? 0) || null,
    title: categoryName ?? description,
    short_description: description,
    price,
    thumbnail:
      toText(provider?.avatar) ??
      toText(service?.offers?.[0]?.offerer?.personal_data?.image_profil) ??
      null,
    provider,
    status:
      toText(service?.status?.status ?? service?.status?.name ?? service?.status?.description) ??
      toText(service?.statusId),
    createdAt: toIsoDate(service?.service_date ?? service?.createdAt),
  };
};

const buildNotificationTarget = (notification: any) => {
  if (notification?.post) {
    return {
      kind: "post",
      id: Number(notification.post.id ?? 0) || null,
      excerpt: truncateText(notification.post?.post, 100),
      media: pickPrimaryMedia(notification.post?.post_media),
    };
  }

  if (notification?.reel) {
    return {
      kind: "reel",
      id: Number(notification.reel.id ?? 0) || null,
      excerpt: truncateText(notification.reel?.description, 100),
      thumbnail: toText(notification.reel?.thumbnail_url),
    };
  }

  if (notification?.service) {
    return {
      kind: "service",
      id: Number(notification.service.id ?? 0) || null,
      excerpt: truncateText(notification.service?.description, 100),
      rate: Number(notification.service?.rate ?? 0) || null,
    };
  }

  if (notification?.message_received) {
    return {
      kind: "message",
      id: Number(notification.message_received.id ?? 0) || null,
      excerpt: truncateText(notification.message_received?.text, 80),
    };
  }

  if (notification?.offer) {
    return {
      kind: "offer",
      id: Number(notification.offer.id ?? 0) || null,
      serviceId: Number(notification.offer.serviceId ?? 0) || null,
    };
  }

  return null;
};

export const toNotificationSummary = (
  notificationRaw: any,
  locale: AppLocale = "en"
) => {
  const notification = toPlain(notificationRaw);
  const createdAt = toIsoDate(notification?.notification_date ?? notification?.createdAt);
  const relativeTime = formatRelativeTime(createdAt, locale);
  return {
    id: Number(notification?.id ?? 0) || null,
    type: toText(notification?.type),
    createdAt,
    relativeTime,
    relative_time: relativeTime,
    actor: toUserSummary(notification?.interactor),
    target: buildNotificationTarget(notification),
    read: Boolean(notification?.read),
  };
};

export const toFollowSummary = (entryRaw: any) => {
  const entry = toPlain(entryRaw);
  const user = entry?.user ? toPlain(entry.user) : toPlain(entry?.following_data ?? entry?.follower_data);
  const id = Number(user?.id ?? entry?.id ?? 0) || null;
  const name = toText(user?.name);
  const lastName = toText(user?.last_name);
  const fullName = [name, lastName].filter(Boolean).join(" ") || null;
  const username = toText(user?.username ?? user?.user_name);
  const avatar = toText(user?.image_profil);
  const verified = Boolean(user?.verified);
  const compactUser = {
    id,
    name,
    last_name: lastName,
    full_name: fullName,
    username,
    user_name: username,
    avatar,
    image_profil: avatar,
    verified,
  };
  const activeOrbitReelId =
    Number(user?.active_orbit_reel_id ?? user?.activeOrbitReelId ?? 0) || null;
  const orbitRingUntil = toIsoDate(user?.orbit_ring_until ?? user?.orbitRingUntil);
  const explicitHasActiveOrbit = toBoolOrNull(
    user?.has_active_orbit ??
      user?.hasActiveOrbit ??
      user?.has_orbit_ring ??
      user?.hasOrbitRing
  );
  const hasActiveOrbit =
    explicitHasActiveOrbit ??
    Boolean(activeOrbitReelId && orbitRingUntil && new Date(orbitRingUntil).getTime() > Date.now());

  return {
    id,
    name,
    last_name: lastName,
    full_name: fullName,
    username,
    user_name: username,
    avatar,
    image_profil: avatar,
    user: compactUser,
    following_data: compactUser,
    follower_data: compactUser,
    has_active_orbit: hasActiveOrbit,
    hasActiveOrbit: hasActiveOrbit,
    has_orbit_ring: hasActiveOrbit,
    hasOrbitRing: hasActiveOrbit,
    active_orbit_reel_id: hasActiveOrbit ? activeOrbitReelId : null,
    activeOrbitReelId: hasActiveOrbit ? activeOrbitReelId : null,
    orbit_ring_until: hasActiveOrbit ? orbitRingUntil : null,
    orbitRingUntil: hasActiveOrbit ? orbitRingUntil : null,
    flags: {
      verified,
      isMutual: Boolean(entry?.isMutual),
      viewerFollowsUser: Boolean(entry?.viewerFollowsUser),
      userFollowsViewer: Boolean(entry?.userFollowsViewer),
    },
  };
};

export const toChatSummary = (chatRowRaw: any, locale: AppLocale = "en") => {
  const row = toPlain(chatRowRaw);
  const chat = toPlain(row?.Chat);
  const otherUser = Array.isArray(chat?.users) ? chat.users[0] : null;
  const lastMessage = Array.isArray(chat?.messages) ? chat.messages[0] : null;
  const updatedAt = toIsoDate(
    lastMessage?.date ?? row?.updatedAt ?? chat?.updatedAt ?? row?.createdAt
  );
  const relativeTime = formatRelativeTime(updatedAt, locale);
  return {
    chatId: Number(row?.chatId ?? chat?.id ?? 0) || null,
    lastMessage: summarizeMessage(lastMessage, locale),
    unreadCount: toCount(chat?.unreadCount ?? row?.unreadCount),
    updatedAt,
    relativeTime,
    relative_time: relativeTime,
    user: toUserSummary(otherUser),
  };
};

export const toChatMessageSummary = (messageRaw: any, locale: AppLocale = "en") => {
  const message = summarizeMessage(messageRaw, locale);
  const raw = toPlain(messageRaw);
  return {
    ...message,
    sender: toUserSummary(raw?.sender),
    replyToMessageId: Number(raw?.replyToMessageId ?? 0) || null,
  };
};
