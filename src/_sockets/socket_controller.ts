// src/_sockets/socket_controller.ts
import { Socket } from "socket.io";
import Offer from "../_models/offer/offer";
import Service from "../_models/service/service";
import Message from "../_models/chat/message";
import Chat_User from "../_models/chat/chat_user";
import User from "../_models/user/user";
import Notification from "_models/notification/notification";
import { Op } from "sequelize";
import jwt from "jsonwebtoken";
import { sendNotification } from "../useCases/notification/add/add";
import { createInMemoryRateLimiter, RateLimitResult } from "../libs/security/inmemory_rate_limiter";
import { isUserAuthSessionActive } from "../libs/auth/user_auth_session";
import {
  decrementUnreadCountForChatUser,
  resetUnreadCountForChatUser,
} from "../repository/chat/chat_repository";

type ChatStatus = "sent" | "delivered" | "read";

type ChatStatusPayload = {
  chatId: number;
  messageId: number;
  userId?: number;
};

type ChatJoinPayload = {
  chatId: number;
  userId?: number;
  lastMessageId?: number;
  last_message_id?: number;
};

type ChatSyncPayload = {
  chatId: number;
  userId?: number;
  lastMessageId?: number;
  last_message_id?: number;
  sinceMessageId?: number;
  since_message_id?: number;
  limit?: number;
};


type ChatTypingPayload = {
  chatId: number;
  userId: number;
  typing: boolean;
};

type ChatReactionPayload = {
  chatId: number;
  messageId: number;
  userId: number;
  emoji: string; // "❤️" "😂" "👍" etc
};

type ReactionMap = Record<string, number[]>;

const chatRoom = (chatId: number) => `chat_${chatId}`;
const userRoom = (userId: number) => `user_${userId}`;
const CHAT_ROOM_REGEX = /^chat_\d+$/;
const parsePositiveIntEnv = (value: any, fallback: number, min = 1): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
};
const IS_PRODUCTION =
  String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
const ALLOW_SOCKET_USERID_FALLBACK = (() => {
  const raw = String(
    process.env.ALLOW_SOCKET_USERID_FALLBACK ?? (IS_PRODUCTION ? "0" : "1")
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
})();
const SESSION_VALIDATION_TTL_MS = 15 * 1000;
const EMIT_REELS_EVENT_ON_REEL_DELETE =
  String(process.env.EMIT_REELS_EVENT_ON_REEL_DELETE ?? "1").trim() === "1";
const EMIT_POSTS_EVENT_ON_POST_ACTIVITY =
  String(
    process.env.EMIT_POSTS_EVENT_ON_POST_ACTIVITY ??
      process.env.EMIT_POSTS_EVENT_ON_POST_COMMENT ??
      "1"
  ).trim() === "1";
const SOCKET_CHAT_SEND_RATE_WINDOW_MS = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_SEND_RATE_WINDOW_MS,
  10_000,
  1000
);
const SOCKET_CHAT_SEND_RATE_MAX = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_SEND_RATE_MAX,
  45,
  1
);
const SOCKET_CHAT_SEND_RATE_BLOCK_MS = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_SEND_RATE_BLOCK_MS,
  20_000,
  SOCKET_CHAT_SEND_RATE_WINDOW_MS
);
const SOCKET_CHAT_META_RATE_WINDOW_MS = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_META_RATE_WINDOW_MS,
  10_000,
  1000
);
const SOCKET_CHAT_META_RATE_MAX = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_META_RATE_MAX,
  80,
  1
);
const SOCKET_CHAT_META_RATE_BLOCK_MS = parsePositiveIntEnv(
  process.env.SOCKET_CHAT_META_RATE_BLOCK_MS,
  15_000,
  SOCKET_CHAT_META_RATE_WINDOW_MS
);
const socketChatSendRateLimiter = createInMemoryRateLimiter({
  windowMs: SOCKET_CHAT_SEND_RATE_WINDOW_MS,
  max: SOCKET_CHAT_SEND_RATE_MAX,
  blockDurationMs: SOCKET_CHAT_SEND_RATE_BLOCK_MS,
});
const socketChatMetaRateLimiter = createInMemoryRateLimiter({
  windowMs: SOCKET_CHAT_META_RATE_WINDOW_MS,
  max: SOCKET_CHAT_META_RATE_MAX,
  blockDurationMs: SOCKET_CHAT_META_RATE_BLOCK_MS,
});

function normalizePositiveInt(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toPlainRecord(value: any): any {
  if (!value) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") {
    return { ...value.dataValues };
  }
  return value;
}

function normalizeDateIso(value: any): string | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeBoolOrNull(value: any): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
  }
  return null;
}

function normalizeReelFreshnessState(source: any) {
  const ringUntilRaw =
    source?.ring_until ??
    source?.ringUntil ??
    source?.new_until ??
    source?.newUntil ??
    null;

  const ringUntil = normalizeDateIso(ringUntilRaw);
  const explicitRingActive = normalizeBoolOrNull(source?.ring_active ?? source?.ringActive);
  const explicitIsNew = normalizeBoolOrNull(source?.is_new ?? source?.isNew);
  const fallbackRingActive =
    ringUntil !== null ? new Date(ringUntil).getTime() > Date.now() : false;

  const ringActive = explicitRingActive ?? explicitIsNew ?? fallbackRingActive;
  const isNew = explicitIsNew ?? ringActive;
  const newUntil =
    normalizeDateIso(source?.new_until ?? source?.newUntil ?? ringUntil) ?? ringUntil;

  return {
    ringActive,
    ringUntil: ringUntil ?? newUntil,
    isNew,
    newUntil: newUntil ?? ringUntil,
  };
}

function normalizeReelRealtimePayload(payload: any, fallbackAction: "created" | "updated") {
  const source = payload ?? {};
  const reelSource = toPlainRecord(source.reel ?? source.orbit ?? source);
  const reelId = normalizePositiveInt(
    source.reelId ?? source.reel_id ?? source.id ?? reelSource?.id
  );
  const ownerId = normalizePositiveInt(
    source.ownerId ??
      source.owner_id ??
      source.userId ??
      source.user_id ??
      reelSource?.user?.id ??
      reelSource?.userId ??
      reelSource?.user_id
  );
  const actionRaw = String(source.action ?? fallbackAction).trim().toLowerCase();
  const action = actionRaw === "updated" ? "updated" : "created";
  const freshness = normalizeReelFreshnessState(reelSource ?? source);

  const normalizedReel = reelSource
    ? {
        ...reelSource,
        ring_active: freshness.ringActive,
        ringActive: freshness.ringActive,
        ring_until: freshness.ringUntil,
        ringUntil: freshness.ringUntil,
        is_new: freshness.isNew,
        isNew: freshness.isNew,
        new_until: freshness.newUntil,
        newUntil: freshness.newUntil,
      }
    : null;

  return {
    action,
    reelId,
    reel_id: reelId,
    ownerId,
    owner_id: ownerId,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
    reel: normalizedReel,
  };
}

function normalizeOrbitRingUpdatedPayload(payload: any) {
  const source = payload ?? {};
  const userId = normalizePositiveInt(
    source.userId ?? source.user_id ?? source.id ?? source.user?.id
  );
  if (!userId) return null;

  const explicitHasActiveOrbit = normalizeBoolOrNull(
    source.has_active_orbit ?? source.hasActiveOrbit
  );
  const activeOrbitReelIdRaw = normalizePositiveInt(
    source.active_orbit_reel_id ?? source.activeOrbitReelId ?? source.reelId ?? source.reel_id
  );
  const orbitRingUntilRaw = normalizeDateIso(
    source.orbit_ring_until ?? source.orbitRingUntil ?? source.ring_until ?? source.ringUntil
  );
  const fallbackHasActiveOrbit = Boolean(activeOrbitReelIdRaw && orbitRingUntilRaw);
  const hasActiveOrbit = explicitHasActiveOrbit ?? fallbackHasActiveOrbit;
  const activeOrbitReelId = hasActiveOrbit ? activeOrbitReelIdRaw ?? null : null;
  const orbitRingUntil = hasActiveOrbit ? orbitRingUntilRaw ?? null : null;

  return {
    action: "updated",
    user_id: userId,
    userId,
    has_active_orbit: hasActiveOrbit,
    hasActiveOrbit: hasActiveOrbit,
    has_orbit_ring: hasActiveOrbit,
    hasOrbitRing: hasActiveOrbit,
    active_orbit_reel_id: activeOrbitReelId,
    activeOrbitReelId: activeOrbitReelId,
    orbit_ring_until: orbitRingUntil,
    orbitRingUntil: orbitRingUntil,
    user: {
      id: userId,
      userId,
      user_id: userId,
      has_active_orbit: hasActiveOrbit,
      hasActiveOrbit: hasActiveOrbit,
      has_orbit_ring: hasActiveOrbit,
      hasOrbitRing: hasActiveOrbit,
      active_orbit_reel_id: activeOrbitReelId,
      activeOrbitReelId: activeOrbitReelId,
      orbit_ring_until: orbitRingUntil,
      orbitRingUntil: orbitRingUntil,
    },
  };
}

