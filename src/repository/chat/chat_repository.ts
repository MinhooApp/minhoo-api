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
  const chat = await Chat.findOne({ where: { id: id } });
  return chat;
};

export const update = async (id: any, body: any) => {
  const chatTemp = await Chat.findByPk(id);
  const chat = await chatTemp?.update(body);
  return [chat];
};

/**
 * Valida si hay un bloqueo entre dos usuarios (en cualquier dirección).
 * @param user_A id del primer usuario
 * @param user_B id del segundo usuario
 * @returns true si existe un bloqueo entre ellos, false si no.
 */
export const validateBlock = async (
  user_A: number,
  user_B: number
): Promise<boolean> => {
  const block = await UserBlock.findOne({
    where: {
      [Op.or]: [
        { blocker_id: user_A, blocked_id: user_B },
        { blocker_id: user_B, blocked_id: user_A },
      ],
    },
    attributes: ["id"], // solo necesitamos saber si existe
  });

  return !!block; // true si encontró, false si no
};
export const initNewChat = async (
  currentUserId: any,
  otherUserId: any,
  mensajeInicial: any
) => {
  const now = new Date(new Date().toUTCString());
  const existingChat = await chatExist(currentUserId, otherUserId);
  let chatId: number;
  let chat;
  if (existingChat.length === 0) {
    const newChat = await Chat.create();
    chatId = newChat.id;

    await Chat_User.bulkCreate([
      { userId: currentUserId, chatId },
      { userId: otherUserId, chatId },
    ]);
  } else {
    chatId = existingChat[0].chatId;

    // Reactivar si está eliminado
    chat = await Chat.findByPk(chatId);
    if (chat && existingChat[0].deletedBy !== 0) {
      await chat.update({ deletedBy: 0 });
    }
  }

  // Crear mensaje inicial
  await Message.create({
    text: mensajeInicial,
    senderId: currentUserId,
    chatId,
    date: now,
    deletedBy: 0, // importante si tu modelo no tiene default
  });

  return chat;
};

// Función para obtener mensajes de un chat que no han sido eliminados por ambos usuarios
export const getChatMessages = async (chatId: any, currentUserId: any) => {
  const messages = await Message.findAll({
    order: [["date", "DESC"]],
    where: {
      chatId: chatId,
      [Op.or]: [
        { deletedBy: 0 }, // Mensajes no eliminados por ninguno de los usuarios
        { deletedBy: currentUserId }, // Mensajes eliminados por el usuario actual
        { deletedBy: -1 }, // Mensajes eliminados por ambos usuarios
      ],
    },
    include: [
      {
        model: User,
        as: "sender",
      },
    ],

    attributes: { exclude: excludeKeys },
  });

  return messages;
};
export const getSenderByMessageId = async (messageId: any) => {
  const messages = await Message.findOne({
    order: [["date", "DESC"]],
    where: {
      id: messageId,
    },
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
export const getChatByUser = async (currentUserId: any, otherUserId: any) => {
  const me = Number(currentUserId);
  const other = Number(otherUserId);

  // 1) Bloqueo en cualquier dirección → no hay chat/mensajes
  if (await isBlockedEitherWay(me, other)) {
    return []; // o throw new Forbidden('No puedes chatear con este usuario');
  }

  // 2) Buscar chat existente entre ambos (tu función actual)
  const existingChat = await chatExist(me, other);
  if (!existingChat?.length) return [];

  const chatId = existingChat[0].chatId;

  // 3) Validar que el chat no esté eliminado para este usuario
  const chat = await Chat.findOne({
    where: {
      id: chatId,
      deletedBy: { [Op.not]: [-1, me] },
    },
  });
  if (!chat) return [];

  // 4) Mensajes no eliminados para este usuario
  const messages = await Message.findAll({
    where: {
      chatId,
      deletedBy: { [Op.not]: [-1, me] },
    },
    order: [["date", "ASC"]],
    attributes: { exclude: excludeKeys },
  });

  return messages;
};

export const getUserChats = async (currentUserId: number, meId: any = -1) => {
  const me = Number(meId);

  const userWhere: any = {
    id: { [Op.ne]: currentUserId }, // excluir al usuario actual
  };

  // Aplica filtro de bloqueos solo si meId es válido
  if (Number.isFinite(me)) {
    userWhere[Op.and] = [
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM \`user_blocks\` ub
          WHERE
            (ub.blocker_id = ${me} AND ub.blocked_id = \`Chat->users\`.\`id\`)
            OR
            (ub.blocker_id = \`Chat->users\`.\`id\` AND ub.blocked_id = ${me})
        )
      `),
    ];
  }

  const chats = await Chat_User.findAll({
    where: { userId: currentUserId },
    include: [
      {
        model: Chat,
        where: {
          deletedBy: { [Op.not]: [-1, currentUserId] },
        },
        include: [
          {
            model: User,
            as: "users",
            where: userWhere, // <<--- aquí va el NOT EXISTS con alias `Chat->users`
            through: { attributes: [] },
            required: true, // asegura que exista “el otro” usuario tras filtrar bloqueos
          },
          {
            model: Message,
            as: "messages",
            required: false,
            order: [["date", "DESC"]],
            limit: 1,
          },
        ],
      },
    ],
  });

  // Ordena por última fecha de mensaje
  chats.sort((a: any, b: any) => {
    const dateA = a.Chat.messages[0]?.date || 0;
    const dateB = b.Chat.messages[0]?.date || 0;
    return dateB - dateA;
  });

  return chats;
};
export const deleteChatByMessages = async (chatId: any, currentUserId: any) => {
  // Actualiza la entrada de Message para marcar los mensajes como eliminados por el usuario actual
  await Message.update(
    {
      deletedBy: sequelize.literal(
        `CASE WHEN deletedBy = 0 THEN ${currentUserId} WHEN deletedBy <> ${currentUserId} THEN -1 ELSE deletedBy END`
      ),
    },
    { where: { chatId } }
  );
};
export const deleteChat = async (chatId: any, currentUserId: any) => {
  // Actualiza los mensajes del chat aplicando la misma lógica de "deletedBy"
  await Message.update(
    {
      deletedBy: sequelize.literal(`
        CASE 
          WHEN deletedBy = 0 THEN ${currentUserId}
          WHEN deletedBy <> ${currentUserId} THEN -1
          ELSE deletedBy
        END
      `),
    },
    { where: { chatId } }
  );

  // Actualiza el chat con la misma lógica
  await Chat.update(
    {
      deletedBy: sequelize.literal(`
        CASE 
          WHEN deletedBy = 0 THEN ${currentUserId}
          WHEN deletedBy <> ${currentUserId} THEN -1
          ELSE deletedBy
        END
      `),
    },
    { where: { id: chatId } }
  );
};

async function chatExist(currentUserId: any, otherUserId: any) {
  const chat = await Chat_User.findAll({
    where: {
      [Op.and]: [
        {
          [Op.or]: [{ userId: currentUserId }, { userId: otherUserId }],
        },
        {
          chatId: {
            [Op.in]: (
              await Chat_User.findAll({
                where: {
                  userId: {
                    [Op.or]: [currentUserId, otherUserId],
                  },
                },
                attributes: ["chatId"],
                group: ["chatId"],
                having: sequelize.literal("COUNT(DISTINCT userId) = 2"),
              })
            ).map((chat) => chat.chatId),
          },
        },
      ],
    },
    order: ["userId"],
  });
  return chat;
}
async function isBlockedEitherWay(a: number, b: number): Promise<boolean> {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
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
