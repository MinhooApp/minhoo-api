// src/_sockets/socket_controller.ts
import { Socket } from "socket.io";
import Offer from "../_models/offer/offer";
import Service from "../_models/service/service";
import Message from "../_models/chat/message";
import Notification from "_models/notification/notification";
import { Op } from "sequelize";
import { sendNotification } from "../useCases/notification/add/add";

type ChatStatus = "sent" | "delivered" | "read";

type ChatStatusPayload = {
  chatId: number;
  messageId: number;
  userId?: number;
};

type ChatJoinPayload = { chatId: number };

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

/**
 * ✅ EMIT HÍBRIDO (Room + Legacy)
 * - Nuevo (APK nueva):   room/<event>  (a un room)
 * - Legacy (vieja):      <event>       (broadcast global)
 *
 * Importante:
 * - Usamos broadcast/to(room) para NO re-enviar al emisor.
 */
function emitChatHybrid(socket: Socket, chatId: number, event: string, data: any) {
  // NUEVO (rooms)
  socket.to(chatRoom(chatId)).emit(`room/${event}`, data);

  // LEGACY (sin rooms)
  socket.broadcast.emit(event, data);
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

  //////////////////////////// Chat //////////////////////

  // ✅ join a room del chat (APK nueva)
  socket.on("chat:join", (payload: ChatJoinPayload) => {
    try {
      const chatId = Number(payload?.chatId);
      if (!chatId) return;
      socket.join(chatRoom(chatId));
    } catch (e) {
      console.log("❌ chat:join error", e);
    }
  });

  // ✅ leave room (APK nueva)
  socket.on("chat:leave", (payload: ChatJoinPayload) => {
    try {
      const chatId = Number(payload?.chatId);
      if (!chatId) return;
      socket.leave(chatRoom(chatId));
    } catch (e) {
      console.log("❌ chat:leave error", e);
    }
  });

  // ✅ lista de chats (se mantiene igual)
  socket.on("chats", (userId: number) => {
    socket.broadcast.emit(`chats/${userId}`);
  });

  /**
   * ✅ MENSAJE NUEVO
   * - Nuevo:   room/chat/{chatId}
   * - Legacy:  chat/{chatId}
   */
  socket.on("chat", (message: any) => {
    try {
      const chatId = Number(message?.chatId);
      if (!chatId) return;

      emitChatHybrid(socket, chatId, `chat/${chatId}`, message);
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
      const chatId = Number(payload?.chatId);
      const userId = Number(payload?.userId);
      const typing = !!payload?.typing;

      if (!chatId || !userId) return;

      emitChatHybrid(socket, chatId, `chat/typing/${chatId}`, {
        chatId,
        userId,
        typing,
      });
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
      const chatId = Number(payload?.chatId);
      const messageId = Number(payload?.messageId);
      const userId = Number(payload?.userId);
      const emoji = String(payload?.emoji ?? "").trim();

      if (!chatId || !messageId || !userId || !emoji) return;

      const msg: any = await Message.findByPk(messageId);
      if (!msg) return;

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
          senderName: `ID: ${userId}`,
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
      const chatId = Number(payload?.chatId);
      const messageId = Number(payload?.messageId);
      if (!chatId || !messageId) return;

      const deliveredAt = new Date();

      const [updatedCount] = await Message.update(
        { status: "delivered", deliveredAt },
        { where: { id: messageId, status: "sent" } }
      );

      if (!updatedCount) return;

      emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
        chatId,
        messageId,
        status: "delivered" as ChatStatus,
        deliveredAt: deliveredAt.toISOString(),
      });
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
      const chatId = Number(payload?.chatId);
      const messageId = Number(payload?.messageId);
      if (!chatId || !messageId) return;

      const now = new Date();

      const msg: any = await Message.findByPk(messageId);
      if (!msg) return;
      if (msg.status === "read") return;

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

      emitChatHybrid(socket, chatId, `chat/status/${chatId}`, {
        chatId,
        messageId,
        status: "read" as ChatStatus,
        readAt: now.toISOString(),
      });
    } catch (e) {
      console.log("❌ chat:read error", e);
    }
  });

  ////////////////////// Notification /////////////////////
  socket.on("notification", (notification: Notification) => {
    socket.broadcast.emit(`notification/${notification.userId}`, notification);
  });
};