function normalizeReelDeletedPayload(payload: any) {
  const source = payload ?? {};
  const reelSource = toPlainRecord(source.reel ?? source.orbit ?? null);
  const reelId = normalizePositiveInt(
    source.reelId ?? source.reel_id ?? source.id ?? source.reel?.id ?? reelSource?.id
  );
  const ownerId = normalizePositiveInt(
    source.ownerId ??
      source.owner_id ??
      source.userId ??
      source.user_id ??
      source.reel?.userId ??
      source.reel?.user_id ??
      reelSource?.userId ??
      reelSource?.user_id
  );
  const deletedAt = normalizeDateIso(
    source.deletedAt ?? source.deleted_at ?? reelSource?.deletedAt ?? reelSource?.deleted_at
  ) ?? new Date().toISOString();
  const actorUserId = normalizePositiveInt(
    source.actorUserId ??
      source.actor_user_id ??
      source.requestUserId ??
      source.request_user_id ??
      ownerId
  );
  const deleteReasonRaw = String(
    source.deleteReason ?? source.delete_reason ?? "owner_delete"
  )
    .trim()
    .toLowerCase();
  const deleteReason = deleteReasonRaw || "owner_delete";

  const normalizedReel = reelSource
    ? {
        ...reelSource,
        id: reelId || normalizePositiveInt(reelSource?.id) || null,
        userId:
          ownerId ||
          normalizePositiveInt(reelSource?.userId ?? reelSource?.user_id) ||
          null,
        user_id:
          ownerId ||
          normalizePositiveInt(reelSource?.user_id ?? reelSource?.userId) ||
          null,
        is_delete: true,
        isDeleted: true,
        deletedAt,
        deleted_at: deletedAt,
      }
    : {
        id: reelId || null,
        userId: ownerId || null,
        user_id: ownerId || null,
        is_delete: true,
        isDeleted: true,
        deletedAt,
        deleted_at: deletedAt,
      };

  return {
    action: "deleted",
    status: "deleted",
    event: "reel_deleted",
    entity: "reel",
    deleteReason,
    delete_reason: deleteReason,
    deleted: true,
    removed: true,
    id: reelId,
    reelId,
    reel_id: reelId,
    ownerId,
    owner_id: ownerId,
    actorUserId: actorUserId ?? ownerId,
    actor_user_id: actorUserId ?? ownerId,
    userId: ownerId,
    user_id: ownerId,
    deletedAt,
    deleted_at: deletedAt,
    ui_hint: {
      remove_only: true,
      auto_open: false,
      auto_advance: false,
    },
    uiHint: {
      removeOnly: true,
      autoOpen: false,
      autoAdvance: false,
    },
    reel: normalizedReel,
  };
}

function normalizeReelCommentedPayload(payload: any) {
  const source = payload ?? {};
  const commentSource = toPlainRecord(source.comment ?? null);
  const reelId = normalizePositiveInt(
    source.reelId ?? source.reel_id ?? source.id ?? source.reel?.id
  );
  const ownerId = normalizePositiveInt(
    source.ownerId ?? source.owner_id ?? source.userId ?? source.user_id ?? source.reel?.userId
  );
  const actorUserId = normalizePositiveInt(
    source.actorUserId ??
      source.actor_user_id ??
      source.interactorId ??
      source.interactor_id ??
      source.comment?.userId
  );
  const commentsCount = normalizePositiveInt(
    source.commentsCount ?? source.comments_count ?? source.reel?.comments_count
  );
  const commentCreatedAt = normalizeDateIso(
    source.commentCreatedAt ?? source.comment_created_at ?? commentSource?.createdAt ?? commentSource?.created_at
  );
  const commentUpdatedAt = normalizeDateIso(commentSource?.updatedAt ?? commentSource?.updated_at);

  const normalizedComment = commentSource
    ? {
        ...commentSource,
        createdAt: commentCreatedAt,
        created_at: commentCreatedAt,
        updatedAt: commentUpdatedAt,
        updated_at: commentUpdatedAt,
      }
    : null;

  return {
    action: "commented",
    reelId,
    reel_id: reelId,
    ownerId,
    owner_id: ownerId,
    actorUserId,
    actor_user_id: actorUserId,
    commentsCount,
    comments_count: commentsCount,
    comment: normalizedComment,
    commentCreatedAt: commentCreatedAt,
    comment_created_at: commentCreatedAt,
  };
}

function normalizePostCommentedPayload(payload: any) {
  const source = payload ?? {};
  const commentSource = toPlainRecord(source.comment ?? null);
  const postId = normalizePositiveInt(
    source.postId ?? source.post_id ?? source.id ?? source.post?.id
  );
  const ownerId = normalizePositiveInt(
    source.ownerId ?? source.owner_id ?? source.userId ?? source.user_id ?? source.post?.userId
  );
  const actorUserId = normalizePositiveInt(
    source.actorUserId ??
      source.actor_user_id ??
      source.interactorId ??
      source.interactor_id ??
      source.comment?.userId
  );
  const commentsCount = normalizePositiveInt(
    source.commentsCount ?? source.comments_count ?? source.post?.comments_count
  );
  const commentCreatedAt = normalizeDateIso(
    source.commentCreatedAt ?? source.comment_created_at ?? commentSource?.createdAt ?? commentSource?.created_at ?? commentSource?.created_date
  );
  const commentUpdatedAt = normalizeDateIso(commentSource?.updatedAt ?? commentSource?.updated_at);

  const normalizedComment = commentSource
    ? {
        ...commentSource,
        createdAt: commentCreatedAt,
        created_at: commentCreatedAt,
        created_date: commentCreatedAt,
        updatedAt: commentUpdatedAt,
        updated_at: commentUpdatedAt,
      }
    : null;

  return {
    action: "commented",
    postId,
    post_id: postId,
    ownerId,
    owner_id: ownerId,
    actorUserId,
    actor_user_id: actorUserId,
    commentsCount,
    comments_count: commentsCount,
    comment: normalizedComment,
    commentCreatedAt,
    comment_created_at: commentCreatedAt,
  };
}

