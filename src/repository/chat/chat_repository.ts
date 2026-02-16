import { Op, Sequelize } from "sequelize";
import Chat from "../../_models/chat/chat";
import User from "../../_models/user/user";
import sequelize from "../../_db/connection";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Chat_User from "../../_models/chat/chat_user";
import UserBlock from "../../_models/block/block";

const excludeKeys = ["createdAt", "updatedAt", "password"];
const MAX_MESSAGES_PER_CHAT = Math.max(
  1,
  Number(process.env.CHAT_MAX_MESSAGES_PER_CHAT ?? 20) || 20
);

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
  mensajeInicial: any,
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

    // Reactivar si estÃ¡ eliminado
    chat = await Chat.findByPk(chatId);
    if (chat && existingChat[0].deletedBy !== 0) {
      await chat.update({ deletedBy: 0 });
    }
  }

  const createdMessage = await Message.create({
    text: mensajeInicial,
    senderId: me,
    chatId,
    date: now,
    deletedBy: 0,
    replyToMessageId: replyToMessageId ?? null,
  });

  await pruneChatHistory(chatId, MAX_MESSAGES_PER_CHAT);

  return {
    chatId,
    messageId: Number(createdMessage.id),
    chat,
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
        attributes: ["id", "text", "senderId", "date"],
      },
    ],
    attributes: { exclude: excludeKeys },
  });

  return messages;
};

export const getSenderByMessageId = async (messageId: any) => {
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

  return messages;
};

/**
 * âœ… GET CHAT BY USER (FIX CRÃTICO)
 * - bloqueados => []
 * - chat visible si Chat.deletedBy IN (0, me)
 * - mensajes visibles si Message.deletedBy IN (0, me)
 * - paginaciÃ³n por id < beforeMessageId
 */
export const getChatByUser = async (
  currentUserId: any,
  otherUserId: any,
  opts?: { limit?: number; beforeMessageId?: number | null }
) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  const otherUser = await User.findByPk(other);
  if ((otherUser as any)?.is_deleted) return [];

  if (await isBlockedEitherWay(me, other)) return [];

  const existingChat = await chatExist(me, other);
  if (!existingChat?.length) return [];

  const chatId = existingChat[0].chatId;

  // âœ… FIX: chat visible si deletedBy = 0 o = me (NO -1)
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
    deletedBy: { [Op.in]: [0, me] }, // âœ… FIX: mensajes visibles
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
 * âœ… GET USER CHATS (LISTA)
 * Objetivo:
 * - no mostrar chats eliminados para ambos (-1)
 * - no mostrar chats eliminados para mÃ­ (si tu semÃ¡ntica asÃ­ lo requiere)
 * - no mostrar usuarios bloqueados (en ambos sentidos)
 *
 * FIXES:
 * - usa deletedBy IN (0, currentUserId) en Chat (misma lÃ³gica del resto)
 * - filtra bloqueos con replacements (sin interpolar me en string)
 */
export const getUserChats = async (currentUserId: number, meId: any = -1) => {
  const me = Number(meId);
  const uid = Number(currentUserId);

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

  const chats = await Chat_User.findAll({
    attributes: [
      "userId",
      "chatId",
      "pinnedAt",
      "pinnedOrder",
      "createdAt",
      "updatedAt",
    ],
    where: { userId: uid },
    include: [
      {
        model: Chat,
        // âœ… FIX: chat visible si deletedBy = 0 o = uid (NO -1)
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
            // âœ… solo el Ãºltimo mensaje visible para mÃ­
            where: {
              deletedBy: { [Op.in]: [0, uid] },
            },
            order: [
              ["date", "DESC"],
              ["id", "DESC"],
            ],
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
    // âœ… replacements solo si usamos filtro
    ...(useBlockFilter ? { replacements: { me } } : {}),
  });

  const pinnedRows = await Chat_User.findAll({
    attributes: ["chatId", "pinnedAt", "pinnedOrder"],
    where: { userId: uid },
    raw: true,
  });
  const pinnedByChatId = new Map<
    number,
    { pinnedAt: Date | null; pinnedOrder: number | null }
  >();
  for (const row of pinnedRows as any[]) {
    const chatId = Number(row.chatId);
    if (!Number.isFinite(chatId)) continue;
    pinnedByChatId.set(chatId, {
      pinnedAt: row.pinnedAt ?? null,
      pinnedOrder: row.pinnedOrder ?? null,
    });
  }
  for (const chat of chats as any[]) {
    const chatId = Number(chat.chatId ?? chat.get?.("chatId"));
    if (!Number.isFinite(chatId)) continue;
    const pinned = pinnedByChatId.get(chatId);
    if (!pinned) continue;
    if (typeof chat.setDataValue === "function") {
      chat.setDataValue("pinnedAt", pinned.pinnedAt);
      chat.setDataValue("pinnedOrder", pinned.pinnedOrder);
    }
    chat.pinnedAt = pinned.pinnedAt;
    chat.pinnedOrder = pinned.pinnedOrder;
  }

  // ordenar por pin + fecha del último mensaje
  chats.sort((a: any, b: any) => {
    const pinA = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
    const pinB = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;

    if (pinA && !pinB) return -1;
    if (!pinA && pinB) return 1;
    if (pinA && pinB && pinA !== pinB) return pinB - pinA;

    const dateA = new Date(a.Chat?.messages?.[0]?.date ?? 0).getTime() || 0;
    const dateB = new Date(b.Chat?.messages?.[0]?.date ?? 0).getTime() || 0;
    return dateB - dateA;
  });

  return chats;
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

async function pruneChatHistory(chatId: number, keepLimit: number): Promise<void> {
  const keep = Math.max(1, Number(keepLimit) || 1);

  const oldMessages = await Message.findAll({
    where: { chatId },
    attributes: ["id"],
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
}



