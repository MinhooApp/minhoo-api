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
  // Verifica si ya existe un chat activo entre los usuarios
  const chat = await chatExist(currentUserId, otherUserId);
  // Si no existe un chat activo, crea uno nuevo y envía un mensaje inicial
  if (chat.length <= 0) {
    const newChat = await Chat.create(); //
    await Chat_User.bulkCreate([
      { userId: otherUserId, chatId: newChat.id },
      { userId: currentUserId, chatId: newChat.id },
    ]);
    // Envía el mensaje inicial
    await Message.create({
      text: mensajeInicial,
      senderId: currentUserId,
      chatId: newChat.id,
      date: now,
    });
    return await Chat.findByPk(newChat.id, {
      attributes: { exclude: excludeKeys },
      include: [
        {
          model: Message,
          as: "messages",
          attributes: { exclude: excludeKeys },
        },
      ],
    });
  } else {
    await Message.create({
      text: mensajeInicial,
      senderId: currentUserId,
      chatId: chat[0].chatId,
      date: now,
    });
    //si existe el chat y fue eliminado, se reactiva

    const ch = await Chat.findByPk(chat[0].chatId, {
      attributes: { exclude: excludeKeys },
      include: [
        {
          model: Message,
          as: "messages",
          attributes: { exclude: excludeKeys },
        },
      ],
    });
    if (chat[0].deleteBy != 0) {
      await ch!.update({ deletedBy: 0 });
    }
    return ch;
  }
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

export const getChatByUser = async (currentUserId: any, otherUserId: any) => {
  // Verifica si ya existe un chat activo entre los usuarios
  const existingChat = await chatExist(currentUserId, otherUserId);

  if (existingChat.length > 0) {
    const messages = await Message.findAll({
      order: [["date", "ASC"]],
      where: {
        chatId: existingChat[0].chatId,
        [Op.and]: [
          {
            deletedBy: {
              [Op.not]: [-1, currentUserId], // Excluir -1 y currentUserId
            },
          },
        ],
      },

      attributes: { exclude: excludeKeys },
    });

    return messages;
  } else {
    return [];
  }
};

// Función para obtener chats que no han sido eliminados por ambos usuarios
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
    order: [
      [
        { model: Chat, as: "Chat" },
        { model: Message, as: "messages" },
        "date",
        "DESC",
      ],
    ],
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
  // Actualiza la entrada de Message para marcar los mensajes como eliminados por el usuario actual

  await deleteChatByMessages(chatId, currentUserId);
  await Chat.update(
    {
      deletedBy: sequelize.literal(
        `CASE WHEN deletedBy = 0 THEN ${currentUserId} WHEN deletedBy <> ${currentUserId} THEN -1 ELSE deletedBy END`
      ),
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
