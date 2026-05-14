import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { createHash } from "crypto";
import {
  emitChatStatusRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { serializeMessagesToCanonical } from "../_shared/message_contract";
import {
  isSummaryMode,
  toChatMessageSummary,
  toChatSummary,
} from "../../../libs/summary_response";
import * as followerRepo from "../../../repository/follower/follower_repository";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

const buildWeakEtag = (payload: any) => {
  const hash = createHash("sha1").update(JSON.stringify(payload ?? {})).digest("hex");
  return `W/"${hash}"`;
};

const isEtagFresh = (req: Request, etag: string): boolean => {
  const raw = String(req.headers["if-none-match"] ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const tags = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tags.includes(etag);
};

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const toOptionalPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? null;

const buildCounterpartPermissions = (isAdminCounterpart: boolean) => ({
  can_open_counterpart_profile: !isAdminCounterpart,
  canOpenCounterpartProfile: !isAdminCounterpart,
  can_report_counterpart: !isAdminCounterpart,
  canReportCounterpart: !isAdminCounterpart,
  can_follow_counterpart: !isAdminCounterpart,
  canFollowCounterpart: !isAdminCounterpart,
  can_open_more: !isAdminCounterpart,
  canOpenMore: !isAdminCounterpart,
  show_more_actions: !isAdminCounterpart,
  showMoreActions: !isAdminCounterpart,
});

const buildCounterpartPayload = (params: {
  userRaw: any;
  fallbackUserIdRaw: any;
  isAdminCounterpart: boolean;
}) => {
  const user = toPlain(params.userRaw) ?? {};
  const fallbackUserId = toOptionalPositiveInt(params.fallbackUserIdRaw);
  const userId = toOptionalPositiveInt((user as any)?.id) ?? fallbackUserId;
  const defaultName = params.isAdminCounterpart ? "Soporte" : "";
  const defaultLastName = params.isAdminCounterpart ? "Minhoo" : "";
  const name =
    String((user as any)?.name ?? "").trim() || defaultName;
  const lastName =
    String((user as any)?.last_name ?? (user as any)?.lastName ?? "").trim() || defaultLastName;
  const usernameRaw = params.isAdminCounterpart
    ? ""
    : String((user as any)?.username ?? "").trim();
  const imageProfil = String((user as any)?.image_profil ?? "").trim() || null;
  const canInteract = !params.isAdminCounterpart;
  const roles = params.isAdminCounterpart
    ? [{ id: 8088, role: "admin", description: "admin role" }]
    : Array.isArray((user as any)?.roles)
    ? (user as any).roles
    : [];

  return {
    id: userId,
    user_type: params.isAdminCounterpart ? "admin" : "user",
    is_admin: params.isAdminCounterpart,
    isAdmin: params.isAdminCounterpart,
    roles,
    name: name || null,
    last_name: lastName || "",
    username: usernameRaw || null,
    image_profil: imageProfil,
    can_open_profile: canInteract,
    canOpenProfile: canInteract,
    can_report: canInteract,
    canReport: canInteract,
    can_follow: canInteract,
    canFollow: canInteract,
    can_open_more: canInteract,
    canOpenMore: canInteract,
    show_more_actions: canInteract,
    showMoreActions: canInteract,
  };
};

const enrichChatSummariesWithCounterpartPermissions = async (itemsRaw: any[]) => {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const counterpartIds = Array.from(
    new Set(
      items
        .map((item: any) => toOptionalPositiveInt((item as any)?.user?.id))
        .filter((id): id is number => Boolean(id))
    )
  );
  const adminMap = await userRepository.getAdminRoleMapByUserIds(counterpartIds);

  items.forEach((item: any) => {
    const user = (item as any)?.user ?? null;
    const userId = toOptionalPositiveInt((user as any)?.id);
    const isAdminCounterpart = userId ? Boolean(adminMap.get(userId)) : false;
    const counterpart = buildCounterpartPayload({
      userRaw: user,
      fallbackUserIdRaw: userId,
      isAdminCounterpart,
    });
    const permissions = buildCounterpartPermissions(isAdminCounterpart);
    const canInteract = !isAdminCounterpart;

    (item as any).counterpart = counterpart;
    (item as any).permissions = permissions;
    (item as any).conversation_type = isAdminCounterpart ? "support_admin" : "direct";
    (item as any).conversationType = (item as any).conversation_type;
    (item as any).can_follow = canInteract;
    (item as any).canFollow = canInteract;
    (item as any).can_report = canInteract;
    (item as any).canReport = canInteract;
    (item as any).can_open_profile = canInteract;
    (item as any).canOpenProfile = canInteract;
    (item as any).can_open_more = canInteract;
    (item as any).canOpenMore = canInteract;
    (item as any).show_more_actions = canInteract;
    (item as any).showMoreActions = canInteract;
    if (user) {
      (item as any).user.user_type = counterpart.user_type;
      (item as any).user.is_admin = isAdminCounterpart;
      (item as any).user.isAdmin = isAdminCounterpart;
      (item as any).user.roles = counterpart.roles;
      (item as any).user.can_open_profile = counterpart.can_open_profile;
      (item as any).user.canOpenProfile = counterpart.can_open_profile;
      (item as any).user.can_report = counterpart.can_report;
      (item as any).user.canReport = counterpart.can_report;
      (item as any).user.can_follow = counterpart.can_follow;
      (item as any).user.canFollow = counterpart.can_follow;
      (item as any).user.can_open_more = canInteract;
      (item as any).user.canOpenMore = canInteract;
      (item as any).user.show_more_actions = canInteract;
      (item as any).user.showMoreActions = canInteract;
      (item as any).user.isFollowing = false;
      (item as any).user.is_following = false;
      (item as any).user.viewerFollowsUser = false;
      (item as any).user.viewer_follows_user = false;
      (item as any).user.isFollowedBy = false;
      (item as any).user.is_followed_by = false;
      (item as any).user.userFollowsViewer = false;
      (item as any).user.user_follows_viewer = false;
      (item as any).user.isMutual = false;
      (item as any).user.is_mutual = false;
    }
  });
};

const enrichLegacyChatsWithCounterpartPermissions = async (itemsRaw: any[]) => {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const counterpartIds = Array.from(
    new Set(
      items
        .map((item: any) =>
          toOptionalPositiveInt((item as any)?.Chat?.users?.[0]?.id)
        )
        .filter((id): id is number => Boolean(id))
    )
  );
  const adminMap = await userRepository.getAdminRoleMapByUserIds(counterpartIds);

  items.forEach((item: any) => {
    const chat = (item as any)?.Chat ?? null;
    const user = (chat as any)?.users?.[0] ?? null;
    const userId = toOptionalPositiveInt((user as any)?.id);
    const isAdminCounterpart = userId ? Boolean(adminMap.get(userId)) : false;
    const counterpart = buildCounterpartPayload({
      userRaw: user,
      fallbackUserIdRaw: userId,
      isAdminCounterpart,
    });
    const permissions = buildCounterpartPermissions(isAdminCounterpart);
    const canInteract = !isAdminCounterpart;

    setValue(chat, "counterpart", counterpart);
    setValue(chat, "permissions", permissions);
    setValue(chat, "conversation_type", isAdminCounterpart ? "support_admin" : "direct");
    setValue(chat, "conversationType", (chat as any)?.conversation_type);
    setValue(chat, "can_follow", canInteract);
    setValue(chat, "canFollow", canInteract);
    setValue(chat, "can_report", canInteract);
    setValue(chat, "canReport", canInteract);
    setValue(chat, "can_open_profile", canInteract);
    setValue(chat, "canOpenProfile", canInteract);
    setValue(chat, "can_open_more", canInteract);
    setValue(chat, "canOpenMore", canInteract);
    setValue(chat, "show_more_actions", canInteract);
    setValue(chat, "showMoreActions", canInteract);
    setValue(item, "counterpart", counterpart);
    setValue(item, "permissions", permissions);
    setValue(item, "conversation_type", isAdminCounterpart ? "support_admin" : "direct");
    setValue(item, "conversationType", (item as any)?.conversation_type);
    setValue(item, "can_follow", canInteract);
    setValue(item, "canFollow", canInteract);
    setValue(item, "can_report", canInteract);
    setValue(item, "canReport", canInteract);
    setValue(item, "can_open_profile", canInteract);
    setValue(item, "canOpenProfile", canInteract);
    setValue(item, "can_open_more", canInteract);
    setValue(item, "canOpenMore", canInteract);
    setValue(item, "show_more_actions", canInteract);
    setValue(item, "showMoreActions", canInteract);
    if (user) {
      setValue(user, "user_type", counterpart.user_type);
      setValue(user, "is_admin", isAdminCounterpart);
      setValue(user, "isAdmin", isAdminCounterpart);
      setValue(user, "roles", counterpart.roles);
      setValue(user, "can_open_profile", counterpart.can_open_profile);
      setValue(user, "canOpenProfile", counterpart.can_open_profile);
      setValue(user, "can_report", counterpart.can_report);
      setValue(user, "canReport", counterpart.can_report);
      setValue(user, "can_follow", counterpart.can_follow);
      setValue(user, "canFollow", counterpart.can_follow);
      setValue(user, "can_open_more", canInteract);
      setValue(user, "canOpenMore", canInteract);
      setValue(user, "show_more_actions", canInteract);
      setValue(user, "showMoreActions", canInteract);
      setValue(user, "isFollowing", false);
      setValue(user, "is_following", false);
      setValue(user, "viewerFollowsUser", false);
      setValue(user, "viewer_follows_user", false);
      setValue(user, "isFollowedBy", false);
      setValue(user, "is_followed_by", false);
      setValue(user, "userFollowsViewer", false);
      setValue(user, "user_follows_viewer", false);
      setValue(user, "isMutual", false);
      setValue(user, "is_mutual", false);
    }
  });
};

const enrichMessagesWithSenderType = (params: {
  messagesRaw: any[];
  viewerIdRaw: any;
  counterpartUserIdRaw: any;
  counterpartIsAdmin: boolean;
}) => {
  const viewerId = toOptionalPositiveInt(params.viewerIdRaw);
  const counterpartUserId = toOptionalPositiveInt(params.counterpartUserIdRaw);
  const messages = Array.isArray(params.messagesRaw) ? params.messagesRaw : [];

  return messages.map((messageRaw: any) => {
    const message = toPlain(messageRaw) ?? {};
    const senderId =
      toOptionalPositiveInt(
        (message as any)?.senderId ??
          (message as any)?.sender_id ??
          (message as any)?.sender?.id
      ) ?? null;
    const isFromAdmin =
      Boolean(params.counterpartIsAdmin) &&
      Boolean(counterpartUserId) &&
      Boolean(senderId) &&
      senderId === counterpartUserId;
    const direction =
      viewerId && senderId && senderId === viewerId ? "outgoing" : "incoming";

    return {
      ...message,
      sender_type: isFromAdmin ? "admin" : "user",
      sender_is_admin: isFromAdmin,
      direction,
    };
  });
};

const applyRelativeToLegacyChats = (rows: any[], locale: AppLocale) => {
  if (!Array.isArray(rows)) return rows;

  rows.forEach((row: any) => {
    const chat = (row as any)?.Chat;
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const lastMessage = messages[0] ?? null;
    const referenceDate =
      (lastMessage as any)?.date ??
      (lastMessage as any)?.createdAt ??
      (lastMessage as any)?.updatedAt ??
      (row as any)?.updatedAt ??
      (chat as any)?.updatedAt ??
      (row as any)?.createdAt ??
      null;

    const relativeTime = formatRelativeTime(referenceDate, locale);
    if (!relativeTime) return;

    if (lastMessage) {
      setValue(lastMessage, "relativeTime", relativeTime);
      setValue(lastMessage, "relative_time", relativeTime);
    }

    setValue(row, "relativeTime", relativeTime);
    setValue(row, "relative_time", relativeTime);
    setValue(chat, "relativeTime", relativeTime);
    setValue(chat, "relative_time", relativeTime);
  });

  return rows;
};

const CHAT_LOCALE_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.CHAT_LOCALE_CACHE_TTL_MS ?? 300_000) || 300_000
);
const CHAT_SUMMARY_CACHE_ENABLED =
  String(process.env.CHAT_SUMMARY_CACHE_ENABLED ?? "1")
    .trim()
    .toLowerCase() !== "0";
