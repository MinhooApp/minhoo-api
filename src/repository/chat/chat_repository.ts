import { Op } from "sequelize";
import Chat from "../../_models/chat/chat";
import User from "../../_models/user/user";
import sequelize from "../../_db/connection";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Chat_User from "../../_models/chat/chat_user";
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
  // Buscar si hay un chat existente entre ambos usuarios
  const existingChat = await chatExist(currentUserId, otherUserId);

  if (existingChat.length === 0) return [];

  const chatId = existingChat[0].chatId;

  // Verificar si el chat está eliminado para este usuario
  const chat = await Chat.findOne({
    where: {
      id: chatId,
      deletedBy: {
        [Op.not]: [-1, currentUserId], // El chat no debe estar eliminado por ambos ni por currentUserId
      },
    },
  });

  if (!chat) return [];

  // Obtener los mensajes válidos
  const messages = await Message.findAll({
    order: [["date", "ASC"]],
    where: {
      chatId,
      deletedBy: {
        [Op.not]: [-1, currentUserId], // Excluir mensajes eliminados por currentUserId o por ambos
      },
    },
    attributes: { exclude: excludeKeys },
  });

  return messages;
};

export const getUserChats = async (currentUserId: any) => {
  const chats = await Chat_User.findAll({
    where: {
      userId: currentUserId,
    },
    include: [
      {
        model: Chat,
        where: {
          deletedBy: {
            [Op.not]: [-1, currentUserId], // Excluir -1 y currentUserId
          },
        },
        include: [
          {
            model: User,
            as: "users",
            where: {
              id: {
                [Op.ne]: currentUserId, // Excluir al usuario actual
              },
            },
            through: {
              attributes: [], // No incluir atributos de la tabla intermedia
            },
          },
          {
            model: Message,
            as: "messages",
            required: false, // LEFT JOIN para incluir chats sin mensajes
            order: [["date", "DESC"]],
            limit: 1,
          },
        ],
      },
    ],
  });

  // Ordenar los chats por la fecha del último mensaje
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
