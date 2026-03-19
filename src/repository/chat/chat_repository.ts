import { Op, QueryTypes, Sequelize } from "sequelize";
import { createHash, createHmac } from "crypto";
import Chat from "../../_models/chat/chat";
import User from "../../_models/user/user";
import sequelize from "../../_db/connection";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Chat_User from "../../_models/chat/chat_user";
import Group from "../../_models/chat/group";
import UserBlock from "../../_models/block/block";
import { attachActiveOrbitStateToUsers } from "../reel/orbit_ring_projection";

const excludeKeys = ["createdAt", "updatedAt", "password"];
const CHAT_ENABLE_HISTORY_PRUNE =
  String(process.env.CHAT_ENABLE_HISTORY_PRUNE ?? "0").trim() === "1";
const MAX_MESSAGES_PER_CHAT = Math.max(
  1,
  Number(process.env.CHAT_MAX_MESSAGES_PER_CHAT ?? 2000) || 2000
);
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const R2_REGION = "auto";
const R2_SERVICE = "s3";
const R2_DELETE_TTL_SECONDS = 60;
const CLIENT_MESSAGE_ID_COLUMN = "clientMessageId";
const CLIENT_MESSAGE_ID_UNIQUE_INDEX = "uq_messages_chat_sender_client_message_id";
const CLIENT_MESSAGE_ID_COLUMN_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.CLIENT_MESSAGE_ID_COLUMN_CACHE_TTL_MS ?? 60_000) || 60_000
);
const GROUP_CHAT_IDS_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.GROUP_CHAT_IDS_CACHE_TTL_MS ?? 30_000) || 30_000
);
const CHAT_USER_UNREAD_COUNT_COLUMN = "unreadCount";
const CHAT_USER_UNREAD_COUNT_COLUMN_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.CHAT_USER_UNREAD_COUNT_COLUMN_CACHE_TTL_MS ?? 60_000) || 60_000
);

export type ChatMessageType =
  | "text"
  | "voice"
  | "image"
  | "video"
  | "document"
  | "contact"
  | "share";

export type ChatMessagePayload = {
  text?: string | null;
  messageType?: ChatMessageType;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaDurationMs?: number | null;
  mediaSizeBytes?: number | null;
  waveform?: number[] | null;
  metadata?: Record<string, any> | null;
  clientMessageId?: string | null;
};

const CLIENT_MESSAGE_ID_METADATA_KEY = "_clientMessageId";
let hasClientMessageIdColumnCache: boolean | null = null;
let hasClientMessageIdColumnCheckedAtMs = 0;
let groupChatIdsCache: number[] | null = null;
let groupChatIdsCacheExpiresAtMs = 0;
let groupChatIdsInFlight: Promise<number[]> | null = null;
let hasChatUserUnreadCountColumnCache: boolean | null = null;
let hasChatUserUnreadCountColumnCheckedAtMs = 0;

const buildChatVisibleForUserWhere = (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  return {
    // Chat semantics:
    // - deletedBy = 0  => visible for both participants
    // - deletedBy = uid => hidden only for uid
    // - deletedBy = -1 => hidden for both participants
    deletedBy: { [Op.notIn]: [-1, userId] },
  };
};

const isMissingClientMessageIdColumnError = (error: any): boolean => {
  const dbCode = String(error?.original?.code ?? error?.parent?.code ?? "").trim();
  if (dbCode === "ER_BAD_FIELD_ERROR" || dbCode === "42703") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("unknown column") && message.includes(CLIENT_MESSAGE_ID_COLUMN.toLowerCase())
  );
};

const isClientMessageIdUniqueConstraintError = (error: any): boolean => {
  const dbCode = String(error?.original?.code ?? error?.parent?.code ?? "").trim();
  if (dbCode === "ER_DUP_ENTRY" || dbCode === "23505" || dbCode === "SQLITE_CONSTRAINT") {
    return true;
  }

  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes(CLIENT_MESSAGE_ID_UNIQUE_INDEX.toLowerCase()) ||
    message.includes(CLIENT_MESSAGE_ID_COLUMN.toLowerCase())
  );
};

const hasClientMessageIdColumn = async (forceRefresh = false): Promise<boolean> => {
  const now = Date.now();
  if (
    !forceRefresh &&
    hasClientMessageIdColumnCache !== null &&
    now - hasClientMessageIdColumnCheckedAtMs < CLIENT_MESSAGE_ID_COLUMN_CACHE_TTL_MS
  ) {
    return hasClientMessageIdColumnCache;
  }

  try {
    const rows = (await sequelize.query(
      `SHOW COLUMNS FROM \`messages\` LIKE '${CLIENT_MESSAGE_ID_COLUMN}'`,
      { type: QueryTypes.SELECT }
    )) as Array<Record<string, any>>;
    hasClientMessageIdColumnCache = Array.isArray(rows) && rows.length > 0;
  } catch (_) {
    hasClientMessageIdColumnCache = false;
  }

  hasClientMessageIdColumnCheckedAtMs = now;
  return hasClientMessageIdColumnCache;
};

const hasChatUserUnreadCountColumn = async (
  forceRefresh = false
): Promise<boolean> => {
  const now = Date.now();
  if (
    !forceRefresh &&
    hasChatUserUnreadCountColumnCache !== null &&
    now - hasChatUserUnreadCountColumnCheckedAtMs <
      CHAT_USER_UNREAD_COUNT_COLUMN_CACHE_TTL_MS
  ) {
    return hasChatUserUnreadCountColumnCache;
  }

  try {
    const rows = (await sequelize.query(
      `SHOW COLUMNS FROM \`chat_user\` LIKE '${CHAT_USER_UNREAD_COUNT_COLUMN}'`,
      { type: QueryTypes.SELECT }
    )) as Array<Record<string, any>>;
    hasChatUserUnreadCountColumnCache = Array.isArray(rows) && rows.length > 0;
  } catch (_error) {
    hasChatUserUnreadCountColumnCache = false;
  }

  hasChatUserUnreadCountColumnCheckedAtMs = now;
  return hasChatUserUnreadCountColumnCache;
};

const getUnreadCountByChatIds = async ({
  userId,
  chatIds,
}: {
  userId: number;
  chatIds: number[];
}): Promise<Map<number, number>> => {
  const uid = Number(userId);
  const uniqueChatIds = Array.from(
    new Set((chatIds ?? []).filter((chatId) => Number.isFinite(chatId) && chatId > 0))
  );
  const unreadCountByChatId = new Map<number, number>();
  if (!uniqueChatIds.length) return unreadCountByChatId;

  if (await hasChatUserUnreadCountColumn()) {
    const rows = (await sequelize.query(
      `
        SELECT cu.chatId AS chatId, cu.${CHAT_USER_UNREAD_COUNT_COLUMN} AS unreadCount
        FROM chat_user cu
        WHERE cu.userId = :userId
          AND cu.chatId IN (:chatIds)
      `,
      {
        replacements: {
          userId: uid,
          chatIds: uniqueChatIds,
        },
        type: QueryTypes.SELECT,
      }
    )) as Array<{ chatId?: number | string | null; unreadCount?: number | string | null }>;

    for (const row of rows) {
      const chatId = Number(row.chatId);
      if (!Number.isFinite(chatId) || chatId <= 0) continue;
      unreadCountByChatId.set(chatId, Math.max(0, Number(row.unreadCount ?? 0) || 0));
    }

    return unreadCountByChatId;
  }

  const unreadRows = await Message.findAll({
    where: {
      chatId: { [Op.in]: uniqueChatIds },
      senderId: { [Op.ne]: uid },
      deletedBy: { [Op.in]: [0, uid] },
      status: { [Op.in]: ["sent", "delivered"] },
    },
    attributes: [
      "chatId",
      [sequelize.fn("COUNT", sequelize.col("id")), "unreadCount"],
    ],
    group: ["chatId"],
    raw: true,
  });

  for (const row of unreadRows as any[]) {
    const cid = Number(row.chatId);
    if (!Number.isFinite(cid) || cid <= 0) continue;
    unreadCountByChatId.set(cid, Number(row.unreadCount ?? 0) || 0);
  }

  return unreadCountByChatId;
};

const buildLegacyClientMessageIdWhere = (clientMessageId: string) => ({
  [Op.and]: [
    Sequelize.literal(
      `JSON_UNQUOTE(JSON_EXTRACT(\`Message\`.\`metadata\`, '$.${CLIENT_MESSAGE_ID_METADATA_KEY}')) = ${sequelize.escape(
        clientMessageId
      )}`
    ),
  ],
});