const CHAT_SUMMARY_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.CHAT_SUMMARY_CACHE_TTL_MS ?? 8_000) || 8_000
);
const CHAT_SUMMARY_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number(process.env.CHAT_SUMMARY_CACHE_MAX_ENTRIES ?? 3_000) || 3_000
);

type LocaleCacheEntry = {
  expiresAtMs: number;
  value: {
    language: string | null;
    language_codes: string[];
    language_names: string[];
  };
};

type ChatSummaryCacheValue = {
  body: any;
  etag: string;
};

type ChatSummaryCacheEntry = {
  expiresAtMs: number;
  value: ChatSummaryCacheValue;
};

const localeByUserIdCache = new Map<number, LocaleCacheEntry>();
const chatSummaryCache = new Map<string, ChatSummaryCacheEntry>();
const chatSummaryInFlight = new Map<string, Promise<ChatSummaryCacheValue>>();

const cloneCacheValue = <T>(value: T): T => {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
};

const readLocaleCache = (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const key = Math.trunc(userId);
  const entry = localeByUserIdCache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    localeByUserIdCache.delete(key);
    return null;
  }
  return entry.value;
};

const writeLocaleCache = (
  userIdRaw: any,
  value: { language: string | null; language_codes: string[]; language_names: string[] }
) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const key = Math.trunc(userId);
  localeByUserIdCache.set(key, {
    expiresAtMs: Date.now() + CHAT_LOCALE_CACHE_TTL_MS,
    value: {
      language: value.language ?? null,
      language_codes: Array.isArray(value.language_codes) ? [...value.language_codes] : [],
      language_names: Array.isArray(value.language_names) ? [...value.language_names] : [],
    },
  });
};

