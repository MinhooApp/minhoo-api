import { Op } from "sequelize";
import Message from "../../_models/chat/message";
import User from "../../_models/user/user";
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
};

export const getGroupMessagesPage = async ({
  groupId,
  viewerUserId,
  limit,
  beforeMessageId,
}: {
  groupId: number;
  viewerUserId?: number | null;
  limit?: number;
  beforeMessageId?: number | null;
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

  const where: any = {
    chatId,
    deletedBy: uid ? { [Op.in]: [0, uid] } : 0,
  };
  if (safeBefore) {
    where.id = { [Op.lt]: safeBefore };
  }

  const messages = await Message.findAll({
    where,
    order: [["id", "DESC"]],
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

  const ordered = [...messages].reverse();
  const nextCursor =
    ordered.length > 0
      ? {
          beforeMessageId: Number((ordered[0] as any)?.id),
        }
      : null;

  return {
    ok: true as const,
    group: access.group,
    policy: access.policy,
    chatId,
    messages: ordered,
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

  const now = new Date();
  const created = await Message.create({
    text: payload.text ?? null,
    messageType: payload.messageType,
    mediaUrl: payload.mediaUrl ?? null,
    mediaMime: payload.mediaMime ?? null,
    mediaDurationMs: payload.mediaDurationMs ?? null,
    mediaSizeBytes: payload.mediaSizeBytes ?? null,
    waveform: payload.waveform ?? null,
    metadata: payload.metadata ?? null,
    senderId: senderUserId,
    chatId,
    date: now,
    deletedBy: 0,
    replyToMessageId: toPositiveInt(replyToMessageId) ?? null,
  });

  await pruneChatHistoryForChat(chatId);

  const fullMessage = await Message.findByPk(Number((created as any).id), {
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

  const memberUserIds = await getActiveMemberUserIds(groupId);
  return {
    ok: true as const,
    chatId,
    message: fullMessage,
    group: access.group,
    policy: access.policy,
    memberUserIds,
  };
};