function normalizePostUpdatedPayload(payload: any) {
  const source = payload ?? {};
  const postSource = toPlainRecord(source.post ?? null);
  const postId = normalizePositiveInt(
    source.postId ?? source.post_id ?? source.id ?? source.post?.id
  );
  const ownerId = normalizePositiveInt(
    source.ownerId ??
      source.owner_id ??
      source.userId ??
      source.user_id ??
      source.post?.userId ??
      source.post?.user_id ??
      source.post?.user?.id
  );
  const actorUserId = normalizePositiveInt(
    source.actorUserId ??
      source.actor_user_id ??
      source.interactorId ??
      source.interactor_id ??
      source.user?.id
  );
  const likesCount = normalizePositiveInt(
    source.likesCount ?? source.likes_count ?? postSource?.likes_count ?? postSource?.likesCount
  );
  const savesCount = normalizePositiveInt(
    source.savesCount ?? source.saves_count ?? postSource?.saves_count ?? postSource?.savesCount
  );
  const sharesCount = normalizePositiveInt(
    source.sharesCount ?? source.shares_count ?? postSource?.shares_count ?? postSource?.sharesCount
  );
  const commentsCount = normalizePositiveInt(
    source.commentsCount ??
      source.comments_count ??
      postSource?.comments_count ??
      postSource?.commentsCount
  );
  const actionRaw = String(source.action ?? "updated").trim().toLowerCase();
  const action =
    actionRaw === "liked" ||
    actionRaw === "unliked" ||
    actionRaw === "saved" ||
    actionRaw === "unsaved" ||
    actionRaw === "shared" ||
    actionRaw === "commented" ||
    actionRaw === "comment_deleted"
      ? actionRaw
      : "updated";
  const isLiked = normalizeBoolOrNull(
    source.isLiked ?? source.is_liked ?? postSource?.is_liked ?? postSource?.isLiked
  );
  const isSaved = normalizeBoolOrNull(
    source.isSaved ?? source.is_saved ?? postSource?.is_saved ?? postSource?.isSaved
  );
  const updatedAt = normalizeDateIso(source.updatedAt ?? source.updated_at ?? new Date().toISOString());

  const normalizedPost = postSource
    ? {
        ...postSource,
        id: postId || postSource.id || null,
        userId: ownerId || postSource.userId || postSource.user_id || null,
        user_id: ownerId || postSource.user_id || postSource.userId || null,
        likes_count: likesCount,
        likesCount,
        saves_count: savesCount,
        savesCount,
        shares_count: sharesCount,
        sharesCount,
        comments_count: commentsCount,
        commentsCount,
        is_liked: isLiked,
        isLiked: isLiked,
        is_saved: isSaved,
        isSaved: isSaved,
      }
    : null;

  return {
    action,
    postId,
    post_id: postId,
    ownerId,
    owner_id: ownerId,
    actorUserId,
    actor_user_id: actorUserId,
    likesCount,
    likes_count: likesCount,
    savesCount,
    saves_count: savesCount,
    sharesCount,
    shares_count: sharesCount,
    commentsCount,
    comments_count: commentsCount,
    isLiked,
    is_liked: isLiked,
    isSaved,
    is_saved: isSaved,
    updatedAt,
    updated_at: updatedAt,
    removed: source.removed === true,
    post: normalizedPost,
  };
}

function normalizePostCommentDeletedPayload(payload: any) {
  const source = payload ?? {};
  const postId = normalizePositiveInt(
    source.postId ?? source.post_id ?? source.id ?? source.post?.id
  );
  const commentId = normalizePositiveInt(
    source.commentId ?? source.comment_id ?? source.comment?.id
  );
  const commentsCount = normalizePositiveInt(
    source.commentsCount ?? source.comments_count ?? source.post?.comments_count
  );
  const deletedAt = normalizeDateIso(source.deletedAt ?? source.deleted_at ?? new Date().toISOString());

  return {
    action: "comment_deleted",
    removed: source.removed !== false,
    postId,
    post_id: postId,
    commentId,
    comment_id: commentId,
    commentsCount,
    comments_count: commentsCount,
    deletedAt,
    deleted_at: deletedAt,
  };
}

function normalizeReelCommentDeletedPayload(payload: any) {
  const source = payload ?? {};
  const reelId = normalizePositiveInt(
    source.reelId ?? source.reel_id ?? source.id ?? source.reel?.id
  );
  const commentId = normalizePositiveInt(
    source.commentId ?? source.comment_id ?? source.comment?.id
  );
  const commentsCount = normalizePositiveInt(
    source.commentsCount ?? source.comments_count ?? source.reel?.comments_count
  );
  const deletedAt = normalizeDateIso(source.deletedAt ?? source.deleted_at ?? new Date().toISOString());

  return {
    action: "comment_deleted",
    removed: source.removed !== false,
    reelId,
    reel_id: reelId,
    commentId,
    comment_id: commentId,
    commentsCount,
    comments_count: commentsCount,
    deletedAt,
    deleted_at: deletedAt,
  };
}

function leaveOtherChatRooms(socket: Socket, keepChatId: number) {
  const keepRoom = chatRoom(keepChatId);
  for (const room of socket.rooms) {
    if (room === socket.id || room === keepRoom) continue;
    if (!CHAT_ROOM_REGEX.test(room)) continue;
    socket.leave(room);
  }
}

function buildStatusPayload(params: {
  chatId: number;
  messageId: number;
  status: ChatStatus;
  deliveredAt?: string;
  readAt?: string;
}) {
  const { chatId, messageId, status, deliveredAt, readAt } = params;
  return {
    chatId,
    chat_id: chatId,
    messageId,
    message_id: messageId,
    id: messageId,
    status,
    deliveredAt: deliveredAt ?? null,
    readAt: readAt ?? null,
  };
}