const pruneChatSummaryCache = () => {
  const now = Date.now();
  for (const [key, entry] of chatSummaryCache.entries()) {
    if (entry.expiresAtMs <= now) {
      chatSummaryCache.delete(key);
    }
  }

  while (chatSummaryCache.size > CHAT_SUMMARY_CACHE_MAX_ENTRIES) {
    const firstKey = chatSummaryCache.keys().next().value;
    if (!firstKey) break;
    chatSummaryCache.delete(firstKey);
  }
};

const readChatSummaryCache = (key: string): ChatSummaryCacheValue | null => {
  if (!CHAT_SUMMARY_CACHE_ENABLED || !key) return null;
  pruneChatSummaryCache();
  const entry = chatSummaryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    chatSummaryCache.delete(key);
    return null;
  }

  return {
    etag: String(entry.value.etag ?? ""),
    body: cloneCacheValue(entry.value.body),
  };
};

const writeChatSummaryCache = (key: string, value: ChatSummaryCacheValue) => {
  if (!CHAT_SUMMARY_CACHE_ENABLED || !key || !value) return;
  pruneChatSummaryCache();
  chatSummaryCache.set(key, {
    expiresAtMs: Date.now() + CHAT_SUMMARY_CACHE_TTL_MS,
    value: {
      etag: String(value.etag ?? ""),
      body: cloneCacheValue(value.body),
    },
  });
};

