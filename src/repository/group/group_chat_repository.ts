import { Op, Sequelize } from "sequelize";
import Message from "../../_models/chat/message";
import User from "../../_models/user/user";
import sequelize from "../../_db/connection";
import { pruneChatHistoryForChat } from "../chat/chat_repository";
import {
  attachUserToGroupChat,
  ensureGroupChatRoom,
  getActiveMemberUserIds,
  getGroupAccessSnapshot,
} from "./group_repository";

const normalizeLimit = (value: any, fallback = 20, max = 200) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export type GroupMessagePayload = {
  messageType:
    | "text"
    | "voice"
    | "image"
    | "video"
    | "document"
    | "contact";
  text: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaDurationMs: number | null;
  mediaSizeBytes: number | null;
  waveform: number[] | null;
  metadata: Record<string, any> | null;
  clientMessageId?: string | null;
};

const CLIENT_MESSAGE_ID_METADATA_KEY = "_clientMessageId";

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

const buildMessageInclude = () => [
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
];

const findGroupMessageByClientMessageId = async ({
  chatId,
  senderId,
  clientMessageId,
}: {
  chatId: number;
  senderId: number;
  clientMessageId: string;
}) => {
  return Message.findOne({
    where: {
      chatId,
      senderId,
      [Op.and]: [
        Sequelize.literal(
          `JSON_UNQUOTE(JSON_EXTRACT(\`Message\`.\`metadata\`, '$.${CLIENT_MESSAGE_ID_METADATA_KEY}')) = ${sequelize.escape(
            clientMessageId
          )}`
        ),
      ],
    },
    include: buildMessageInclude(),
    order: [["id", "DESC"]],
  });
};

export const getGroupMessagesPage = async ({
  groupId,
  viewerUserId,
  limit,
  beforeMessageId,
  sort,
}: {
  groupId: number;
  viewerUserId?: number | null;
  limit?: number;
  beforeMessageId?: number | null;
  sort?: "asc" | "desc" | null;
}) => {
  const access = await getGroupAccessSnapshot(groupId, viewerUserId ?? null);
  if (!access) {
    return { ok: false as const, reason: "group_not_found" as const };
  }
  if (!access.policy.can_view_chat) {
    return {
      ok: false as const,
      reason: "forbidden_view" as const,
      policy: access.policy,
      group: access.group,
    };
  }

  const chatId = await ensureGroupChatRoom(groupId);
  if (!chatId) {
    return { ok: false as const, reason: "group_not_found" as const };
  }

  const safeLimit = normalizeLimit(limit, 20, 200);
  const safeBefore = toPositiveInt(beforeMessageId);
  const uid = toPositiveInt(viewerUserId);
  const normalizedSort = String(sort ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";

  const where: any = {
    chatId,
    deletedBy: uid ? { [Op.in]: [0, uid] } : 0,
  };
  if (safeBefore) {
    where.id = { [Op.lt]: safeBefore };
  }

  const messages = await Message.findAll({
    where,
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    limit: safeLimit,
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

  const normalizedMessages = normalizedSort === "desc" ? [...messages] : [...messages].reverse();
  const minMessageId = (messages as any[])
    .map((item) => Number((item as any)?.id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .reduce((min, id) => (id < min ? id : min), Number.POSITIVE_INFINITY);
  const nextCursor =
    Number.isFinite(minMessageId)
      ? {
          beforeMessageId: Number(minMessageId),
        }
      : null;

  return {
    ok: true as const,
    group: access.group,
    policy: access.policy,
    chatId,
    sort: normalizedSort,
    messages: normalizedMessages,
    nextCursor,
  };
};

export const createGroupMessage = async ({
  groupId,
  senderUserId,
  payload,
  replyToMessageId,
}: {
  groupId: number;
  senderUserId: number;
  payload: GroupMessagePayload;
  replyToMessageId?: number | null;
}) => {
  const access = await getGroupAccessSnapshot(groupId, senderUserId);
  if (!access) {
    return { ok: false as const, reason: "group_not_found" as const };
  }
  if (!access.policy.can_interact) {
    return {
      ok: false as const,
      reason: "forbidden_interact" as const,
      policy: access.policy,
      group: access.group,
    };
  }

  const chatId = await attachUserToGroupChat(groupId, senderUserId);
  if (!chatId) {
    return { ok: false as const, reason: "group_not_found" as const };
  }

  const normalizedClientMessageId = normalizeClientMessageId(payload?.clientMessageId);
  if (normalizedClientMessageId) {
    const existingMessage = await findGroupMessageByClientMessageId({
      chatId,
      senderId: senderUserId,
      clientMessageId: normalizedClientMessageId,
    });
    if (existingMessage) {
      const memberUserIds = await getActiveMemberUserIds(groupId);
      return {
        ok: true as const,
        chatId,
        message: existingMessage,
        group: access.group,
        policy: access.policy,
        memberUserIds,
        deduplicated: true,
      };
    }
  }

  const now = new Date();
  const created = await Message.create({
    text: payload.text ?? null,
    messageType: payload.messageType,
    mediaUrl: payload.mediaUrl ?? null,
    mediaMime: payload.mediaMime ?? null,
    mediaDurationMs: payload.mediaDurationMs ?? null,
    mediaSizeBytes: payload.mediaSizeBytes ?? null,
    waveform: payload.waveform ?? null,
    metadata: mergeClientMessageIdIntoMetadata(
      payload.metadata ?? null,
      normalizedClientMessageId
    ),
    senderId: senderUserId,
    chatId,
    date: now,
    deletedBy: 0,
    replyToMessageId: toPositiveInt(replyToMessageId) ?? null,
  });

  await pruneChatHistoryForChat(chatId);

  const fullMessage = await Message.findByPk(Number((created as any).id), {
    include: buildMessageInclude(),
  });

  const memberUserIds = await getActiveMemberUserIds(groupId);
  return {
    ok: true as const,
    chatId,
    message: fullMessage,
    group: access.group,
    policy: access.policy,
    memberUserIds,
    deduplicated: false,
  };
};
