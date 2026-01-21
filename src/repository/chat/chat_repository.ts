import { Op, Sequelize } from "sequelize";
import Chat from "../../_models/chat/chat";
import User from "../../_models/user/user";
import sequelize from "../../_db/connection";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Chat_User from "../../_models/chat/chat_user";
import UserBlock from "../../_models/block/block";

const excludeKeys = ["createdAt", "updatedAt", "password"];

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
 * Valida si hay un bloqueo entre dos usuarios (en cualquier dirección).
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
 * ✅ INIT CHAT
 * - Si hay bloqueo => no crear chat/mensaje (devuelve null)
 * - replyToMessageId opcional (no rompe)
 */
export const initNewChat = async (
  currentUserId: any,
  otherUserId: any,
  mensajeInicial: any,
  replyToMessageId?: number | null
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  if (await isBlockedEitherWay(me, other)) {
    // lo ideal es que tu controller convierta esto a 403
    return null;
  }

  const now = new Date(new Date().toUTCString());
  const existingChat = await chatExist(me, other);

  let chatId: number;
  let chat: any = null;

  if (existingChat.length === 0) {
    const newChat = await Chat.create();
    chatId = newChat.id;

    await Chat_User.bulkCreate([
      { userId: me, chatId },
      { userId: other, chatId },
    ]);

    chat = newChat;
  } else {
    chatId = existingChat[0].chatId;

    // Reactivar si está eliminado
    chat = await Chat.findByPk(chatId);
    if (chat && existingChat[0].deletedBy !== 0) {
      await chat.update({ deletedBy: 0 });
    }
  }

  await Message.create({
    text: mensajeInicial,
    senderId: me,
    chatId,
    date: now,
    deletedBy: 0,
    replyToMessageId: replyToMessageId ?? null,
  });

  return chat;
};

/**
 * ✅ GET CHAT MESSAGES (FIX CRÍTICO)
 * Regla correcta de visibilidad según tu semántica:
 * - visible si deletedBy = 0 (nadie borró)
 * - visible si deletedBy = me (lo borró el otro, o “borrado para 1” según tu lógica)
 * - NO mostrar si deletedBy = -1 (borrado para ambos)
 * - NO mostrar si deletedBy = other (borrado por mí)
 */
export const getChatMessages = async (chatId: any, currentUserId: any) => {
  const me = Number(currentUserId);

  const messages = await Message.findAll({
    order: [["date", "DESC"]],
    where: {
      chatId,
      deletedBy: { [Op.in]: [0, me] }, // ✅ FIX: nunca traer -1
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
        attributes: ["id", "text", "senderId", "date"],
      },
    ],
    attributes: { exclude: excludeKeys },
  });

  return messages;
};