const withSummarySingleFlight = async (
  key: string,
  task: () => Promise<ChatSummaryCacheValue>
): Promise<{ value: ChatSummaryCacheValue; shared: boolean }> => {
  if (!CHAT_SUMMARY_CACHE_ENABLED || !key) {
    return { value: await task(), shared: false };
  }

  const current = chatSummaryInFlight.get(key);
  if (current) {
    return { value: await current, shared: true };
  }

  const promise = (async () => task())();
  chatSummaryInFlight.set(key, promise);
  try {
    return { value: await promise, shared: false };
  } finally {
    if (chatSummaryInFlight.get(key) === promise) {
      chatSummaryInFlight.delete(key);
    }
  }
};

const buildChatSummaryCacheKey = (params: {
  userId: number;
  locale: AppLocale;
  limit: number | null;
  cursor: string | null;
}) => {
  const normalizedUserId = Number.isFinite(Number(params.userId))
    ? Math.trunc(Number(params.userId))
    : 0;
  const limitPart = Number.isFinite(Number(params.limit)) ? Math.trunc(Number(params.limit)) : 0;
  const cursorPart = String(params.cursor ?? "").trim() || "-";
  return `chat:summary:u:${normalizedUserId}:l:${params.locale}:n:${limitPart}:c:${cursorPart}`;
};