const normalizeClientMessageId = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized;
};

const mergeClientMessageIdIntoMetadata = (
  metadata: Record<string, any> | null | undefined,
  clientMessageId: string | null
): Record<string, any> | null => {
  if (!clientMessageId) {
    return metadata ?? null;
  }

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return {
      ...metadata,
      [CLIENT_MESSAGE_ID_METADATA_KEY]: clientMessageId,
    };
  }

  return {
    [CLIENT_MESSAGE_ID_METADATA_KEY]: clientMessageId,
  };
};

const findMessageByClientMessageId = async ({
  chatId,
  senderId,
  clientMessageId,
}: {
  chatId: number;
  senderId: number;
  clientMessageId: string;
}) => {
  const supportsColumn = await hasClientMessageIdColumn();
  const whereByMetadata = {
    chatId,
    senderId,
    ...buildLegacyClientMessageIdWhere(clientMessageId),
  };

  const whereByColumn = {
    chatId,
    senderId,
    [CLIENT_MESSAGE_ID_COLUMN]: clientMessageId,
  } as any;

  try {
    return await Message.findOne({
      where: supportsColumn ? whereByColumn : whereByMetadata,
      attributes: ["id"],
      order: [["id", "DESC"]],
    });
  } catch (error) {
    if (supportsColumn && isMissingClientMessageIdColumnError(error)) {
      hasClientMessageIdColumnCache = false;
      hasClientMessageIdColumnCheckedAtMs = Date.now();
      return Message.findOne({
        where: whereByMetadata,
        attributes: ["id"],
        order: [["id", "DESC"]],
      });
    }
    throw error;
  }
};


export const add = async (body: any) => {
  const chat = await Chat.create(body);
  return chat;
};

export const gets = async () => {
  const chat = await Chat.findAll({ where: {} });
  return chat;
};

export const get = async (id: any) => {
  const chat = await Chat.findOne({ where: { id } });
  return chat;
};

export const update = async (id: any, body: any) => {
  const chatTemp = await Chat.findByPk(id);
  const chat = await chatTemp?.update(body);
  return [chat];
};

/**
 * Valida si hay un bloqueo entre dos usuarios (en cualquier direcciÃ³n).
 */
export const validateBlock = async (user_A: number, user_B: number): Promise<boolean> => {
  const block = await UserBlock.findOne({
    where: {
      [Op.or]: [
        { blocker_id: user_A, blocked_id: user_B },
        { blocker_id: user_B, blocked_id: user_A },
      ],
    },
    attributes: ["id"],
  });

  return !!block;
};

/**
 * âœ… INIT CHAT
 * - Si hay bloqueo => no crear chat/mensaje (devuelve null)
 * - replyToMessageId opcional (no rompe)
 */
export const initNewChat = async (
  currentUserId: any,
  otherUserId: any,
  messagePayload: ChatMessagePayload,
  replyToMessageId?: number | null
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  const otherUser = await User.findByPk(other);
  if ((otherUser as any)?.is_deleted) {
    return null;
  }

  if (await isBlockedEitherWay(me, other)) {
    // lo ideal es que tu controller convierta esto a 403
    return null;
  }

  // Mantener milisegundos evita empates de `date` en ráfagas.
  const now = new Date();
  const existingChatId = await findDirectChatIdByUsers(me, other);

  let chatId: number;
  let chat: any = null;

  if (!existingChatId) {
    const newChat = await Chat.create();
    chatId = newChat.id;

    await Chat_User.bulkCreate([
      { userId: me, chatId },
      { userId: other, chatId },
    ]);

    chat = newChat;
  } else {
    chatId = existingChatId;

    // Reactivar si estÃ¡ eliminado
    chat = await Chat.findByPk(chatId);
    if (chat && Number((chat as any).deletedBy) !== 0) {
      await chat.update({ deletedBy: 0 });
    }
  }

  const normalizedClientMessageId = normalizeClientMessageId(
    messagePayload?.clientMessageId
  );
  const supportsClientMessageIdColumn = await hasClientMessageIdColumn();

  if (normalizedClientMessageId) {
    const existingMessage = await findMessageByClientMessageId({
      chatId,
      senderId: me,
      clientMessageId: normalizedClientMessageId,
    });
    if (existingMessage) {
      return {
        chatId,
        messageId: Number((existingMessage as any).id),
        chat,
        deduplicated: true,
      };
    }
  }

  const createPayload: Record<string, any> = {
    text: messagePayload?.text ?? null,
    messageType: messagePayload?.messageType ?? "text",
    mediaUrl: messagePayload?.mediaUrl ?? null,
    mediaMime: messagePayload?.mediaMime ?? null,
    mediaDurationMs: messagePayload?.mediaDurationMs ?? null,
    mediaSizeBytes: messagePayload?.mediaSizeBytes ?? null,
    waveform: messagePayload?.waveform ?? null,
    metadata: mergeClientMessageIdIntoMetadata(
      messagePayload?.metadata ?? null,
      normalizedClientMessageId
    ),
    senderId: me,
    chatId,
    date: now,
    deletedBy: 0,
    replyToMessageId: replyToMessageId ?? null,
  };
  if (supportsClientMessageIdColumn && normalizedClientMessageId) {
    createPayload[CLIENT_MESSAGE_ID_COLUMN] = normalizedClientMessageId;
  }

  let createdMessage: any;
  try {
    createdMessage = await Message.create(createPayload);
  } catch (error) {
    if (supportsClientMessageIdColumn && isMissingClientMessageIdColumnError(error)) {
      hasClientMessageIdColumnCache = false;
      hasClientMessageIdColumnCheckedAtMs = Date.now();
      delete createPayload[CLIENT_MESSAGE_ID_COLUMN];
      createdMessage = await Message.create(createPayload);
    } else if (
      normalizedClientMessageId &&
      isClientMessageIdUniqueConstraintError(error)
    ) {
      const existingMessage = await findMessageByClientMessageId({
        chatId,
        senderId: me,
        clientMessageId: normalizedClientMessageId,
      });
      if (existingMessage) {
        return {
          chatId,
          messageId: Number((existingMessage as any).id),
          chat,
          deduplicated: true,
        };
      }
      throw error;
    } else {
      throw error;
    }
  }

  await incrementUnreadCountForChatUser(chatId, other, 1);

  if (CHAT_ENABLE_HISTORY_PRUNE) {
    await pruneChatHistory(chatId, MAX_MESSAGES_PER_CHAT);
  }

  return {
    chatId,
    messageId: Number(createdMessage.id),
    chat,
    deduplicated: false,
  };
};

/**
 * âœ… GET CHAT MESSAGES (FIX CRÃTICO)
 * Regla correcta de visibilidad segÃºn tu semÃ¡ntica:
 * - visible si deletedBy = 0 (nadie borrÃ³)
 * - visible si deletedBy = me (lo borrÃ³ el otro, o â€œborrado para 1â€ segÃºn tu lÃ³gica)
 * - NO mostrar si deletedBy = -1 (borrado para ambos)
 * - NO mostrar si deletedBy = other (borrado por mÃ­)
 */
export const getChatMessages = async (chatId: any, currentUserId: any) => {
  const me = Number(currentUserId);

  const messages = await Message.findAll({
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    where: {
      chatId,
      deletedBy: { [Op.in]: [0, me] }, // âœ… FIX: nunca traer -1
    },
    include: [
      {
        model: User,
        as: "sender",
      },
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
    ],
    attributes: { exclude: excludeKeys },
  });

  return messages;
};

export const getSenderByMessageId = async (
  messageId: any,
  viewerIdRaw: any = null
) => {
  const messages = await Message.findOne({
    where: { id: messageId },
    include: [
      {
        model: User,
        as: "sender",
        attributes: { exclude: excludeKeys },
      },
    ],
    attributes: { exclude: excludeKeys },
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: [(messages as any)?.sender].filter(Boolean),
    viewerIdRaw,
  });

  return messages;
};