export const getSenderByMessageId = async (messageId: any) => {
  const messages = await Message.findOne({
    order: [["date", "DESC"]],
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

  return messages;
};

/**
 * ✅ GET CHAT BY USER (FIX CRÍTICO)
 * - bloqueados => []
 * - chat visible si Chat.deletedBy IN (0, me)
 * - mensajes visibles si Message.deletedBy IN (0, me)
 * - paginación por id < beforeMessageId
 */
export const getChatByUser = async (
  currentUserId: any,
  otherUserId: any,
  opts?: { limit?: number; beforeMessageId?: number | null }
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  if (await isBlockedEitherWay(me, other)) return [];

  const existingChat = await chatExist(me, other);
  if (!existingChat?.length) return [];

  const chatId = existingChat[0].chatId;

  // ✅ FIX: chat visible si deletedBy = 0 o = me (NO -1)
  const chat = await Chat.findOne({
    where: {
      id: chatId,
      deletedBy: { [Op.in]: [0, me] },
    },
  });
  if (!chat) return [];

  const limit = Math.max(1, Math.min(Number(opts?.limit ?? 50) || 50, 200));
  const beforeMessageId =
    opts?.beforeMessageId == null ? null : Number(opts?.beforeMessageId);

  const where: any = {
    chatId,
    deletedBy: { [Op.in]: [0, me] }, // ✅ FIX: mensajes visibles
  };

  if (Number.isFinite(beforeMessageId as any) && (beforeMessageId as number) > 0) {
    where.id = { [Op.lt]: beforeMessageId };
  }

  const messages = await Message.findAll({
    where,
    order: [["id", "DESC"]],
    limit,
    attributes: { exclude: excludeKeys },
    include: [
      {
        model: Message,
        as: "replyTo",
        required: false,
        attributes: ["id", "text", "senderId", "date"],
      },
    ],
  });

  return messages.reverse();
};

/**
 * ✅ GET USER CHATS (LISTA)
 * Objetivo:
 * - no mostrar chats eliminados para ambos (-1)
 * - no mostrar chats eliminados para mí (si tu semántica así lo requiere)
 * - no mostrar usuarios bloqueados (en ambos sentidos)
 *
 * FIXES:
 * - usa deletedBy IN (0, currentUserId) en Chat (misma lógica del resto)
 * - filtra bloqueos con replacements (sin interpolar me en string)
 */
export const getUserChats = async (currentUserId: number, meId: any = -1) => {
  const me = Number(meId);
  const uid = Number(currentUserId);

  const useBlockFilter = Number.isFinite(me) && me > 0;

  // Este where se aplica al “otro usuario” dentro del chat
  const userWhere: any = {
    id: { [Op.ne]: uid },
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

  const chats = await Chat_User.findAll({
    where: { userId: uid },
    include: [
      {
        model: Chat,
        // ✅ FIX: chat visible si deletedBy = 0 o = uid (NO -1)
        where: {
          deletedBy: { [Op.in]: [0, uid] },
        },
        include: [
          {
            model: User,
            as: "users",
            where: userWhere,
            through: { attributes: [] },
            required: true,
          },
          {
            model: Message,
            as: "messages",
            required: false,
            // ✅ solo el último mensaje visible para mí
            where: {
              deletedBy: { [Op.in]: [0, uid] },
            },
            order: [["date", "DESC"]],
            limit: 1,
            attributes: [
              "id",
              "chatId",
              "senderId",
              "text",
              "date",
              "deletedBy",
              "status",
              "deliveredAt",
              "readAt",
              "replyToMessageId",
              "reactions",
            ],
          },
        ],
      },
    ],
    // ✅ replacements solo si usamos filtro
    ...(useBlockFilter ? { replacements: { me } } : {}),
  });

  // ordenar por fecha del último mensaje
  chats.sort((a: any, b: any) => {
    const dateA = a.Chat?.messages?.[0]?.date || 0;
    const dateB = b.Chat?.messages?.[0]?.date || 0;
    return dateB - dateA;
  });

  return chats;
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

  await Message.update(
    {
      deletedBy: sequelize.literal(`
        CASE 
          WHEN deletedBy = 0 THEN ${uid}
          WHEN deletedBy <> ${uid} THEN -1
          ELSE deletedBy
        END
      `),
    },
    { where: { chatId } }
  );

  await Chat.update(
    {
      deletedBy: sequelize.literal(`
        CASE 
          WHEN deletedBy = 0 THEN ${uid}
          WHEN deletedBy <> ${uid} THEN -1
          ELSE deletedBy
        END
      `),
    },
    { where: { id: chatId } }
  );
};

// =======================================================
// ✅ STATUS HELPERS (no rompen)
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

// =======================================================

async function chatExist(currentUserId: any, otherUserId: any) {
  const chat = await Chat_User.findAll({
    where: {
      [Op.and]: [
        { [Op.or]: [{ userId: currentUserId }, { userId: otherUserId }] },
        {
          chatId: {
            [Op.in]: (
              await Chat_User.findAll({
                where: {
                  userId: { [Op.or]: [currentUserId, otherUserId] },
                },
                attributes: ["chatId"],
                group: ["chatId"],
                having: sequelize.literal("COUNT(DISTINCT userId) = 2"),
              })
            ).map((c) => c.chatId),
          },
        },
      ],
    },
    order: ["userId"],
  });

  return chat;
}

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