export const invalidateChatSummaryCacheByUser = (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const safeUserId = Math.trunc(userId);
  const prefix = `chat:summary:u:${safeUserId}:`;

  for (const key of chatSummaryCache.keys()) {
    if (key.startsWith(prefix)) {
      chatSummaryCache.delete(key);
    }
  }
  for (const key of chatSummaryInFlight.keys()) {
    if (key.startsWith(prefix)) {
      chatSummaryInFlight.delete(key);
    }
  }
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = Number((req as any)?.userId ?? 0);

  if (String(preferredLanguage ?? "").trim()) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  if (!Number.isFinite(userId) || userId <= 0) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  try {
    const cached = readLocaleCache(userId);
    if (cached) {
      return resolveLocale({
        preferredLanguage,
        acceptLanguage,
        storedLanguage: cached.language,
        storedLanguageCodes: cached.language_codes,
        storedLanguageNames: cached.language_names,
      });
    }

    const localeSettings = await userRepository.getUserLocaleSettings(userId);
    writeLocaleCache(userId, localeSettings);

    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
      storedLanguage: localeSettings?.language,
      storedLanguageCodes: localeSettings?.language_codes,
      storedLanguageNames: localeSettings?.language_names,
    });
  } catch {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }
};

const resolveNextBeforeMessageId = (messages: any[], limit: number): number | null => {
  if (!Array.isArray(messages) || messages.length < limit) return null;
  let minId = Number.POSITIVE_INFINITY;

  messages.forEach((message: any) => {
    const id = Number((message as any)?.id);
    if (Number.isFinite(id) && id > 0) {
      minId = Math.min(minId, Math.trunc(id));
    }
  });

  if (!Number.isFinite(minId) || minId <= 0) return null;
  return minId;
};

type ChatListCursorPayload = {
  pinnedAt: string | null;
  updatedAt: string;
  chatId: number;
};

const CHAT_LIST_FIXED_LIMIT = 50;

const parseChatListLimit = (raw: any): number | null => {
  return CHAT_LIST_FIXED_LIMIT;
};

const isValidChatListCursorPayload = (
  cursor: ChatListCursorPayload | null | undefined
): cursor is ChatListCursorPayload => {
  if (!cursor) return false;
  const chatId = Number((cursor as any).chatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return false;
  const updatedAt = new Date(String((cursor as any).updatedAt ?? ""));
  if (!Number.isFinite(updatedAt.getTime())) return false;
  const pinnedAtRaw = (cursor as any).pinnedAt;
  if (pinnedAtRaw == null) return true;
  const pinnedAt = new Date(String(pinnedAtRaw));
  return Number.isFinite(pinnedAt.getTime());
};

const encodeChatListCursor = (cursor: ChatListCursorPayload | null): string | null => {
  if (!isValidChatListCursorPayload(cursor)) return null;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
};

const decodeChatListCursor = (raw: any): ChatListCursorPayload | null => {
  if (raw == null) return null;
  const normalized = String(raw).trim();
  if (!normalized) return null;

  const candidates = [normalized];
  try {
    candidates.push(Buffer.from(normalized, "base64url").toString("utf8"));
  } catch (_) {
    // ignore decode error
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValidChatListCursorPayload(parsed)) {
        return {
          pinnedAt: parsed.pinnedAt ?? null,
          updatedAt: String(parsed.updatedAt),
          chatId: Math.trunc(Number(parsed.chatId)),
        };
      }
    } catch (_) {
      // ignore parse error
    }
  }

  return null;
};

const collectChatCounterpartIds = (chatsRaw: any[]): number[] =>
  Array.from(
    new Set(
      (Array.isArray(chatsRaw) ? chatsRaw : [])
        .map((chatRow: any) =>
          Number(
            chatRow?.Chat?.users?.[0]?.id ??
              chatRow?.chat?.users?.[0]?.id ??
              chatRow?.user?.id
          )
        )
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

const attachRelationshipAliases = (target: any, relationshipRaw: any) => {
  if (!target) return;
  const isFollowing = Boolean(relationshipRaw?.isFollowing);
  const isFollowedBy = Boolean(relationshipRaw?.isFollowedBy);
  const isMutual = isFollowing && isFollowedBy;
  const fields = {
    relationship: { isFollowing, isFollowedBy, isMutual },
    isFollowing,
    is_following: isFollowing,
    viewerFollowsUser: isFollowing,
    viewer_follows_user: isFollowing,
    isFollowedBy,
    is_followed_by: isFollowedBy,
    userFollowsViewer: isFollowedBy,
    user_follows_viewer: isFollowedBy,
    isMutual,
    is_mutual: isMutual,
  };

  if (typeof target.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      target.setDataValue(key, value);
    });
    return;
  }

  Object.assign(target, fields);
};