export const resolveConversationByMessageId = async (
  currentUserId: any,
  messageId: any
): Promise<{
  conversationType: "direct" | "group";
  chatId: number;
  peerUserId: number | null;
  groupId: number | null;
  messageId: number;
} | null> => {
  const uid = Number(currentUserId);
  const safeMessageId = Number(messageId);

  if (!Number.isFinite(safeMessageId) || safeMessageId <= 0) {
    return null;
  }

  const message = await Message.findByPk(safeMessageId, {
    attributes: ["id", "chatId", "senderId"],
  });
  if (!message) return null;

  const chatId = Number((message as any).chatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;

  if (Number.isFinite(uid) && uid > 0) {
    const membership = await Chat_User.findOne({
      where: { chatId, userId: uid },
      attributes: ["chatId"],
    });
    if (!membership) return null;
  }

  const group = await Group.findOne({
    where: { chatId },
    attributes: ["id", "isActive"],
    order: [
      ["isActive", "DESC"],
      ["id", "DESC"],
    ],
  });

  if (group) {
    const groupId = Number((group as any).id);
    return {
      conversationType: "group",
      chatId,
      peerUserId: null,
      groupId: Number.isFinite(groupId) && groupId > 0 ? groupId : null,
      messageId: safeMessageId,
    };
  }

  const participants = await Chat_User.findAll({
    where: { chatId },
    attributes: ["userId"],
    order: [["userId", "ASC"]],
    raw: true,
  });

  let peerUserId: number | null = null;
  if (participants.length > 0) {
    const participantIds = participants
      .map((row: any) => Number(row.userId))
      .filter((id: number) => Number.isFinite(id) && id > 0);

    const other = participantIds.find((id: number) => id !== uid);
    if (Number.isFinite(other as any) && (other as number) > 0) {
      peerUserId = other as number;
    }
  }

  if (!peerUserId) {
    const senderId = Number((message as any).senderId);
    if (Number.isFinite(senderId) && senderId > 0 && senderId !== uid) {
      peerUserId = senderId;
    }
  }

  return {
    conversationType: "direct",
    chatId,
    peerUserId,
    groupId: null,
    messageId: safeMessageId,
  };
};

export const getChatByUser = async (
  currentUserId: any,
  otherUserId: any,
  opts?: { limit?: number; beforeMessageId?: number | null; sort?: "asc" | "desc" | null }
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  const otherUser = await User.findByPk(other);
  if ((otherUser as any)?.is_deleted) return [];

  if (await isBlockedEitherWay(me, other)) return [];

  const existingChatId = await findDirectChatIdByUsers(me, other, {
    visibleForUserId: me,
  });
  if (!existingChatId) return [];

  const chatId = Number(existingChatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return [];

  const limit = Math.max(1, Math.min(Number(opts?.limit ?? 50) || 50, 200));
  const beforeMessageId =
    opts?.beforeMessageId == null ? null : Number(opts?.beforeMessageId);
  const sort = String(opts?.sort ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";

  const where: any = {
    chatId,
    deletedBy: { [Op.in]: [0, me] },
  };

  if (Number.isFinite(beforeMessageId as any) && (beforeMessageId as number) > 0) {
    where.id = { [Op.lt]: beforeMessageId };
  }

  const messages = await Message.findAll({
    where,
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    attributes: { exclude: excludeKeys },
    include: [
      {
        model: User,
        as: "sender",
        required: false,
        attributes: ["id", "name", "last_name", "username", "image_profil", "is_deleted"],
      },
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
    ],
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: (messages as any[])
      .map((message: any) => (message as any)?.sender)
      .filter(Boolean),
    viewerIdRaw: me,
  });

  if (sort === "desc") {
    return messages;
  }
  return messages.reverse();
};

export const getChatByUserSummary = async (
  currentUserId: any,
  otherUserId: any,
  opts?: { limit?: number; beforeMessageId?: number | null; sort?: "asc" | "desc" | null }
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  const otherUser = await User.findByPk(other, { attributes: ["id", "is_deleted"] });
  if ((otherUser as any)?.is_deleted) return [];

  if (await isBlockedEitherWay(me, other)) return [];

  const existingChatId = await findDirectChatIdByUsers(me, other, {
    visibleForUserId: me,
  });
  if (!existingChatId) return [];

  const chatId = Number(existingChatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return [];

  const limit = Math.max(1, Math.min(Number(opts?.limit ?? 50) || 50, 200));
  const beforeMessageId =
    opts?.beforeMessageId == null ? null : Number(opts?.beforeMessageId);
  const sort = String(opts?.sort ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";

  const where: any = {
    chatId,
    deletedBy: { [Op.in]: [0, me] },
  };

  if (Number.isFinite(beforeMessageId as any) && (beforeMessageId as number) > 0) {
    where.id = { [Op.lt]: beforeMessageId };
  }

  const messages = await Message.findAll({
    where,
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    attributes: [
      "id",
      "chatId",
      "senderId",
      "text",
      "messageType",
      "mediaUrl",
      "date",
      "status",
      "replyToMessageId",
    ],
    include: [
      {
        model: User,
        as: "sender",
        required: false,
        attributes: chatSummaryUserAttributes,
      },
    ],
  });

  if (sort === "desc") {
    return messages;
  }
  return messages.reverse();
};

export const getDirectChatIdByUsers = async (
  currentUserId: any,
  otherUserId: any
): Promise<number | null> => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  if (!Number.isFinite(me) || me <= 0 || !Number.isFinite(other) || other <= 0) {
    return null;
  }

  const existingChatId = await findDirectChatIdByUsers(me, other, {
    visibleForUserId: me,
  });
  if (!existingChatId) return null;

  const chatId = Number(existingChatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;
  return chatId;
};

export const getRelatedUserIdsByUser = async (
  userId: number,
  opts?: { includeSelf?: boolean }
): Promise<number[]> => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const memberships = await Chat_User.findAll({
    where: { userId: uid },
    attributes: ["chatId"],
    raw: true,
  });

  const chatIds = Array.from(
    new Set(
      (memberships as any[])
        .map((row) => Number((row as any)?.chatId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (chatIds.length === 0) {
    return opts?.includeSelf ? [uid] : [];
  }

  const participants = await Chat_User.findAll({
    where: {
      chatId: { [Op.in]: chatIds },
    },
    attributes: ["userId"],
    raw: true,
  });

  const relatedUserIds = new Set<number>();
  for (const row of participants as any[]) {
    const relatedId = Number((row as any)?.userId);
    if (!Number.isFinite(relatedId) || relatedId <= 0) continue;
    relatedUserIds.add(relatedId);
  }

  if (!opts?.includeSelf) {
    relatedUserIds.delete(uid);
  } else {
    relatedUserIds.add(uid);
  }

  return [...relatedUserIds];
};

// Chat-only mode:
// exclude any chat room linked to groups (active or inactive) from DM flows.
const fetchActiveGroupChatIds = async (): Promise<number[]> => {
  const rows = await Group.findAll({
    where: {
      chatId: {
        [Op.not]: null,
      },
    },
    attributes: ["chatId"],
    raw: true,
  });

  return Array.from(
    new Set(
      (rows as any[])
        .map((row) => Number((row as any).chatId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
};

const getActiveGroupChatIds = async (): Promise<number[]> => {
  const now = Date.now();
  if (groupChatIdsCache && now < groupChatIdsCacheExpiresAtMs) {
    return groupChatIdsCache;
  }

  if (groupChatIdsInFlight) {
    return groupChatIdsInFlight;
  }

  groupChatIdsInFlight = fetchActiveGroupChatIds()
    .then((ids) => {
      groupChatIdsCache = ids;
      groupChatIdsCacheExpiresAtMs = Date.now() + GROUP_CHAT_IDS_CACHE_TTL_MS;
      return ids;
    })
    .catch((error) => {
      if (groupChatIdsCache) {
        return groupChatIdsCache;
      }
      throw error;
    })
    .finally(() => {
      groupChatIdsInFlight = null;
    });

  return groupChatIdsInFlight;
};

const getBlockedUserIdsForUser = async (userId: number): Promise<number[]> => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const rows = await UserBlock.findAll({
    where: {
      [Op.or]: [{ blocker_id: uid }, { blocked_id: uid }],
    },
    attributes: ["blocker_id", "blocked_id"],
    raw: true,
  });

  const blocked = new Set<number>();
  for (const row of rows as any[]) {
    const blocker = Number((row as any).blocker_id);
    const blockedId = Number((row as any).blocked_id);

    if (blocker === uid && Number.isFinite(blockedId) && blockedId > 0) {
      blocked.add(blockedId);
      continue;
    }

    if (blockedId === uid && Number.isFinite(blocker) && blocker > 0) {
      blocked.add(blocker);
    }
  }

  return [...blocked];
};

const chatSummaryUserAttributes = [
  "id",
  "name",
  "last_name",
  "username",
  "image_profil",
  "verified",
];

const chatSummaryMessageAttributes = [
  "id",
  "chatId",
  "senderId",
  "text",
  "messageType",
  "mediaUrl",
  "date",
  "status",
];

const CHAT_LIST_MAX_LIMIT = Math.max(
  1,
  Number(process.env.CHAT_LIST_MAX_LIMIT ?? 100) || 100
);

type ChatListCursorPayload = {
  pinnedAt: string | null;
  updatedAt: string;
  chatId: number;
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

const buildChatListCursorWhere = (
  cursor: ChatListCursorPayload | null | undefined
): any | null => {
  if (!isValidChatListCursorPayload(cursor)) return null;
  const cursorChatId = Number(cursor.chatId);
  const cursorUpdatedAt = new Date(cursor.updatedAt);
  const cursorPinnedAt =
    cursor.pinnedAt == null ? null : new Date(String(cursor.pinnedAt));

  if (cursorPinnedAt) {
    return {
      [Op.or]: [
        { pinnedAt: { [Op.is]: null } },
        {
          [Op.and]: [
            { pinnedAt: { [Op.not]: null } },
            {
              [Op.or]: [
                { pinnedAt: { [Op.lt]: cursorPinnedAt } },
                {
                  [Op.and]: [
                    { pinnedAt: cursorPinnedAt },
                    {
                      [Op.or]: [
                        { updatedAt: { [Op.lt]: cursorUpdatedAt } },
                        {
                          [Op.and]: [
                            { updatedAt: cursorUpdatedAt },
                            { chatId: { [Op.lt]: cursorChatId } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  return {
    [Op.and]: [
      { pinnedAt: { [Op.is]: null } },
      {
        [Op.or]: [
          { updatedAt: { [Op.lt]: cursorUpdatedAt } },
          {
            [Op.and]: [
              { updatedAt: cursorUpdatedAt },
              { chatId: { [Op.lt]: cursorChatId } },
            ],
          },
        ],
      },
    ],
  };
};

const buildNextChatListCursor = (row: any): ChatListCursorPayload | null => {
  if (!row) return null;
  const chatId = Number((row as any)?.chatId ?? (row as any)?.get?.("chatId"));
  if (!Number.isFinite(chatId) || chatId <= 0) return null;

  const updatedAtRaw = (row as any)?.updatedAt ?? (row as any)?.get?.("updatedAt");
  const updatedAt = new Date(updatedAtRaw ?? 0);
  if (!Number.isFinite(updatedAt.getTime())) return null;

  const pinnedAtRaw = (row as any)?.pinnedAt ?? (row as any)?.get?.("pinnedAt");
  const pinnedAt = pinnedAtRaw == null ? null : new Date(pinnedAtRaw);
  const pinnedAtIso =
    pinnedAt && Number.isFinite(pinnedAt.getTime()) ? pinnedAt.toISOString() : null;

  return {
    pinnedAt: pinnedAtIso,
    updatedAt: updatedAt.toISOString(),
    chatId: Math.trunc(chatId),
  };
};

const getLatestMessagesByChatIds = async ({
  chatIds,
  currentUserId,
  attributes,
}: {
  chatIds: number[];
  currentUserId: number;
  attributes: string[];
}): Promise<Map<number, any>> => {
  const uid = Number(currentUserId);
  const uniqueChatIds = Array.from(
    new Set(
      (chatIds ?? []).filter((chatId) => Number.isFinite(chatId) && chatId > 0)
    )
  );

  const latestMessageByChatId = new Map<number, any>();
  if (!uniqueChatIds.length) return latestMessageByChatId;

  const latestMessageIdRows = await Message.findAll({
    where: {
      chatId: { [Op.in]: uniqueChatIds },
      deletedBy: { [Op.in]: [0, uid] },
    },
    attributes: ["chatId", [sequelize.fn("MAX", sequelize.col("id")), "latestMessageId"]],
    group: ["chatId"],
    raw: true,
  });

  const latestMessageIds = Array.from(
    new Set(
      (latestMessageIdRows as any[])
        .map((row: any) => Number(row.latestMessageId))
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

  if (!latestMessageIds.length) return latestMessageByChatId;

  const resolvedAttributes = Array.from(new Set(["chatId", ...(attributes ?? [])]));
  const latestMessages = await Message.findAll({
    where: {
      id: { [Op.in]: latestMessageIds },
      deletedBy: { [Op.in]: [0, uid] },
    },
    attributes: resolvedAttributes,
    raw: true,
  });

  for (const row of latestMessages as any[]) {
    const chatId = Number((row as any)?.chatId);
    if (!Number.isFinite(chatId) || chatId <= 0) continue;
    latestMessageByChatId.set(chatId, row);
  }

  return latestMessageByChatId;
};

/**
 * âœ… GET USER CHATS (LISTA)
 * Objetivo:
 * - no mostrar chats eliminados para ambos (-1)
 * - no mostrar chats eliminados para mÃ­ (si tu semÃ¡ntica asÃ­ lo requiere)
 * - no mostrar usuarios bloqueados (en ambos sentidos)
 *
 * FIXES:
 * - usa visibilidad por usuario en Chat (oculto solo para quien borra)
 * - filtra bloqueos con replacements (sin interpolar me en string)
 */
export const getUserChats = async (
  currentUserId: number,
  meId: any = -1,
  opts?: { limit?: number | null; cursor?: ChatListCursorPayload | null }
) => {
  const me = Number(meId);
  const uid = Number(currentUserId);
  const groupChatIds = await getActiveGroupChatIds();
  const parsedLimit = Number(opts?.limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), CHAT_LIST_MAX_LIMIT))
    : null;
  const cursorWhere = buildChatListCursorWhere(opts?.cursor ?? null);

  const useBlockFilter = Number.isFinite(me) && me > 0;

  // Este where se aplica al â€œotro usuarioâ€ dentro del chat
  const userWhere: any = {
    id: { [Op.ne]: uid },
    is_deleted: false,
  };

  if (useBlockFilter) {
    userWhere[Op.and] = [
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :me AND ub.blocked_id = \`Chat->users\`.\`id\`)
            OR
            (ub.blocker_id = \`Chat->users\`.\`id\` AND ub.blocked_id = :me)
        )
      `),
    ];
  }

  const chatUserWhere: any = { userId: uid };
  if (cursorWhere) {
    chatUserWhere[Op.and] = [cursorWhere];
  }

  const rows = await Chat_User.findAll({
    attributes: [
      "userId",
      "chatId",
      "pinnedAt",
      "pinnedOrder",
      "createdAt",
      "updatedAt",
    ],
    where: chatUserWhere,
    include: [
      {
        model: Chat,
        // Visible if not hidden for current user (-1 = hidden for both, uid = hidden for uid)
        where: {
          ...(groupChatIds.length
            ? {
                id: {
                  [Op.notIn]: groupChatIds,
                },
              }
            : {}),
          ...buildChatVisibleForUserWhere(uid),
        },
        include: [
          {
            model: User,
            as: "users",
            where: userWhere,
            attributes: {
              exclude: ["password", "auth_token", "temp_code", "created_temp_code"],
            },
            through: { attributes: [] },
            required: true,
          },
        ],
      },
    ],
    // âœ… replacements solo si usamos filtro
    ...(useBlockFilter ? { replacements: { me } } : {}),
    order: [
      ["pinnedAt", "DESC"],
      ["updatedAt", "DESC"],
      ["chatId", "DESC"],
    ],
    subQuery: false,
    ...(safeLimit != null ? { limit: safeLimit + 1 } : {}),
  });

  const hasMore = safeLimit != null && rows.length > safeLimit;
  const chats = hasMore && safeLimit != null ? rows.slice(0, safeLimit) : rows;

  const chatIds = (chats as any[])
    .map((row: any) => Number(row.chatId ?? row.get?.("chatId")))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const latestMessageByChatId = new Map<number, any>();
  const unreadCountByChatId =
    chatIds.length > 0
      ? await getUnreadCountByChatIds({ userId: uid, chatIds })
      : new Map<number, number>();
  if (chatIds.length > 0) {
    const latestByChat = await getLatestMessagesByChatIds({
      chatIds,
      currentUserId: uid,
      attributes: [
        "id",
        "chatId",
        "senderId",
        "text",
        "messageType",
        "mediaUrl",
        "mediaMime",
        "mediaDurationMs",
        "mediaSizeBytes",
        "waveform",
        "metadata",
        "date",
        "deletedBy",
        "status",
        "deliveredAt",
        "readAt",
        "replyToMessageId",
        "reactions",
      ],
    });
    latestByChat.forEach((value, key) => latestMessageByChatId.set(key, value));
  }

  for (const chat of chats as any[]) {
    const chatId = Number(chat.chatId ?? chat.get?.("chatId"));
    if (!Number.isFinite(chatId)) continue;
    const lastMessage = latestMessageByChatId.get(chatId) ?? null;
    if (chat.Chat) {
      if (typeof chat.Chat.setDataValue === "function") {
        chat.Chat.setDataValue("messages", lastMessage ? [lastMessage] : []);
        chat.Chat.setDataValue("unreadCount", unreadCountByChatId.get(chatId) ?? 0);
      }
      chat.Chat.messages = lastMessage ? [lastMessage] : [];
      chat.Chat.unreadCount = unreadCountByChatId.get(chatId) ?? 0;
    }
  }

  // ordenar por pin + updatedAt para mantener paginación estable
  chats.sort((a: any, b: any) => {
    const pinA = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
    const pinB = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;

    if (pinA && !pinB) return -1;
    if (!pinA && pinB) return 1;
    if (pinA && pinB && pinA !== pinB) return pinB - pinA;

    const updatedA = new Date(a.updatedAt ?? 0).getTime() || 0;
    const updatedB = new Date(b.updatedAt ?? 0).getTime() || 0;
    if (updatedA !== updatedB) return updatedB - updatedA;

    const chatIdA = Number(a.chatId ?? a.get?.("chatId")) || 0;
    const chatIdB = Number(b.chatId ?? b.get?.("chatId")) || 0;
    return chatIdB - chatIdA;
  });

  const chatUsers = (chats as any[]).flatMap((chat: any) => {
    const users = Array.isArray((chat as any)?.Chat?.users)
      ? (chat as any).Chat.users
      : [];
    return users.filter(Boolean);
  });
  await attachActiveOrbitStateToUsers({
    usersRaw: chatUsers,
    viewerIdRaw: uid,
  });

  const nextCursor =
    hasMore && chats.length > 0 ? buildNextChatListCursor(chats[chats.length - 1]) : null;

  return {
    chats,
    paging: {
      limit: safeLimit,
      nextCursor,
    },
  };
};

export const getUserChatsSummary = async (
  currentUserId: number,
  meId: any = -1,
  opts?: { limit?: number | null; cursor?: ChatListCursorPayload | null }
) => {
  const me = Number(meId);
  const uid = Number(currentUserId);
  const groupChatIds = await getActiveGroupChatIds();
  const useBlockFilter = Number.isFinite(me) && me > 0;
  const parsedLimit = Number(opts?.limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), CHAT_LIST_MAX_LIMIT))
    : null;
  const cursorWhere = buildChatListCursorWhere(opts?.cursor ?? null);

  const userWhere: any = {
    id: { [Op.ne]: uid },
    is_deleted: false,
  };

  if (useBlockFilter) {
    userWhere[Op.and] = [
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :me AND ub.blocked_id = \`Chat->users\`.\`id\`)
            OR
            (ub.blocker_id = \`Chat->users\`.\`id\` AND ub.blocked_id = :me)
        )
      `),
    ];
  }

  const chatUserWhere: any = { userId: uid };
  if (cursorWhere) {
    chatUserWhere[Op.and] = [cursorWhere];
  }

  const rows = await Chat_User.findAll({
    attributes: ["userId", "chatId", "pinnedAt", "pinnedOrder", "updatedAt"],
    where: chatUserWhere,
    include: [
      {
        model: Chat,
        attributes: ["id"],
        where: {
          ...(groupChatIds.length
            ? {
                id: {
                  [Op.notIn]: groupChatIds,
                },
              }
            : {}),
          ...buildChatVisibleForUserWhere(uid),
        },
        include: [
          {
            model: User,
            as: "users",
            where: userWhere,
            attributes: chatSummaryUserAttributes,
            through: { attributes: [] },
            required: true,
          },
        ],
      },
    ],
    ...(useBlockFilter ? { replacements: { me } } : {}),
    order: [
      ["pinnedAt", "DESC"],
      ["updatedAt", "DESC"],
      ["chatId", "DESC"],
    ],
    subQuery: false,
    ...(safeLimit != null ? { limit: safeLimit + 1 } : {}),
  });

  const hasMore = safeLimit != null && rows.length > safeLimit;
  const chats = hasMore && safeLimit != null ? rows.slice(0, safeLimit) : rows;

  const chatIds = (chats as any[])
    .map((row: any) => Number(row.chatId ?? row.get?.("chatId")))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const latestMessageByChatId = new Map<number, any>();
  const unreadCountByChatId =
    chatIds.length > 0
      ? await getUnreadCountByChatIds({ userId: uid, chatIds })
      : new Map<number, number>();

  if (chatIds.length > 0) {
    const latestByChat = await getLatestMessagesByChatIds({
      chatIds,
      currentUserId: uid,
      attributes: chatSummaryMessageAttributes,
    });
    latestByChat.forEach((value, key) => latestMessageByChatId.set(key, value));
  }

  for (const chat of chats as any[]) {
    const chatId = Number(chat.chatId ?? chat.get?.("chatId"));
    if (!Number.isFinite(chatId)) continue;
    const lastMessage = latestMessageByChatId.get(chatId) ?? null;
    if (chat.Chat) {
      if (typeof chat.Chat.setDataValue === "function") {
        chat.Chat.setDataValue("messages", lastMessage ? [lastMessage] : []);
        chat.Chat.setDataValue("unreadCount", unreadCountByChatId.get(chatId) ?? 0);
      }
      chat.Chat.messages = lastMessage ? [lastMessage] : [];
      chat.Chat.unreadCount = unreadCountByChatId.get(chatId) ?? 0;
    }
  }

  chats.sort((a: any, b: any) => {
    const pinA = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
    const pinB = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;

    if (pinA && !pinB) return -1;
    if (!pinA && pinB) return 1;
    if (pinA && pinB && pinA !== pinB) return pinB - pinA;

    const updatedA = new Date(a.updatedAt ?? 0).getTime() || 0;
    const updatedB = new Date(b.updatedAt ?? 0).getTime() || 0;
    if (updatedA !== updatedB) return updatedB - updatedA;

    const chatIdA = Number(a.chatId ?? a.get?.("chatId")) || 0;
    const chatIdB = Number(b.chatId ?? b.get?.("chatId")) || 0;
    return chatIdB - chatIdA;
  });

  const nextCursor =
    hasMore && chats.length > 0 ? buildNextChatListCursor(chats[chats.length - 1]) : null;

  return {
    chats,
    paging: {
      limit: safeLimit,
      nextCursor,
    },
  };
};

export const getUserStarredChats = async ({
  currentUserId,
  meId = -1,
  limit = 20,
  beforePinnedAt = null,
  beforeChatId = null,
}: {
  currentUserId: number;
  meId?: any;
  limit?: number;
  beforePinnedAt?: string | null;
  beforeChatId?: number | null;
}) => {
  const me = Number(meId);
  const uid = Number(currentUserId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const groupChatIds = await getActiveGroupChatIds();
  const blockedUserIds =
    Number.isFinite(me) && me > 0 ? await getBlockedUserIdsForUser(me) : [];

  const userWhere: any = {
    id: {
      [Op.ne]: uid,
      ...(blockedUserIds.length ? { [Op.notIn]: blockedUserIds } : {}),
    },
    is_deleted: false,
  };

  const cursorDate =
    typeof beforePinnedAt === "string" && beforePinnedAt.trim()
      ? new Date(beforePinnedAt)
      : null;
  const safeCursorPinnedAt =
    cursorDate && Number.isFinite(cursorDate.getTime()) ? cursorDate : null;
  const parsedCursorChatId =
    beforeChatId == null ? null : Number(beforeChatId);
  const safeCursorChatId =
    Number.isFinite(parsedCursorChatId as any) && (parsedCursorChatId as number) > 0
      ? (parsedCursorChatId as number)
      : null;

  const where: any = {
    userId: uid,
    [Op.and]: [{ pinnedAt: { [Op.ne]: null } }],
  };

  if (safeCursorPinnedAt && safeCursorChatId) {
    where[Op.and].push({
      [Op.or]: [
        { pinnedAt: { [Op.lt]: safeCursorPinnedAt } },
        {
          [Op.and]: [
            { pinnedAt: safeCursorPinnedAt },
            { chatId: { [Op.lt]: safeCursorChatId } },
          ],
        },
      ],
    });
  } else if (safeCursorPinnedAt) {
    where[Op.and].push({
      pinnedAt: { [Op.lt]: safeCursorPinnedAt },
    });
  }

  const rows = await Chat_User.findAll({
    attributes: [
      "userId",
      "chatId",
      "pinnedAt",
      "pinnedOrder",
      "createdAt",
      "updatedAt",
    ],
    where,
    include: [
      {
        model: Chat,
        where: {
          ...(groupChatIds.length
            ? {
                id: {
                  [Op.notIn]: groupChatIds,
                },
              }
            : {}),
          ...buildChatVisibleForUserWhere(uid),
        },
        include: [
          {
            model: User,
            as: "users",
            where: userWhere,
            attributes: {
              exclude: ["password", "auth_token", "temp_code", "created_temp_code"],
            },
            through: { attributes: [] },
            required: true,
          },
        ],
      },
    ],
    order: [
      ["pinnedAt", "DESC"],
      ["chatId", "DESC"],
    ],
    limit: safeLimit + 1,
  });

  const hasMore = rows.length > safeLimit;
  const chats = hasMore ? rows.slice(0, safeLimit) : rows;

  const chatIds = (chats as any[])
    .map((row: any) => Number(row.chatId ?? row.get?.("chatId")))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const latestMessageByChatId = await getLatestMessagesByChatIds({
    chatIds,
    currentUserId: uid,
    attributes: [
      "id",
      "chatId",
      "senderId",
      "text",
      "messageType",
      "mediaUrl",
      "mediaMime",
      "mediaDurationMs",
      "mediaSizeBytes",
      "waveform",
      "metadata",
      "date",
      "deletedBy",
      "status",
      "deliveredAt",
      "readAt",
      "replyToMessageId",
      "reactions",
    ],
  });

  for (const chat of chats as any[]) {
    const chatId = Number(chat.chatId ?? chat.get?.("chatId"));
    if (!Number.isFinite(chatId)) continue;
    const lastMessage = latestMessageByChatId.get(chatId) ?? null;
    if (chat.Chat) {
      if (typeof chat.Chat.setDataValue === "function") {
        chat.Chat.setDataValue("messages", lastMessage ? [lastMessage] : []);
      }
      chat.Chat.messages = lastMessage ? [lastMessage] : [];
    }
  }

  let nextCursor: { beforePinnedAt: string; beforeChatId: number } | null = null;
  if (hasMore && chats.length > 0) {
    const tail: any = chats[chats.length - 1];
    const tailPinnedAt = tail?.pinnedAt ? new Date(tail.pinnedAt) : null;
    const tailChatId = Number(tail?.chatId ?? tail?.get?.("chatId"));
    if (
      tailPinnedAt &&
      Number.isFinite(tailPinnedAt.getTime()) &&
      Number.isFinite(tailChatId) &&
      tailChatId > 0
    ) {
      nextCursor = {
        beforePinnedAt: tailPinnedAt.toISOString(),
        beforeChatId: tailChatId,
      };
    }
  }

  const chatUsers = (chats as any[]).flatMap((chat: any) => {
    const users = Array.isArray((chat as any)?.Chat?.users)
      ? (chat as any).Chat.users
      : [];
    return users.filter(Boolean);
  });
  await attachActiveOrbitStateToUsers({
    usersRaw: chatUsers,
    viewerIdRaw: uid,
  });

  return {
    chats,
    paging: {
      limit: safeLimit,
      nextCursor,
    },
  };
};

export const setChatPinned = async ({
  userId,
  chatId,
  pinned,
}: {
  userId: number;
  chatId: number;
  pinned: boolean;
}) => {
  const row = await Chat_User.findOne({ where: { userId, chatId } });
  if (!row) return null;

  const payload = pinned
    ? { pinnedAt: new Date(), pinnedOrder: null }
    : { pinnedAt: null, pinnedOrder: null };

  await row.update(payload);
  return row;
};
export const deleteChatByMessages = async (chatId: any, currentUserId: any) => {
  const uid = Number(currentUserId);

  await Message.update(
    {
      deletedBy: sequelize.literal(
        `CASE 
          WHEN deletedBy = 0 THEN ${uid}
          WHEN deletedBy <> ${uid} THEN -1
          ELSE deletedBy 
        END`
      ),
    },
    { where: { chatId } }
  );
};

export const deleteChat = async (chatId: any, currentUserId: any) => {
  const uid = Number(currentUserId);
  if (!Number.isFinite(uid) || uid <= 0) return;

  await Chat.update(
    {
      deletedBy: sequelize.literal(`
        CASE 
          WHEN deletedBy = 0 THEN ${uid}
          WHEN deletedBy = ${uid} THEN ${uid}
          WHEN deletedBy = -1 THEN -1
          ELSE -1
        END
      `),
    },
    { where: { id: chatId } }
  );
};

// =======================================================
// âœ… STATUS HELPERS (no rompen)
// =======================================================

export const updateMessageStatus = async ({
  messageId,
  status,
}: {
  messageId: number;
  status: "sent" | "delivered" | "read";
}) => {
  await Message.update({ status }, { where: { id: messageId } });
};

export const incrementUnreadCountForChatUser = async (
  chatIdRaw: number,
  userIdRaw: number,
  incrementByRaw = 1
) => {
  const chatId = Number(chatIdRaw);
  const userId = Number(userIdRaw);
  const incrementBy = Math.max(0, Number(incrementByRaw) || 0);
  if (!Number.isFinite(chatId) || chatId <= 0) return;
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (incrementBy <= 0) return;
  if (!(await hasChatUserUnreadCountColumn())) return;

  await sequelize.query(
    `
      UPDATE chat_user
      SET ${CHAT_USER_UNREAD_COUNT_COLUMN} = GREATEST(
        COALESCE(${CHAT_USER_UNREAD_COUNT_COLUMN}, 0) + :incrementBy,
        0
      )
      WHERE chatId = :chatId
        AND userId = :userId
    `,
    {
      replacements: {
        chatId,
        userId,
        incrementBy,
      },
      type: QueryTypes.UPDATE,
    }
  );
};

export const decrementUnreadCountForChatUser = async (
  chatIdRaw: number,
  userIdRaw: number,
  decrementByRaw = 1
) => {
  const chatId = Number(chatIdRaw);
  const userId = Number(userIdRaw);
  const decrementBy = Math.max(0, Number(decrementByRaw) || 0);
  if (!Number.isFinite(chatId) || chatId <= 0) return;
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (decrementBy <= 0) return;
  if (!(await hasChatUserUnreadCountColumn())) return;

  await sequelize.query(
    `
      UPDATE chat_user
      SET ${CHAT_USER_UNREAD_COUNT_COLUMN} = GREATEST(
        COALESCE(${CHAT_USER_UNREAD_COUNT_COLUMN}, 0) - :decrementBy,
        0
      )
      WHERE chatId = :chatId
        AND userId = :userId
    `,
    {
      replacements: {
        chatId,
        userId,
        decrementBy,
      },
      type: QueryTypes.UPDATE,
    }
  );
};

export const resetUnreadCountForChatUser = async (
  chatIdRaw: number,
  userIdRaw: number
) => {
  const chatId = Number(chatIdRaw);
  const userId = Number(userIdRaw);
  if (!Number.isFinite(chatId) || chatId <= 0) return;
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (!(await hasChatUserUnreadCountColumn())) return;

  await sequelize.query(
    `
      UPDATE chat_user
      SET ${CHAT_USER_UNREAD_COUNT_COLUMN} = 0
      WHERE chatId = :chatId
        AND userId = :userId
    `,
    {
      replacements: {
        chatId,
        userId,
      },
      type: QueryTypes.UPDATE,
    }
  );
};

export const markMessagesAsReadBulk = async (
  messageIds: Array<number | string | null | undefined>
) => {
  const ids = Array.from(
    new Set(
      (messageIds ?? [])
        .map((raw) => Number(raw))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (!ids.length) {
    return { ids: [] as number[], readAt: null as Date | null };
  }

  const now = new Date();
  await Message.update(
    {
      status: "read",
      deliveredAt: now,
      readAt: now,
    },
    {
      where: {
        id: { [Op.in]: ids },
        status: { [Op.in]: ["sent", "delivered"] },
      },
    }
  );

  return { ids, readAt: now };
};

export const updateMessageTimestamps = async ({
  messageId,
  deliveredAt,
  readAt,
}: {
  messageId: number;
  deliveredAt?: Date;
  readAt?: Date;
}) => {
  await Message.update(
    {
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(readAt ? { readAt } : {}),
    },
    { where: { id: messageId } }
  );
};

export const getMessageById = async (messageId: number) => {
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeMessageId) || safeMessageId <= 0) return null;
  return Message.findByPk(safeMessageId, {
    attributes: ["id", "chatId", "senderId", "deletedBy"],
  });
};

export const markMessageDeletedForAll = async (messageId: number) => {
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeMessageId) || safeMessageId <= 0) return 0;
  const [count] = await Message.update(
    { deletedBy: -1 },
    {
      where: {
        id: safeMessageId,
      },
    }
  );
  return Number(count) || 0;
};

export const getChatParticipantUserIds = async (chatId: number): Promise<number[]> => {
  const safeChatId = Number(chatId);
  if (!Number.isFinite(safeChatId) || safeChatId <= 0) return [];

  const rows = await Chat_User.findAll({
    where: { chatId: safeChatId },
    attributes: ["userId"],
    raw: true,
  });

  const unique = new Set<number>();
  for (const row of rows as any[]) {
    const uid = Number((row as any)?.userId);
    if (Number.isFinite(uid) && uid > 0) unique.add(uid);
  }
  return [...unique];
};

// =======================================================

const findDirectChatIdByUsers = async (
  currentUserId: number,
  otherUserId: number,
  opts?: { visibleForUserId?: number | null }
): Promise<number | null> => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);
  if (!Number.isFinite(me) || me <= 0 || !Number.isFinite(other) || other <= 0) {
    return null;
  }

  const visibleForUserIdRaw =
    opts?.visibleForUserId == null ? null : Number(opts.visibleForUserId);
  const hasVisibilityFilter =
    Number.isFinite(visibleForUserIdRaw as any) && (visibleForUserIdRaw as number) > 0;
  const visibleForUserId = hasVisibilityFilter ? Number(visibleForUserIdRaw) : null;

  const rows = (await sequelize.query(
    `
      SELECT cu1.chatId AS chatId
      FROM chat_user cu1
      INNER JOIN chat_user cu2
        ON cu2.chatId = cu1.chatId
       AND cu2.userId = :otherUserId
      LEFT JOIN chat_groups cg
        ON cg.chatId = cu1.chatId
      ${hasVisibilityFilter ? "INNER JOIN chats c ON c.id = cu1.chatId" : ""}
      WHERE cu1.userId = :currentUserId
        AND cg.chatId IS NULL
      ${hasVisibilityFilter ? "AND c.deletedBy NOT IN (-1, :visibleForUserId)" : ""}
      ORDER BY cu1.chatId DESC
      LIMIT 1
    `,
    {
      replacements: {
        currentUserId: me,
        otherUserId: other,
        ...(hasVisibilityFilter ? { visibleForUserId } : {}),
      },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ chatId?: number | string | null }>;

  if (!rows.length) return null;
  const chatId = Number(rows[0]?.chatId);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;
  return Math.trunc(chatId);
};

async function isBlockedEitherWay(a: number, b: number): Promise<boolean> {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;

  const row = await UserBlock.findOne({
    where: {
      [Op.or]: [
        { blocker_id: a, blocked_id: b },
        { blocker_id: b, blocked_id: a },
      ],
    },
    attributes: ["id"],
  });

  return !!row;
}

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

const toAmzDate = (date: Date) =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const getCloudflareAccountId = () =>
  String(process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();

const getImagesToken = () =>
  String(
    process.env.CLOUDFLARE_IMAGES_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();

const getMediaToken = () =>
  String(
    process.env.CLOUDFLARE_MEDIA_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();

const getR2Bucket = () =>
  String(
    process.env.CLOUDFLARE_R2_BUCKET ??
      process.env.R2_BUCKET ??
      process.env.CLOUDFLARE_R2_AUDIO_BUCKET ??
      "static-minhoo"
  ).trim();

const getR2Endpoint = () => {
  const explicit = String(
    process.env.CLOUDFLARE_R2_ENDPOINT ??
      process.env.R2_ENDPOINT ??
      process.env.CLOUDFLARE_R2_S3_ENDPOINT ??
      process.env.R2_S3_ENDPOINT ??
      ""
  ).trim();
  if (explicit) return explicit;

  const accountId = getCloudflareAccountId();
  if (!accountId) return "";
  return `https://${accountId}.r2.cloudflarestorage.com`;
};

const getR2AccessKeyId = () =>
  String(
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ??
      process.env.R2_ACCESS_KEY_ID ??
      process.env.CLOUDFLARE_ACCESS_KEY_ID ??
      ""
  ).trim();

const getR2SecretAccessKey = () =>
  String(
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ??
      process.env.R2_SECRET_ACCESS_KEY ??
      process.env.CLOUDFLARE_SECRET_ACCESS_KEY ??
      ""
  ).trim();

const normalizeAssetId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const decoded = decodeURIComponent(value.trim());
  if (!decoded) return null;
  if (!/^[a-zA-Z0-9._-]{6,255}$/.test(decoded)) return null;
  return decoded;
};

const normalizeR2ObjectKey = normalizeAssetId;
const normalizeVideoStorageKey = normalizeR2ObjectKey;
const normalizeAudioKey = normalizeR2ObjectKey;
const normalizeDocumentKey = normalizeR2ObjectKey;

const extractAudioKeyFromMediaUrl = (mediaUrl: unknown): string | null => {
  if (typeof mediaUrl !== "string") return null;
  const raw = mediaUrl.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw, "http://local");
    if (!url.pathname.includes("/api/v1/media/audio/play")) return null;
    return normalizeAudioKey(url.searchParams.get("key"));
  } catch {
    return null;
  }
};

const extractDocumentKeyFromMediaUrl = (mediaUrl: unknown): string | null => {
  if (typeof mediaUrl !== "string") return null;
  const raw = mediaUrl.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw, "http://local");
    if (!url.pathname.includes("/api/v1/media/document/download")) return null;
    return normalizeDocumentKey(url.searchParams.get("key"));
  } catch {
    return null;
  }
};

const extractImageIdFromMediaUrl = (mediaUrl: unknown): string | null => {
  if (typeof mediaUrl !== "string") return null;
  const raw = mediaUrl.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw, "http://local");
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname.includes("/api/v1/media/image/play")) {
      return normalizeAssetId(url.searchParams.get("id"));
    }

    if (host.endsWith("imagedelivery.net") && parts.length >= 2) {
      return normalizeAssetId(parts[1]);
    }

    return null;
  } catch {
    return null;
  }
};

const STREAM_UID_REGEX = /^[a-f0-9]{32}$/i;
const normalizeVideoUid = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const decoded = decodeURIComponent(value.trim());
  if (!decoded) return null;
  if (!STREAM_UID_REGEX.test(decoded)) return null;
  return decoded.toLowerCase();
};

const extractVideoUidFromMediaUrl = (mediaUrl: unknown): string | null => {
  if (typeof mediaUrl !== "string") return null;
  const raw = mediaUrl.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw, "http://local");
    if (url.pathname.includes("/api/v1/media/video/play")) {
      return normalizeVideoUid(url.searchParams.get("uid"));
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;

    const match = parts.find((entry) => STREAM_UID_REGEX.test(entry));
    return match ?? null;
  } catch {
    return null;
  }
};

const extractVideoKeyFromMediaUrl = (mediaUrl: unknown): string | null => {
  if (typeof mediaUrl !== "string") return null;
  const raw = mediaUrl.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw, "http://local");
    if (!url.pathname.includes("/api/v1/media/video/play")) return null;

    const keyFromKey = normalizeVideoStorageKey(url.searchParams.get("key"));
    if (keyFromKey) return keyFromKey;

    const uidValue = String(url.searchParams.get("uid") ?? "").trim();
    if (!uidValue) return null;
    if (normalizeVideoUid(uidValue)) return null;
    return normalizeVideoStorageKey(uidValue);
  } catch {
    return null;
  }
};

const buildR2ObjectUrl = (endpoint: string, bucket: string, key: string) => {
  const endpointUrl = new URL(
    /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`
  );
  const basePath = endpointUrl.pathname.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => rfc3986(segment))
    .join("/");
  const host = endpointUrl.host.startsWith(`${bucket}.`)
    ? endpointUrl.host
    : `${bucket}.${endpointUrl.host}`;
  const objectPath = `${basePath}/${encodedKey}`.replace(/\/{2,}/g, "/");

  return {
    host,
    origin: `${endpointUrl.protocol}//${host}`,
    canonicalUri: objectPath.startsWith("/") ? objectPath : `/${objectPath}`,
  };
};

const buildR2PresignedDeleteUrl = ({
  bucket,
  endpoint,
  key,
  accessKeyId,
  secretAccessKey,
}: {
  bucket: string;
  endpoint: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
}) => {
  const { host, origin, canonicalUri } = buildR2ObjectUrl(endpoint, bucket, key);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(R2_DELETE_TTL_SECONDS),
    "X-Amz-SignedHeaders": "host",
    "x-id": "DeleteObject",
  };

  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, R2_REGION);
  const kService = hmac(kRegion, R2_SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

const escapeLikeValue = (value: string) => value.replace(/[\\%_]/g, "\\$&");

const extractCloudflareErrorMessage = (payload: any, fallback: string) => {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const messages = errors
    .map((entry: any) => String(entry?.message ?? "").trim())
    .filter(Boolean);
  if (messages.length) return messages.join(" | ");

  const payloadMessage = String(payload?.message ?? "").trim();
  if (payloadMessage) return payloadMessage;

  return fallback;
};

const resolveCloudflareImagesDeleteConfig = () => {
  const accountId = getCloudflareAccountId();
  const token = getImagesToken();
  if (!accountId || !token) return null;
  return { accountId, token };
};

const resolveCloudflareMediaDeleteConfig = () => {
  const accountId = getCloudflareAccountId();
  const token = getMediaToken();
  if (!accountId || !token) return null;
  return { accountId, token };
};

const resolveR2DeleteConfig = () => {
  const bucket = getR2Bucket();
  const endpoint = getR2Endpoint();
  const accessKeyId = getR2AccessKeyId();
  const secretAccessKey = getR2SecretAccessKey();

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, accessKeyId, secretAccessKey };
};

const deleteObjectFromR2 = async (
  cfg: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string },
  key: string
) => {
  const signedDeleteUrl = buildR2PresignedDeleteUrl({
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    key,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });

  const response = await fetch(signedDeleteUrl, { method: "DELETE" });
  if (response.ok || response.status === 404) return;
  throw new Error(`r2 delete failed with status ${response.status}`);
};

const deleteImageFromCloudflare = async (
  cfg: { accountId: string; token: string },
  imageId: string
) => {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${cfg.accountId}/images/v1/${imageId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.token}` },
    }
  );

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 404) return;
  if (response.ok && payload?.success !== false) return;

  throw new Error(
    extractCloudflareErrorMessage(payload, `cloudflare images delete failed (${response.status})`)
  );
};

const deleteVideoFromCloudflare = async (
  cfg: { accountId: string; token: string },
  uid: string
) => {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${cfg.accountId}/stream/${uid}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.token}` },
    }
  );

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 404) return;
  if (response.ok && payload?.success !== false) return;

  throw new Error(
    extractCloudflareErrorMessage(payload, `cloudflare stream delete failed (${response.status})`)
  );
};

const cleanupPrunedMediaObjects = async (
  prunedRows: Array<{ messageType?: unknown; mediaUrl?: unknown }>
) => {
  const voiceKeys = new Set<string>();
  const documentKeys = new Set<string>();
  const imageIds = new Set<string>();
  const videoUids = new Set<string>();
  const videoKeys = new Set<string>();

  for (const row of prunedRows) {
    const type = String(row?.messageType ?? "").toLowerCase();
    if (type === "voice") {
      const key = extractAudioKeyFromMediaUrl(row?.mediaUrl);
      if (key) voiceKeys.add(key);
      continue;
    }
    if (type === "document") {
      const key = extractDocumentKeyFromMediaUrl(row?.mediaUrl);
      if (key) documentKeys.add(key);
      continue;
    }
    if (type === "image") {
      const imageId = extractImageIdFromMediaUrl(row?.mediaUrl);
      if (imageId) imageIds.add(imageId);
      continue;
    }
    if (type === "video") {
      const key = extractVideoKeyFromMediaUrl(row?.mediaUrl);
      if (key) videoKeys.add(key);
      const uid = extractVideoUidFromMediaUrl(row?.mediaUrl);
      if (uid) videoUids.add(uid);
    }
  }

  if (
    !voiceKeys.size &&
    !documentKeys.size &&
    !imageIds.size &&
    !videoUids.size &&
    !videoKeys.size
  ) {
    return;
  }

  const r2Cfg = resolveR2DeleteConfig();
  if ((voiceKeys.size || documentKeys.size || videoKeys.size) && !r2Cfg) {
    console.warn("[chat-prune] R2 config missing; skipped audio/document/video cleanup.");
  }

  const imageCfg = resolveCloudflareImagesDeleteConfig();
  if (imageIds.size && !imageCfg) {
    console.warn("[chat-prune] Cloudflare Images config missing; skipped image cleanup.");
  }

  const videoCfg = resolveCloudflareMediaDeleteConfig();
  if (videoUids.size && !videoCfg) {
    console.warn("[chat-prune] Cloudflare Stream config missing; skipped video cleanup.");
  }

  for (const key of voiceKeys) {
    try {
      const likeNeedle = `%key=${escapeLikeValue(key)}%`;
      const refs = await Message.count({
        where: {
          messageType: "voice",
          mediaUrl: { [Op.like]: likeNeedle },
        },
      });

      if (refs > 0) continue;
      if (!r2Cfg) continue;
      await deleteObjectFromR2(r2Cfg, key);
    } catch (error: any) {
      console.warn(
        `[chat-prune] failed to remove R2 audio object key=${key}:`,
        error?.message ?? error
      );
    }
  }

  for (const key of documentKeys) {
    try {
      const likeNeedle = `%key=${escapeLikeValue(key)}%`;
      const refs = await Message.count({
        where: {
          messageType: "document",
          mediaUrl: { [Op.like]: likeNeedle },
        },
      });

      if (refs > 0) continue;
      if (!r2Cfg) continue;
      await deleteObjectFromR2(r2Cfg, key);
    } catch (error: any) {
      console.warn(
        `[chat-prune] failed to remove R2 document object key=${key}:`,
        error?.message ?? error
      );
    }
  }

  for (const imageId of imageIds) {
    try {
      const likeNeedle = `%/${escapeLikeValue(imageId)}/%`;
      const refs = await Message.count({
        where: {
          messageType: "image",
          mediaUrl: { [Op.like]: likeNeedle },
        },
      });

      if (refs > 0) continue;
      if (!imageCfg) continue;
      await deleteImageFromCloudflare(imageCfg, imageId);
    } catch (error: any) {
      console.warn(
        `[chat-prune] failed to remove Cloudflare image id=${imageId}:`,
        error?.message ?? error
      );
    }
  }

  for (const uid of videoUids) {
    try {
      const likeNeedle = `%/${escapeLikeValue(uid)}/%`;
      const refs = await Message.count({
        where: {
          messageType: "video",
          mediaUrl: { [Op.like]: likeNeedle },
        },
      });

      if (refs > 0) continue;
      if (!videoCfg) continue;
      await deleteVideoFromCloudflare(videoCfg, uid);
    } catch (error: any) {
      console.warn(
        `[chat-prune] failed to remove Cloudflare video uid=${uid}:`,
        error?.message ?? error
      );
    }
  }

  for (const key of videoKeys) {
    try {
      const refs = await Message.count({
        where: {
          messageType: "video",
          [Op.or]: [
            { mediaUrl: { [Op.like]: `%key=${escapeLikeValue(key)}%` } },
            { mediaUrl: { [Op.like]: `%uid=${escapeLikeValue(key)}%` } },
          ],
        },
      });

      if (refs > 0) continue;
      if (!r2Cfg) continue;
      await deleteObjectFromR2(r2Cfg, key);
    } catch (error: any) {
      console.warn(
        `[chat-prune] failed to remove R2 video object key=${key}:`,
        error?.message ?? error
      );
    }
  }
};

async function pruneChatHistory(chatId: number, keepLimit: number): Promise<void> {
  const keep = Math.max(1, Number(keepLimit) || 1);

  const oldMessages = await Message.findAll({
    where: { chatId },
    attributes: ["id", "messageType", "mediaUrl"],
    order: [["id", "DESC"]],
    offset: keep,
    raw: true,
  });

  if (!oldMessages.length) return;

  const idsToDelete = oldMessages
    .map((row: any) => Number(row.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  if (!idsToDelete.length) return;

  await Message.destroy({
    where: {
      id: { [Op.in]: idsToDelete },
    },
  });

  await cleanupPrunedMediaObjects(
    oldMessages as Array<{ messageType?: unknown; mediaUrl?: unknown }>
  );
}

export const pruneChatHistoryForChat = async (
  chatId: number,
  keepLimit = MAX_MESSAGES_PER_CHAT
) => {
  await pruneChatHistory(chatId, keepLimit);
};