function parseChatId(payload: any): number {
  if (typeof payload === "number") {
    return Number.isFinite(payload) && payload > 0 ? payload : 0;
  }
  if (typeof payload === "string") {
    const n = Number(payload);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const obj = payload ?? {};
  const candidates = [
    obj.chatId,
    obj.chat_id,
    obj.idChat,
    obj.chatID,
    obj.roomId,
    obj.room_id,
    obj.id,
    obj.chat?.id,
    obj.chat?.chatId,
    obj.data?.chatId,
    obj.payload?.chatId,
    Array.isArray(obj) ? obj[0] : undefined,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function parseMessageId(payload: any): number {
  const obj = payload ?? {};
  const candidates = [obj.messageId, obj.message_id, obj.idMessage, obj.msgId, obj.id];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function parseLastMessageId(payload: any): number {
  const obj = payload ?? {};
  const candidates = [
    obj.lastMessageId,
    obj.last_message_id,
    obj.sinceMessageId,
    obj.since_message_id,
    obj.fromMessageId,
    obj.from_message_id,
    obj.lastId,
    obj.last_id,
    obj.messageId,
    obj.message_id,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function parseSyncLimit(payload: any, fallback = 100): number {
  const obj = payload ?? {};
  const candidate = Number(obj.limit);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(1, Math.min(candidate, 200));
}

function parseUserId(payload: any): number {
  if (typeof payload === "number" || typeof payload === "string") {
    const n = Number(payload);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const obj = payload ?? {};
  const candidates = [obj.userId, obj.user_id, obj.uid, obj.idUser];
  if (obj?.user && typeof obj.user === "object") {
    candidates.push(obj.user.id);
    candidates.push(obj.user.userId);
  }
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function getSocketUserId(socket: Socket): number {
  return parseUserId({ userId: (socket.data as any)?.userId });
}

async function validateSocketSession(socket: Socket): Promise<boolean> {
  const socketUserId = getSocketUserId(socket);
  if (!Number.isFinite(socketUserId) || socketUserId <= 0) return false;

  const now = Date.now();
  const validatedAt = Number((socket.data as any)?.sessionValidatedAt ?? 0);
  const alreadyValidated = Boolean((socket.data as any)?.sessionValidated);
  if (alreadyValidated && now - validatedAt <= SESSION_VALIDATION_TTL_MS) {
    return true;
  }

  const authToken = normalizeToken((socket.data as any)?.authToken);
  if (!authToken) return false;

  const tokenUserId = resolveUserIdFromToken(authToken);
  if (!tokenUserId || tokenUserId !== socketUserId) return false;

  const user = await User.findOne({
    where: { id: socketUserId },
    attributes: ["id", "available", "disabled", "auth_token"],
    raw: true,
  });
  if (!user) return false;
  if (!(user as any).available || Boolean((user as any).disabled)) return false;
  const storedAuthToken = normalizeToken((user as any).auth_token);
  const tokenMatchesLegacy = Boolean(storedAuthToken && storedAuthToken === authToken);
  const tokenMatchesSession = tokenMatchesLegacy
    ? true
    : await isUserAuthSessionActive(socketUserId, authToken);
  if (!tokenMatchesSession) return false;

  (socket.data as any).sessionValidated = true;
  (socket.data as any).sessionValidatedAt = now;
  return true;
}

async function requireAuthenticatedUser(
  socket: Socket,
  event: string,
  payloadUserId?: number
): Promise<number> {
  const tokenAuthenticated = Boolean((socket.data as any)?.authenticatedByToken);
  if (!tokenAuthenticated && !ALLOW_SOCKET_USERID_FALLBACK) {
    console.log(`[socket] ${event} rejected missing token auth socket=${socket.id}`);
    socket.emit("auth:error", { event, code: "UNAUTHENTICATED" });
    return 0;
  }

  if (tokenAuthenticated) {
    const validSession = await validateSocketSession(socket);
    if (!validSession) {
      console.log(`[socket] ${event} rejected invalid session socket=${socket.id}`);
      socket.emit("auth:error", { event, code: "INVALID_SESSION" });
      return 0;
    }
  }

  const socketUserId = getSocketUserId(socket);
  const payloadUid = Number.isFinite(payloadUserId as any) ? Number(payloadUserId) : 0;

  if (socketUserId <= 0) {
    console.log(`[socket] ${event} rejected unauthenticated socket=${socket.id}`);
    socket.emit("auth:error", { event, code: "UNAUTHENTICATED" });
    return 0;
  }

  if (payloadUid > 0 && payloadUid !== socketUserId) {
    console.log(
      `[socket] ${event} rejected user mismatch socket=${socket.id} socketUserId=${socketUserId} payloadUserId=${payloadUid}`
    );
    socket.emit("auth:error", { event, code: "USER_MISMATCH" });
    return 0;
  }

  return socketUserId;
}

async function isUserParticipantInChat(chatId: number, userId: number): Promise<boolean> {
  if (!Number.isFinite(chatId) || chatId <= 0) return false;
  if (!Number.isFinite(userId) || userId <= 0) return false;

  const row = await Chat_User.findOne({
    where: { chatId, userId },
    attributes: ["chatId"],
    raw: true,
  });

  return !!row;
}

async function getChatParticipantUserIds(chatId: number): Promise<number[]> {
  if (!Number.isFinite(chatId) || chatId <= 0) return [];

  const rows = await Chat_User.findAll({
    where: { chatId },
    attributes: ["userId"],
    raw: true,
  });

  return Array.from(
    new Set(
      (rows as any[])
        .map((row) => Number((row as any)?.userId))
        .filter((uid) => Number.isFinite(uid) && uid > 0)
    )
  );
}

type InMemoryRateLimiter = ReturnType<typeof createInMemoryRateLimiter>;

function consumeSocketRateLimit(params: {
  socket: Socket;
  limiter: InMemoryRateLimiter;
  event: string;
  userId: number;
  chatId?: number;
}): boolean {
  const { socket, limiter, event, userId, chatId } = params;
  const key = `${event}:${userId}:${chatId ?? 0}`;
  const result: RateLimitResult = limiter.consume(key);
  if (result.allowed) return true;

  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  socket.emit("chat:rate_limited", {
    event,
    chatId: chatId ?? null,
    retryAfterMs: result.retryAfterMs,
    retryAfterSeconds,
    resetAt: new Date(result.resetAtMs).toISOString(),
  });
  console.log(
    `[socket] ${event} rate-limited socket=${socket.id} userId=${userId} chatId=${chatId ?? 0} retryAfterMs=${result.retryAfterMs}`
  );
  return false;
}

function normalizeToken(raw: any): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
}

function resolveTokenFromSources(...sources: any[]): string {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    const candidate =
      source?.token ??
      source?.accessToken ??
      source?.access_token ??
      source?.authToken ??
      source?.auth_token ??
      source?.jwt ??
      source?.idToken ??
      source?.id_token ??
      source?.authorization ??
      source?.bearer ??
      source?.bearerToken ??
      source?.urlToken ??
      source?.["x-access-token"] ??
      source?.["x-auth-token"] ??
      source?.["auth-token"] ??
      source?.["x-jwt-token"] ??
      source?.["x-device-token"];

    const token = normalizeToken(candidate);
    if (token) return token;
  }

  return "";
}

function resolveUserIdFromToken(tokenRaw: any): number {
  const token = normalizeToken(tokenRaw);
  if (!token) return 0;

  const secrets = [
    (process.env.SECRETORPRIVATEKEY ?? "").trim(),
    (process.env.JWT_SECRET ?? "").trim(),
  ].filter(Boolean);

  for (const secret of secrets) {
    try {
      const payload = jwt.verify(token, secret) as any;
      const userId =
        parseUserId(payload) ||
        parseUserId({ userId: payload?.sub }) ||
        parseUserId({ userId: payload?.id });
      if (userId > 0) return userId;
    } catch (_) {
      // keep trying with next secret
    }
  }

  return 0;
}

function resolveUserIdFromHandshake(socket: Socket): number {
  const auth: any = socket.handshake?.auth ?? {};
  const query: any = socket.handshake?.query ?? {};
  const headers: any = socket.handshake?.headers ?? {};

  const directUserId =
    parseUserId(auth) ||
    parseUserId(query) ||
    parseUserId(headers) ||
    parseUserId({
      userId:
        auth?.user_id ??
        query?.user_id ??
        headers?.["x-user-id"] ??
        headers?.["x-userid"],
    });

  const token = resolveTokenFromSources(auth, query, headers);
  const tokenUserId = resolveUserIdFromToken(token);
  if (tokenUserId > 0) {
    if (directUserId > 0 && directUserId !== tokenUserId) {
      console.log(
        `[socket] handshake rejected user mismatch directUserId=${directUserId} tokenUserId=${tokenUserId} socket=${socket.id}`
      );
      return 0;
    }
    return tokenUserId;
  }

  if (ALLOW_SOCKET_USERID_FALLBACK && directUserId > 0) {
    return directUserId;
  }

  return 0;
}

function emitChatsRefresh(socket: Socket, userId: number) {
  if (!Number.isFinite(userId) || userId <= 0) return;
  let delivered = 0;

  for (const s of socket.nsp.sockets.values()) {
    const uid = Number((s.data as any)?.userId ?? 0);
    if (uid !== userId) continue;
    s.emit(`chats/${userId}`);
    s.emit("chats", { userId });
    delivered++;
  }

  // Seguridad/realtime: nunca hacer broadcast global de refresco de chats.
  // Si no hay sockets autenticados del usuario, simplemente no se emite.
  if (delivered === 0) return;
}

function emitChatStatusToUserSockets(
  socket: Socket,
  userId: number,
  chatId: number,
  payload: any
) {
  if (!Number.isFinite(userId) || userId <= 0) return;
  const roomEvent = `room/chat/status/${chatId}`;
  const legacyEvent = `chat/status/${chatId}`;

  for (const s of socket.nsp.sockets.values()) {
    const uid = Number((s.data as any)?.userId ?? 0);
    if (uid !== userId) continue;
    s.emit(roomEvent, payload);
    s.emit(legacyEvent, payload);
  }
}

function emitChatStatusWithRetryToSender(
  socket: Socket,
  senderId: number,
  chatId: number,
  payload: any
) {
  if (!Number.isFinite(senderId) || senderId <= 0) return;
  emitChatStatusToUserSockets(socket, senderId, chatId, payload);
  setTimeout(() => emitChatStatusToUserSockets(socket, senderId, chatId, payload), 400);
  setTimeout(() => emitChatStatusToUserSockets(socket, senderId, chatId, payload), 1200);
}

async function emitChatsRefreshForChat(socket: Socket, chatId: number) {
  const links = await Chat_User.findAll({
    where: { chatId },
    attributes: ["userId"],
    raw: true,
  });

  for (const link of links as any[]) {
    const uid = Number(link.userId);
    if (Number.isFinite(uid) && uid > 0) {
      emitChatsRefresh(socket, uid);
    }
  }
}

async function getDistinctRoomUserIds(socket: Socket, chatId: number): Promise<number[]> {
  const roomSockets = await socket.nsp.in(chatRoom(chatId)).fetchSockets();
  const unique = new Set<number>();
  for (const s of roomSockets as any[]) {
    const uid = Number((s?.data as any)?.userId ?? 0);
    if (Number.isFinite(uid) && uid > 0) unique.add(uid);
  }
  return [...unique];
}

async function emitLegacyChatEventToParticipants(
  socket: Socket,
  chatId: number,
  event: string,
  data: any
) {
  const participantIds = await getChatParticipantUserIds(chatId);
  for (const userId of participantIds) {
    socket.nsp.to(userRoom(userId)).emit(event, data);
  }
}

/**
 * ✅ EMIT HÍBRIDO (Room + Legacy)
 * - Nuevo (APK nueva): room/<event> (room del chat)
 * - Legacy (APK vieja): <event> (solo sockets de participantes)
 */
function emitChatHybrid(socket: Socket, chatId: number, event: string, data: any) {
  // NUEVO (rooms)
  socket.to(chatRoom(chatId)).emit(`room/${event}`, data);

  // LEGACY seguro: solo usuarios participantes del chat (NO broadcast global).
  void emitLegacyChatEventToParticipants(socket, chatId, event, data).catch((err) => {
    console.log("❌ emit legacy chat error", err);
  });

  // Compatibilidad extra con clientes que escuchan evento genérico.
  if (/^chat\/\d+$/.test(event)) {
    // Solo dentro del room activo para evitar mezcla entre conversaciones.
    socket.to(chatRoom(chatId)).emit("chat", data);
  } else if (/^chat\/status\/\d+$/.test(event)) {
    // Solo dentro del room activo para evitar mezcla entre conversaciones.
    socket.to(chatRoom(chatId)).emit("chat:status", data);
  } else if (/^chat\/typing\/\d+$/.test(event)) {
    // Solo dentro del room activo para evitar mezcla entre conversaciones.
    socket.to(chatRoom(chatId)).emit("chat:typing", data);
  } else if (/^chat\/reaction\/\d+$/.test(event)) {
    // Solo dentro del room activo para evitar mezcla entre conversaciones.
    socket.to(chatRoom(chatId)).emit("chat:reaction", data);
  }
}

/**
 * Normaliza reactions:
 * - DB es JSON ✅, pero por seguridad aceptamos null / string / object.
 * - Devuelve { emoji: [userIds...] }
 */
function normalizeReactions(raw: any): ReactionMap {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return normalizeReactions(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (typeof raw !== "object") return {};

  const out: ReactionMap = {};
  for (const k of Object.keys(raw)) {
    const v = (raw as any)[k];
    if (Array.isArray(v)) {
      out[k] = v
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (out[k].length === 0) delete out[k];
    }
  }
  return out;
}

function addUnique(arr: number[], id: number) {
  if (!arr.includes(id)) arr.push(id);
}

export const socketController = (socket: Socket) => {
  console.log(`Cliente conectado ${socket.id}`);

  const auth: any = socket.handshake?.auth ?? {};
  const query: any = socket.handshake?.query ?? {};
  const headers: any = socket.handshake?.headers ?? {};
  const handshakeToken = resolveTokenFromSources(auth, query, headers);
  const handshakeAuthToken = normalizeToken(handshakeToken);
  const handshakeTokenUserId = resolveUserIdFromToken(handshakeToken);

  const handshakeUserId = resolveUserIdFromHandshake(socket);
  if (handshakeUserId > 0) {
    (socket.data as any).userId = handshakeUserId;
    (socket.data as any).authenticatedByToken = handshakeTokenUserId > 0;
    (socket.data as any).authToken = handshakeAuthToken || null;
    (socket.data as any).sessionValidated = false;
    (socket.data as any).sessionValidatedAt = 0;
    socket.join(userRoom(handshakeUserId));
    console.log(
      `[socket] bind userId=${handshakeUserId} source=handshake tokenAuth=${handshakeTokenUserId > 0} socket=${socket.id}`
    );
    if ((socket.data as any).authenticatedByToken) {
      void (async () => {
        const validSession = await validateSocketSession(socket);
        if (validSession) return;

        socket.leave(userRoom(handshakeUserId));
        (socket.data as any).userId = 0;
        (socket.data as any).authenticatedByToken = false;
        (socket.data as any).authToken = null;
        (socket.data as any).sessionValidated = false;
        (socket.data as any).sessionValidatedAt = 0;
        console.log(`[socket] handshake rejected invalid session socket=${socket.id}`);
        socket.emit("auth:error", { event: "handshake", code: "INVALID_SESSION" });
      })().catch((err) => {
        console.log("❌ handshake session validation error", err);
      });
    }
  } else {
    (socket.data as any).authenticatedByToken = false;
    (socket.data as any).authToken = null;
    (socket.data as any).sessionValidated = false;
    (socket.data as any).sessionValidatedAt = 0;
    console.log(`[socket] bind userId=0 source=handshake socket=${socket.id}`);
  }

  socket.on("bind-user", async (payload: any) => {
    try {
      const payloadUserId = parseUserId(payload);
      const bindTokenRaw = resolveTokenFromSources(payload);
      const bindAuthToken = normalizeToken(bindTokenRaw);
      const tokenUserId = resolveUserIdFromToken(bindTokenRaw);
      const socketUserId = getSocketUserId(socket);
      const existingTokenAuth = Boolean((socket.data as any)?.authenticatedByToken);

      let resolvedUserId = 0;
      let tokenAuthenticated = existingTokenAuth;

      if (tokenUserId > 0) {
        resolvedUserId = tokenUserId;
        tokenAuthenticated = true;
      } else if (existingTokenAuth && socketUserId > 0) {
        resolvedUserId = socketUserId;
        tokenAuthenticated = true;
      } else if (ALLOW_SOCKET_USERID_FALLBACK) {
        resolvedUserId = payloadUserId > 0 ? payloadUserId : socketUserId;
        tokenAuthenticated = false;
      }
      if (!resolvedUserId) {
        console.log(`[socket] bind-user rejected unauthenticated socket=${socket.id}`);
        socket.emit("auth:error", { event: "bind-user", code: "UNAUTHENTICATED" });
        return;
      }

      if (payloadUserId > 0 && payloadUserId !== resolvedUserId) {
        console.log(
          `[socket] bind-user rejected user mismatch socket=${socket.id} resolvedUserId=${resolvedUserId} payloadUserId=${payloadUserId}`
        );
        socket.emit("auth:error", { event: "bind-user", code: "USER_MISMATCH" });
        return;
      }

      (socket.data as any).userId = resolvedUserId;
      (socket.data as any).authenticatedByToken = tokenAuthenticated;
      (socket.data as any).authToken = tokenAuthenticated
        ? bindAuthToken || (socket.data as any).authToken || null
        : null;
      (socket.data as any).sessionValidated = false;
      (socket.data as any).sessionValidatedAt = 0;
      if (tokenAuthenticated) {
        const validSession = await validateSocketSession(socket);
        if (!validSession) {
          (socket.data as any).userId = 0;
          (socket.data as any).authenticatedByToken = false;
          (socket.data as any).authToken = null;
          (socket.data as any).sessionValidated = false;
          (socket.data as any).sessionValidatedAt = 0;
          console.log(`[socket] bind-user rejected invalid session socket=${socket.id}`);
          socket.emit("auth:error", { event: "bind-user", code: "INVALID_SESSION" });
          return;
        }
      }
      socket.join(userRoom(resolvedUserId));
      console.log(
        `[socket] bind userId=${resolvedUserId} source=bind-user tokenAuth=${tokenAuthenticated} socket=${socket.id}`
      );
      socket.emit("bind-user:ok", { userId: resolvedUserId });
    } catch (e) {
      console.log("❌ bind-user error", e);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Cliente desconectado ${socket.id}`);
  });

  ////////////////////// Services ////////////////////////
  socket.on("services", (service: Service) => {
    socket.broadcast.emit("services", service);
  });

  ////////////////////// Offer ///////////////////////////
  socket.on("offers", (offer: Offer) => {
    socket.broadcast.emit(`offers/${offer.serviceId}`, offer);
  });

  ////////////////////// Post comments ///////////////////////////
  socket.on("post/updated", (payload: any) => {
    const normalized = normalizePostUpdatedPayload(payload);
    if (!normalized.postId) return;

    socket.broadcast.emit("post/updated", normalized);
    socket.broadcast.emit("find/post/updated", normalized);
    if (EMIT_POSTS_EVENT_ON_POST_ACTIVITY) {
      socket.broadcast.emit("posts", normalized);
    }

    if (normalized.action === "liked" || normalized.action === "unliked") {
      socket.broadcast.emit("post/liked", normalized);
    }
    if (normalized.action === "saved" || normalized.action === "unsaved") {
      socket.broadcast.emit("post/saved", normalized);
    }
  });

  socket.on("post/commented", (payload: any) => {
    const normalized = normalizePostCommentedPayload(payload);
    if (!normalized.postId) return;

    socket.broadcast.emit("post/commented", normalized);
    socket.broadcast.emit("find/post/commented", normalized);
    if (EMIT_POSTS_EVENT_ON_POST_ACTIVITY) {
      socket.broadcast.emit("posts", normalized);
    }
  });

  socket.on("post/comment-deleted", (payload: any) => {
    const normalized = normalizePostCommentDeletedPayload(payload);
    if (!normalized.postId) return;

    socket.broadcast.emit("post/comment-deleted", normalized);
    socket.broadcast.emit("find/post/comment-deleted", normalized);
    if (EMIT_POSTS_EVENT_ON_POST_ACTIVITY) {
      socket.broadcast.emit("posts", normalized);
    }
  });

  ////////////////////// Reel / Orbit ///////////////////////////
  socket.on("reel/created", (payload: any) => {
    const normalized = normalizeReelRealtimePayload(payload, "created");
    if (!normalized.reelId) return;

    socket.broadcast.emit("reel/created", normalized);
    socket.broadcast.emit("orbit/created", normalized);
    socket.broadcast.emit("find/reel/created", normalized);
    socket.broadcast.emit("reels", normalized);
  });

  socket.on("reel/updated", (payload: any) => {
    const normalized = normalizeReelRealtimePayload(payload, "updated");
    if (!normalized.reelId) return;

    socket.broadcast.emit("reel/updated", normalized);
    socket.broadcast.emit("orbit/updated", normalized);
    socket.broadcast.emit("find/reel/updated", normalized);
    socket.broadcast.emit("reels", normalized);
  });

  socket.on("orbit/ring-updated", (payload: any) => {
    const normalized = normalizeOrbitRingUpdatedPayload(payload);
    if (!normalized) return;

    socket.broadcast.emit("orbit/ring-updated", normalized);
  });

  socket.on("reel/deleted", (payload: any) => {
    const normalized = normalizeReelDeletedPayload(payload);
    if (!normalized.reelId) return;

    socket.broadcast.emit("reel/deleted", normalized);
    socket.broadcast.emit("orbit/deleted", normalized);
    socket.broadcast.emit("find/reel/deleted", normalized);
    if (EMIT_REELS_EVENT_ON_REEL_DELETE) {
      socket.broadcast.emit("reels", normalized);
    }
  });

  socket.on("reel/commented", (payload: any) => {
    const normalized = normalizeReelCommentedPayload(payload);
    if (!normalized.reelId) return;

    socket.broadcast.emit("reel/commented", normalized);
    socket.broadcast.emit("orbit/commented", normalized);
    socket.broadcast.emit("find/reel/commented", normalized);
    socket.broadcast.emit("reels", normalized);
  });

  socket.on("reel/comment-deleted", (payload: any) => {
    const normalized = normalizeReelCommentDeletedPayload(payload);
    if (!normalized.reelId) return;

    socket.broadcast.emit("reel/comment-deleted", normalized);
    socket.broadcast.emit("orbit/comment-deleted", normalized);
    socket.broadcast.emit("find/reel/comment-deleted", normalized);
    socket.broadcast.emit("reels", normalized);
  });

  //////////////////////////// Chat //////////////////////

  // ✅ join a room del chat (APK nueva)
  socket.on("chat:join", (payload: ChatJoinPayload) => {
    try {
      const chatId = parseChatId(payload);
      if (!chatId) {
        console.log(`[socket] chat:join ignored invalid payload socket=${socket.id} payload=${JSON.stringify(payload)}`);
        return;
      }

      void (async () => {
        const actorUserId = await requireAuthenticatedUser(
          socket,
          "chat:join",
          parseUserId(payload)
        );
        if (!actorUserId) return;
        if (
          !consumeSocketRateLimit({
            socket,
            limiter: socketChatMetaRateLimiter,
            event: "chat:join",
            userId: actorUserId,
            chatId,
          })
        ) {
          return;
        }

        const isMember = await isUserParticipantInChat(chatId, actorUserId);
        if (!isMember) {
          console.log(
            `[socket] chat:join rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
          );
          socket.emit("auth:error", { event: "chat:join", code: "FORBIDDEN_CHAT", chatId });
          return;
        }

        leaveOtherChatRooms(socket, chatId);
        socket.join(chatRoom(chatId));

        const roomSize = socket.nsp.adapter.rooms.get(chatRoom(chatId))?.size ?? 0;
        console.log(
          `[socket] chat:join chatId=${chatId} socket=${socket.id} userId=${actorUserId} roomSize=${roomSize}`
        );

        const now = new Date();
        const pending = await Message.findAll({
          where: {
            chatId,
            senderId: { [Op.ne]: actorUserId },
            status: { [Op.in]: ["sent", "delivered"] },
            deletedBy: { [Op.in]: [0, actorUserId] },
          },
          attributes: ["id", "senderId", "deliveredAt"],
        });
        let markedAsReadCount = 0;

        for (const item of pending as any[]) {
          const patch: any = { status: "read", readAt: now };
          if (!item.deliveredAt) patch.deliveredAt = now;

          const [updatedCount] = await Message.update(patch, {
            where: {
              id: item.id,
              status: { [Op.in]: ["sent", "delivered"] },
            },
          });

          if (!updatedCount) continue;
          markedAsReadCount += Number(updatedCount) || 0;

          emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
            ...buildStatusPayload({
              chatId,
              messageId: Number(item.id),
              status: "read" as ChatStatus,
              readAt: now.toISOString(),
              deliveredAt: now.toISOString(),
            }),
          });

          const senderId = Number(item.senderId);
          const statusPayload = {
            ...buildStatusPayload({
              chatId,
              messageId: Number(item.id),
              status: "read" as ChatStatus,
              readAt: now.toISOString(),
              deliveredAt: now.toISOString(),
            }),
          };
          emitChatStatusWithRetryToSender(socket, senderId, chatId, statusPayload);
          emitChatsRefresh(socket, senderId);
        }

        if (markedAsReadCount > 0) {
          await decrementUnreadCountForChatUser(chatId, actorUserId, markedAsReadCount);
        }
        // Asegura consistencia de badge incluso si había desfase previo en contador.
        await resetUnreadCountForChatUser(chatId, actorUserId);

        emitChatsRefresh(socket, actorUserId);
      })().catch((err) => console.log("❌ chat:join mark-read error", err));
    } catch (e) {
      console.log("❌ chat:join error", e);
    }
  });
  // ✅ leave room (APK nueva)
  socket.on("chat:leave", async (payload: ChatJoinPayload) => {
    try {
      const chatId = parseChatId(payload);
      if (!chatId) {
        console.log(`[socket] chat:leave ignored invalid payload socket=${socket.id} payload=${JSON.stringify(payload)}`);
        return;
      }
      const actorUserId = await requireAuthenticatedUser(
        socket,
        "chat:leave",
        parseUserId(payload)
      );
      if (!actorUserId) return;
      socket.leave(chatRoom(chatId));
      const roomSize = socket.nsp.adapter.rooms.get(chatRoom(chatId))?.size ?? 0;
      console.log(
        `[socket] chat:leave chatId=${chatId} socket=${socket.id} userId=${actorUserId} roomSize=${roomSize}`
      );
    } catch (e) {
      console.log("❌ chat:leave error", e);
    }
  });

  // ✅ resync de mensajes al reconectar (chatId + lastMessageId)
  socket.on("chat:sync", async (payload: ChatSyncPayload) => {
    try {
      const chatId = parseChatId(payload);
      if (!chatId) {
        console.log(
          `[socket] chat:sync ignored invalid payload socket=${socket.id} payload=${JSON.stringify(payload)}`
        );
        return;
      }

      const actorUserId = await requireAuthenticatedUser(
        socket,
        "chat:sync",
        parseUserId(payload)
      );
      if (!actorUserId) return;
      if (
        !consumeSocketRateLimit({
          socket,
          limiter: socketChatMetaRateLimiter,
          event: "chat:sync",
          userId: actorUserId,
          chatId,
        })
      ) {
        return;
      }

      const isMember = await isUserParticipantInChat(chatId, actorUserId);
      if (!isMember) {
        console.log(
          `[socket] chat:sync rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
        );
        socket.emit("auth:error", { event: "chat:sync", code: "FORBIDDEN_CHAT", chatId });
        return;
      }

      leaveOtherChatRooms(socket, chatId);
      socket.join(chatRoom(chatId));

      const lastMessageId = parseLastMessageId(payload);
      const limit = parseSyncLimit(payload, 120);
      const where: any = {
        chatId,
        deletedBy: { [Op.in]: [0, actorUserId] },
      };
      if (lastMessageId > 0) {
        where.id = { [Op.gt]: lastMessageId };
      }

      const missingMessages = await Message.findAll({
        where,
        order: [["id", "ASC"]],
        limit,
        include: [
          {
            model: Message,
            as: "replyTo",
            required: false,
            attributes: [
              "id",
              "text",
              "messageType",
              "mediaUrl",
              "mediaMime",
              "mediaDurationMs",
              "mediaSizeBytes",
              "waveform",
              "metadata",
              "senderId",
              "date",
            ],
          },
          {
            model: User,
            as: "sender",
            required: false,
            attributes: [
              "id",
              "name",
              "last_name",
              "username",
              "image_profil",
              "is_deleted",
            ],
          },
        ],
      });

      let statusEvents = 0;
      for (const raw of missingMessages as any[]) {
        const msg = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
        socket.emit(`room/chat/${chatId}`, msg);
        socket.emit(`chat/${chatId}`, msg);

        if (Number(msg?.senderId) === actorUserId) {
          const status = String(msg?.status ?? "");
          if (status === "read" || status === "delivered") {
            const payloadStatus = buildStatusPayload({
              chatId,
              messageId: Number(msg.id),
              status: status as ChatStatus,
              deliveredAt: msg?.deliveredAt
                ? new Date(msg.deliveredAt).toISOString()
                : undefined,
              readAt: msg?.readAt ? new Date(msg.readAt).toISOString() : undefined,
            });
            socket.emit(`room/chat/status/${chatId}`, payloadStatus);
            socket.emit(`chat/status/${chatId}`, payloadStatus);
            statusEvents++;
          }
        }
      }

      socket.emit(`chat/sync/${chatId}`, {
        chatId,
        fromMessageId: lastMessageId || null,
        syncedCount: missingMessages.length,
        statusEvents,
      });

      if (missingMessages.length > 0) {
        console.log(
          `[socket] chat:sync chatId=${chatId} socket=${socket.id} userId=${actorUserId} fromId=${lastMessageId || 0} synced=${missingMessages.length} limit=${limit}`
        );
      }
    } catch (e) {
      console.log("❌ chat:sync error", e);
    }
  });

  // ✅ refresh de lista de chats del usuario autenticado
  socket.on("chats", async (payload: any) => {
    try {
      const payloadUserId = parseUserId(payload);
      const actorUserId = await requireAuthenticatedUser(
        socket,
        "chats",
        payloadUserId
      );
      if (!actorUserId) return;
      emitChatsRefresh(socket, actorUserId);
    } catch (e) {
      console.log("❌ chats event error", e);
    }
  });

  /**
   * ✅ MENSAJE NUEVO
   * - Nuevo:   room/chat/{chatId}
   * - Legacy:  chat/{chatId}
   */
  socket.on("chat", async (message: any) => {
    try {
      const chatId = parseChatId(message?.chatId != null ? message : message?.chat);
      if (!chatId) return;

      const payloadUserId = parseUserId({
        userId: message?.senderId ?? message?.sender?.id ?? message?.userId,
      });
      const actorUserId = await requireAuthenticatedUser(socket, "chat", payloadUserId);
      if (!actorUserId) return;
      if (
        !consumeSocketRateLimit({
          socket,
          limiter: socketChatSendRateLimiter,
          event: "chat",
          userId: actorUserId,
          chatId,
        })
      ) {
        return;
      }

      const isMember = await isUserParticipantInChat(chatId, actorUserId);
      if (!isMember) {
        console.log(
          `[socket] chat rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
        );
        socket.emit("auth:error", { event: "chat", code: "FORBIDDEN_CHAT", chatId });
        return;
      }

      const senderId = actorUserId;

      emitChatHybrid(socket, chatId, `chat/${chatId}`, message);

      // ✅ Si hay ambos usuarios en la sala, marcar inmediatamente como leído (azul).
      void (async () => {
        const messageId = parseMessageId(message);
        if (!messageId) return;

        const roomUserIds = await getDistinctRoomUserIds(socket, chatId);
        const hasOtherParticipant =
          senderId > 0
            ? roomUserIds.some((uid) => uid !== senderId)
            : roomUserIds.length >= 2;

        if (!hasOtherParticipant) return;

        const now = new Date();
        const [updatedCount] = await Message.update(
          {
            status: "read",
            deliveredAt: now,
            readAt: now,
          },
          {
            where: {
              id: messageId,
              chatId,
              senderId,
              status: { [Op.in]: ["sent", "delivered"] },
            },
          }
        );

        if (!updatedCount) return;

        const readerUserId = roomUserIds.find((uid) => uid !== senderId) ?? 0;
        if (readerUserId > 0) {
          await decrementUnreadCountForChatUser(chatId, readerUserId, Number(updatedCount) || 0);
        }

        emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
          ...buildStatusPayload({
            chatId,
            messageId,
            status: "read" as ChatStatus,
            readAt: now.toISOString(),
            deliveredAt: now.toISOString(),
          }),
        });

        const autoStatusPayload = {
          ...buildStatusPayload({
            chatId,
            messageId,
            status: "read" as ChatStatus,
            readAt: now.toISOString(),
            deliveredAt: now.toISOString(),
          }),
        };
        emitChatStatusWithRetryToSender(socket, senderId, chatId, autoStatusPayload);

        await emitChatsRefreshForChat(socket, chatId);
      })().catch((err) => console.log("❌ chat auto-read error", err));
    } catch (e) {
      console.log("❌ chat error", e);
    }
  });

  /**
   * ✅ TYPING
   * - Nuevo:   room/chat/typing/{chatId}
   * - Legacy:  chat/typing/{chatId}
   */
  socket.on("chat:typing", (payload: ChatTypingPayload) => {
    try {
      const chatId = parseChatId(payload);
      const typing = !!payload?.typing;

      if (!chatId) return;
      void (async () => {
        const userId = await requireAuthenticatedUser(
          socket,
          "chat:typing",
          parseUserId(payload)
        );
        if (!userId) return;

        const isMember = await isUserParticipantInChat(chatId, userId);
        if (!isMember) {
          console.log(
            `[socket] chat:typing rejected forbidden chatId=${chatId} socket=${socket.id} userId=${userId}`
          );
          return;
        }

        emitChatHybrid(socket, chatId, `chat/typing/${chatId}`, {
          chatId,
          userId,
          typing,
        });
      })().catch((err) => console.log("❌ chat:typing membership error", err));
    } catch (e) {
      console.log("❌ chat:typing error", e);
    }
  });

  /**
   * ✅ REACCIONES (emoji)
   * - DB: messages.reactions es JSON ✅ (ya lo verificaste)
   * Reglas:
   * - 1 reacción por usuario por mensaje
   * - mismo emoji => toggle OFF
   * - otro emoji => replace
   *
   * Emit:
   * - Nuevo:   room/chat/reaction/{chatId}
   * - Legacy:  chat/reaction/{chatId}
   */
  socket.on("chat:reaction", async (payload: ChatReactionPayload) => {
    try {
      const chatId = parseChatId(payload);
      const messageId = parseMessageId(payload);
      const userId = await requireAuthenticatedUser(
        socket,
        "chat:reaction",
        parseUserId(payload)
      );
      const emoji = String(payload?.emoji ?? "").trim();

      if (!chatId || !messageId || !userId || !emoji) return;
      const isMember = await isUserParticipantInChat(chatId, userId);
      if (!isMember) {
        console.log(
          `[socket] chat:reaction rejected forbidden chatId=${chatId} socket=${socket.id} userId=${userId}`
        );
        return;
      }

      const msg: any = await Message.findByPk(messageId, {
        attributes: ["id", "chatId", "senderId", "text", "reactions"],
      });
      if (!msg) return;
      if (Number(msg.chatId) !== chatId) {
        console.log(
          `[socket] chat:reaction rejected message mismatch chatId=${chatId} messageId=${messageId} realChatId=${Number(msg.chatId)} socket=${socket.id} userId=${userId}`
        );
        socket.emit("auth:error", {
          event: "chat:reaction",
          code: "FORBIDDEN_MESSAGE",
          chatId,
          messageId,
        });
        return;
      }

      const current = normalizeReactions(msg.reactions);
      let shouldNotify = false;

      // Detectar emoji previo del usuario
      let prevEmoji: string | null = null;
      for (const k of Object.keys(current)) {
        if ((current[k] ?? []).includes(userId)) {
          prevEmoji = k;
          break;
        }
      }

      if (prevEmoji && prevEmoji === emoji) {
        // TOGGLE OFF
        current[emoji] = (current[emoji] ?? []).filter((id) => id !== userId);
        if (current[emoji].length === 0) delete current[emoji];
      } else {
        // QUITAR de cualquier emoji anterior
        for (const k of Object.keys(current)) {
          current[k] = (current[k] ?? []).filter((id) => id !== userId);
          if (current[k].length === 0) delete current[k];
        }
        // AGREGAR al nuevo emoji
        const list = current[emoji] ?? [];
        addUnique(list, userId);
        current[emoji] = list;
        shouldNotify = true;
      }

      // ✅ Guardar limpio (JSON)
      await Message.update({ reactions: current }, { where: { id: messageId } });

      emitChatHybrid(socket, chatId, `chat/reaction/${chatId}`, {
        chatId,
        messageId,
        userId,
        emoji,
        reactions: current,
      });

      if (shouldNotify && msg.senderId && msg.senderId !== userId) {
        const rawPreview = (msg.text ?? "").toString().trim();
        const snippet =
          rawPreview.length > 60 ? `${rawPreview.slice(0, 60)}...` : rawPreview;
        const notificationBody = snippet
          ? `Reacted ${emoji} to: ${snippet}`
          : `Reacted ${emoji} to your message`;

        await sendNotification({
          userId: msg.senderId,
          interactorId: userId,
          messageId,
          type: "message",
          message: notificationBody,
          senderName: "New reaction",
        });
      }
    } catch (e) {
      console.log("❌ chat:reaction error", e);
    }
  });

  /**
   * ✅ ENTREGADO (✔✔ gris)
   * Solo si estaba "sent"
   *
   * Emit:
   * - Nuevo:   room/chat/status/{chatId}
   * - Legacy:  chat/status/{chatId}
   */
  socket.on("chat:delivered", async (payload: ChatStatusPayload) => {
    try {
      const chatId = parseChatId(payload);
      const messageId = parseMessageId(payload);
      if (!chatId || !messageId) return;
      const actorUserId = await requireAuthenticatedUser(
        socket,
        "chat:delivered",
        parseUserId(payload)
      );
      if (!actorUserId) return;
      const isMember = await isUserParticipantInChat(chatId, actorUserId);
      if (!isMember) {
        console.log(
          `[socket] chat:delivered rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
        );
        return;
      }

      const msg: any = await Message.findByPk(messageId, {
        attributes: ["id", "chatId", "senderId", "status"],
      });
      if (!msg) return;
      if (Number(msg.chatId) !== chatId) return;
      if (Number(msg.senderId) === actorUserId) {
        console.log(
          `[socket] ignore self-delivered chatId=${chatId} messageId=${messageId} userId=${actorUserId}`
        );
        return;
      }

      const deliveredAt = new Date();

      const [updatedCount] = await Message.update(
        { status: "delivered", deliveredAt },
        { where: { id: messageId, status: "sent" } }
      );

      if (!updatedCount) return;

      emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
        ...buildStatusPayload({
          chatId,
          messageId,
          status: "delivered" as ChatStatus,
          deliveredAt: deliveredAt.toISOString(),
        }),
      });

      const senderId = Number(msg?.senderId);
      const statusPayload = {
        ...buildStatusPayload({
          chatId,
          messageId,
          status: "delivered" as ChatStatus,
          deliveredAt: deliveredAt.toISOString(),
        }),
      };
      emitChatStatusWithRetryToSender(socket, senderId, chatId, statusPayload);
      emitChatsRefresh(socket, senderId);
      emitChatsRefresh(socket, actorUserId);
    } catch (e) {
      console.log("❌ chat:delivered error", e);
    }
  });

  /**
   * ✅ LEÍDO (✔✔ azul)
   * Permite pasar a read desde "sent" o "delivered"
   */
  socket.on("chat:read", async (payload: ChatStatusPayload) => {
    try {
      const chatId = parseChatId(payload);
      const messageId = parseMessageId(payload);
      if (!chatId || !messageId) return;
      const actorUserId = await requireAuthenticatedUser(
        socket,
        "chat:read",
        parseUserId(payload)
      );
      if (!actorUserId) return;
      const isMember = await isUserParticipantInChat(chatId, actorUserId);
      if (!isMember) {
        console.log(
          `[socket] chat:read rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
        );
        return;
      }

      const now = new Date();

      const msg: any = await Message.findByPk(messageId);
      if (!msg) return;
      if (Number(msg.chatId) !== chatId) return;
      if (Number(msg.senderId) === actorUserId) {
        console.log(
          `[socket] ignore self-read chatId=${chatId} messageId=${messageId} userId=${actorUserId}`
        );
        return;
      }
      if (msg.status === "read") {
        const alreadyReadAt = msg.readAt
          ? new Date(msg.readAt).toISOString()
          : now.toISOString();
        const alreadyDeliveredAt = msg.deliveredAt
          ? new Date(msg.deliveredAt).toISOString()
          : alreadyReadAt;

        const statusPayload = {
          ...buildStatusPayload({
            chatId,
            messageId,
            status: "read" as ChatStatus,
            readAt: alreadyReadAt,
            deliveredAt: alreadyDeliveredAt,
          }),
        };

        emitChatHybrid(socket, chatId, `chat/status/${chatId}`, statusPayload);
        const senderId = Number(msg.senderId);
        emitChatStatusWithRetryToSender(socket, senderId, chatId, statusPayload);
        emitChatsRefresh(socket, senderId);
        emitChatsRefresh(socket, actorUserId);
        return;
      }

      const updateData: any = { status: "read", readAt: now };

      // si estaba sent y no tenía deliveredAt, lo seteamos también
      if (msg.status === "sent" && !msg.deliveredAt) updateData.deliveredAt = now;

      const [updatedCount] = await Message.update(updateData, {
        where: {
          id: messageId,
          status: { [Op.in]: ["sent", "delivered"] },
        },
      });

      if (!updatedCount) return;
      await decrementUnreadCountForChatUser(chatId, actorUserId, Number(updatedCount) || 0);

      emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
        ...buildStatusPayload({
          chatId,
          messageId,
          status: "read" as ChatStatus,
          readAt: now.toISOString(),
          deliveredAt: now.toISOString(),
        }),
      });

      const senderId = Number(msg.senderId);
      const statusPayload = {
        ...buildStatusPayload({
          chatId,
          messageId,
          status: "read" as ChatStatus,
          readAt: now.toISOString(),
          deliveredAt: now.toISOString(),
        }),
      };
      emitChatStatusWithRetryToSender(socket, senderId, chatId, statusPayload);
      emitChatsRefresh(socket, senderId);
      emitChatsRefresh(socket, actorUserId);
    } catch (e) {
      console.log("❌ chat:read error", e);
    }
  });

  ////////////////////// Notification /////////////////////
  socket.on("notification", (notification: Notification) => {
    socket.broadcast.emit(`notification/${notification.userId}`, notification);
  });
};