const attachRelationshipsToChatRows = async (viewerIdRaw: any, chatsRaw: any[]) => {
  const relationshipByUserId = await followerRepo.getRelationshipMap(
    viewerIdRaw,
    collectChatCounterpartIds(chatsRaw)
  );

  (Array.isArray(chatsRaw) ? chatsRaw : []).forEach((chatRow: any) => {
    const user = (chatRow as any)?.Chat?.users?.[0];
    const userId = Number(user?.id);
    const relationship =
      relationshipByUserId[userId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(user, relationship);
  });

  return relationshipByUserId;
};

export const myChats = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    setNoCacheHeaders(res);
    const summary = isSummaryMode((req.query as any)?.summary);
    const locale = await resolveRequestLocale(req);
    const limit = parseChatListLimit((req.query as any)?.limit);
    const cursor = decodeChatListCursor((req.query as any)?.cursor);
    const cacheCursor = encodeChatListCursor(cursor);
    const summaryCacheKey =
      summary && CHAT_SUMMARY_CACHE_ENABLED
        ? buildChatSummaryCacheKey({
            userId: Number((req as any)?.userId ?? 0),
            locale,
            limit,
            cursor: cacheCursor,
          })
        : "";

    if (summaryCacheKey) {
      const cached = readChatSummaryCache(summaryCacheKey);
      if (cached) {
        res.set("X-Chat-Summary-Cache", "hit");
        res.set("ETag", cached.etag);
        if (isEtagFresh(req, cached.etag)) {
          res.status(304).end();
          return;
        }
        return formatResponse({
          res,
          success: true,
          body: cached.body,
        });
      }
    }

    if (summary && summaryCacheKey) {
      const { value, shared } = await withSummarySingleFlight(summaryCacheKey, async () => {
        const response = await repository.getUserChatsSummary(req.userId, req.userId, {
          limit,
          cursor,
        });
        const chats = Array.isArray((response as any)?.chats) ? (response as any).chats : [];
        const relationshipByUserId = await attachRelationshipsToChatRows(req.userId, chats);
        const nextCursor = encodeChatListCursor((response as any)?.paging?.nextCursor ?? null);
        const summarizedChats = (chats ?? []).map((chat: any) =>
          toChatSummary(chat, locale, req.userId, relationshipByUserId)
        );
        await enrichChatSummariesWithCounterpartPermissions(summarizedChats);
        const body: any = {
          chatsByUser: summarizedChats,
        };
        if ((response as any)?.paging?.limit != null || nextCursor) {
          body.paging = {
            limit: (response as any)?.paging?.limit ?? null,
            next_cursor: nextCursor,
            nextCursor,
          };
        }
        return {
          body,
          etag: buildWeakEtag(body),
        };
      });

      writeChatSummaryCache(summaryCacheKey, value);
      console.log(
        `[perf][myChats] userId=${req.userId} chats=${
          Array.isArray((value as any)?.body?.chatsByUser)
            ? (value as any).body.chatsByUser.length
            : 0
        } totalMs=${Date.now() - startedAt}`
      );
      res.set("X-Chat-Summary-Cache", shared ? "coalesced" : "miss");
      res.set("ETag", value.etag);
      if (isEtagFresh(req, value.etag)) {
        res.status(304).end();
        return;
      }
      return formatResponse({
        res,
        success: true,
        body: value.body,
      });
    }

    const response = await repository.getUserChats(req.userId, req.userId, { limit, cursor });
    const chats = Array.isArray((response as any)?.chats) ? (response as any).chats : [];
    await attachRelationshipsToChatRows(req.userId, chats);
    console.log(
      `[perf][myChats] userId=${req.userId} chats=${Array.isArray(chats) ? chats.length : 0} totalMs=${Date.now() - startedAt}`
    );

    const nextCursor = encodeChatListCursor((response as any)?.paging?.nextCursor ?? null);
    const chatsByUser = applyRelativeToLegacyChats(chats ?? [], locale);
    await enrichLegacyChatsWithCounterpartPermissions(chatsByUser);
    const body: any = {
      chatsByUser,
    };
    if ((response as any)?.paging?.limit != null || nextCursor) {
      body.paging = {
        limit: (response as any)?.paging?.limit ?? null,
        next_cursor: nextCursor,
        nextCursor,
      };
    }
    const etag = buildWeakEtag(body);
    res.set("ETag", etag);
    if (isEtagFresh(req, etag)) {
      res.status(304).end();
      return;
    }

    return formatResponse({
      res,
      success: true,
      body,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const starredChats = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);

    const limitRaw = req.query.limit;
    const limitParsed = parseInt(String(limitRaw ?? "20"), 10);
    const limit = Number.isFinite(limitParsed)
      ? Math.max(1, Math.min(limitParsed, 100))
      : 20;

    const beforePinnedAtRaw = String((req.query as any)?.beforePinnedAt ?? "").trim();
    const beforePinnedAt = beforePinnedAtRaw.length > 0 ? beforePinnedAtRaw : null;

    const beforeChatIdParsed = parseInt(String((req.query as any)?.beforeChatId ?? ""), 10);
    const beforeChatId = Number.isFinite(beforeChatIdParsed) ? beforeChatIdParsed : null;

    const response = await repository.getUserStarredChats({
      currentUserId: req.userId,
      meId: req.userId,
      limit,
      beforePinnedAt,
      beforeChatId,
    });
    const chatsByUser = Array.isArray((response as any)?.chats) ? (response as any).chats : [];
    await enrichLegacyChatsWithCounterpartPermissions(chatsByUser);

    return formatResponse({
      res,
      success: true,
      body: {
        chatsByUser,
        paging: {
          limit,
          beforePinnedAt,
          beforeChatId,
          next_cursor: response.paging.nextCursor,
        },
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const messages = async (req: Request, res: Response) => {
  const { id } = req.params;
  const otherUserId = Number(id);

  const limitRaw = req.query.limit;
  const limitParsed = parseInt(String(limitRaw ?? "50"), 10);
  const limit = Number.isFinite(limitParsed)
    ? Math.max(1, Math.min(limitParsed, 200))
    : 50;

  const beforeRaw = req.query.beforeMessageId;
  const beforeMessageIdParsed =
    beforeRaw == null ? null : parseInt(String(beforeRaw), 10);
  const beforeMessageId = Number.isFinite(beforeMessageIdParsed as any)
    ? (beforeMessageIdParsed as number)
    : null;
  const sortRaw = String((req.query as any)?.sort ?? "").toLowerCase();
  const sort: "asc" | "desc" = sortRaw === "desc" ? "desc" : "asc";
  const summary = isSummaryMode((req.query as any)?.summary);

  try {
    setNoCacheHeaders(res);
    const locale = await resolveRequestLocale(req);
    const otherUserIsAdmin = await userRepository.isUserAdminById(otherUserId);
    const otherUser = Number.isFinite(otherUserId)
      ? await userRepository.getUserById(otherUserId)
      : null;
    const counterpart = buildCounterpartPayload({
      userRaw: otherUser,
      fallbackUserIdRaw: otherUserId,
      isAdminCounterpart: otherUserIsAdmin,
    });
    const permissions = buildCounterpartPermissions(otherUserIsAdmin);
    const conversationType = otherUserIsAdmin ? "support_admin" : "direct";
    const canInteract = !otherUserIsAdmin;

    const messageRows = summary
      ? await repository.getChatByUserSummary(req.userId, id, {
          limit,
          beforeMessageId,
          sort,
        })
      : await repository.getChatByUser(req.userId, id, {
          limit,
          beforeMessageId,
          sort,
        });

    let chatId =
      messageRows.length > 0
        ? Number((messageRows[0] as any).chatId) || null
        : null;

    if (!chatId) {
      chatId = await repository.getDirectChatIdByUsers(req.userId, id);
    }

    if (chatId != null && messageRows && messageRows.length > 0) {
      const pendingToRead: any[] = [];

      for (const m of messageRows as any[]) {
        const isMine = String(m.senderId) === String(req.userId);
        const status = (m.status ?? "sent") as string;

        if (!isMine && (status === "sent" || status === "delivered") && m.id != null) {
          pendingToRead.push(m);
        }
      }

      if (pendingToRead.length > 0) {
        const { readAt } = await repository.markMessagesAsReadBulk(
          pendingToRead.map((m) => m.id)
        );
        await repository.decrementUnreadCountForChatUser(
          Number(chatId),
          Number(req.userId),
          pendingToRead.length
        );
        const now = readAt ?? new Date();
        const deliveredAtIso = now.toISOString();

        for (const m of pendingToRead) {
          if (typeof (m as any).setDataValue === "function") {
            (m as any).setDataValue("status", "read");
            (m as any).setDataValue("readAt", now);
            (m as any).setDataValue("deliveredAt", now);
          } else {
            (m as any).status = "read";
            (m as any).readAt = now;
            (m as any).deliveredAt = now;
          }

          const statusPayload = {
            chatId,
            chat_id: chatId,
            messageId: m.id,
            message_id: m.id,
            id: m.id,
            status: "read",
            deliveredAt: deliveredAtIso,
            readAt: deliveredAtIso,
          };

          emitChatStatusRealtime(chatId, statusPayload, [req.userId, otherUserId]);
        }
      }

      // Limpia cualquier desfase previo del contador al abrir la conversación.
      await repository.resetUnreadCountForChatUser(Number(chatId), Number(req.userId));

      if (Number.isFinite(otherUserId) && otherUserId > 0) {
        emitChatsRefreshRealtime(otherUserId);
        invalidateChatSummaryCacheByUser(otherUserId);
      }
      emitChatsRefreshRealtime(req.userId);
      invalidateChatSummaryCacheByUser(req.userId);
    }

    const nextBeforeMessageId = resolveNextBeforeMessageId(messageRows as any[], limit);
    res.set(
      "X-Paging-Next-Before-Message-Id",
      nextBeforeMessageId == null ? "" : String(nextBeforeMessageId)
    );

    const payload = {
      conversation_id: chatId ?? null,
      conversation_type: conversationType,
      counterpart,
      permissions,
      can_follow: canInteract,
      canFollow: canInteract,
      can_report: canInteract,
      canReport: canInteract,
      can_open_profile: canInteract,
      canOpenProfile: canInteract,
      can_open_more: canInteract,
      canOpenMore: canInteract,
      show_more_actions: canInteract,
      showMoreActions: canInteract,
      chatId,
      messages: enrichMessagesWithSenderType({
        messagesRaw: summary
          ? messageRows.map((message: any) => toChatMessageSummary(message, locale))
          : serializeMessagesToCanonical(messageRows, { includeLegacy: true, locale }),
        viewerIdRaw: req.userId,
        counterpartUserIdRaw: otherUserId,
        counterpartIsAdmin: otherUserIsAdmin,
      }),
      paging: {
        limit,
        beforeMessageId,
        sort,
        next_before_message_id: nextBeforeMessageId,
        nextBeforeMessageId,
      },
    };

    return formatResponse({ res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const getUserByMessage = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);

    const rawMessageId = (req.params as any)?.messageId ?? (req.params as any)?.id;
    const messageId = Number(rawMessageId);

    if (!Number.isFinite(messageId) || messageId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "messageId must be a valid number",
      });
    }

    const response = await repository.resolveConversationByMessageId(
      req.userId,
      messageId
    );

    if (!response) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "message not found",
      });
    }

    if (response?.conversationType === "direct" && response?.peerUserId) {
      const peerUserId = Number(response.peerUserId);
      const isAdminCounterpart = await userRepository.isUserAdminById(peerUserId);
      const counterpartUser = Number.isFinite(peerUserId)
        ? await userRepository.getUserById(peerUserId)
        : null;
      const counterpart = buildCounterpartPayload({
        userRaw: counterpartUser,
        fallbackUserIdRaw: peerUserId,
        isAdminCounterpart,
      });
      const permissions = buildCounterpartPermissions(isAdminCounterpart);
      return formatResponse({
        res,
        success: true,
        body: {
          ...response,
          conversation_type: isAdminCounterpart ? "support_admin" : "direct",
          conversationType: isAdminCounterpart ? "support_admin" : "direct",
          counterpart,
          permissions,
          user: counterpart,
        },
      });
    }

    return formatResponse({
      res,
      success: true,
      body: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
