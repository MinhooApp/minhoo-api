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

function requireAuthenticatedUser(
  socket: Socket,
  event: string,
  payloadUserId?: number
): number {
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

function normalizeToken(raw: any): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
}

function resolveUserIdFromToken(tokenRaw: any): number {
  const token = normalizeToken(tokenRaw);
  if (!token) return 0;

  const secrets = [
    (process.env.SECRETORPRIVATEKEY ?? "").trim(),
    (process.env.JWT_SECRET ?? "").trim(),
    "tokenTest",
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

  try {
    const decoded = jwt.decode(token) as any;
    return (
      parseUserId(decoded) ||
      parseUserId({ userId: decoded?.sub }) ||
      parseUserId({ userId: decoded?.id })
    );
  } catch (_) {
    return 0;
  }
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
  if (directUserId > 0) return directUserId;

  const token =
    auth?.token ??
    auth?.accessToken ??
    auth?.jwt ??
    query?.token ??
    query?.access_token ??
    query?.urlToken ??
    headers?.authorization ??
    headers?.Authorization;

  return resolveUserIdFromToken(token);
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

  // Fallback para clientes legacy sin bind de userId en socket.data.
  if (delivered === 0) {
    socket.broadcast.emit(`chats/${userId}`);
    socket.broadcast.emit("chats", { userId });
  }
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

  const handshakeUserId = resolveUserIdFromHandshake(socket);
  if (handshakeUserId > 0) {
    (socket.data as any).userId = handshakeUserId;
    socket.join(userRoom(handshakeUserId));
    console.log(`[socket] bind userId=${handshakeUserId} source=handshake socket=${socket.id}`);
  } else {
    console.log(`[socket] bind userId=0 source=handshake socket=${socket.id}`);
  }

  socket.on("bind-user", (payload: any) => {
    try {
      const payloadUserId = parseUserId(payload);
      const tokenUserId = resolveUserIdFromToken(
        payload?.token ?? payload?.authToken ?? payload?.jwt ?? payload?.authorization
      );
      const socketUserId = getSocketUserId(socket);

      const resolvedUserId = tokenUserId > 0 ? tokenUserId : socketUserId;
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
      socket.join(userRoom(resolvedUserId));
      console.log(`[socket] bind userId=${resolvedUserId} source=bind-user socket=${socket.id}`);
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

  //////////////////////////// Chat //////////////////////

  // ✅ join a room del chat (APK nueva)
  socket.on("chat:join", (payload: ChatJoinPayload) => {
    try {
      const chatId = parseChatId(payload);
      if (!chatId) {
        console.log(`[socket] chat:join ignored invalid payload socket=${socket.id} payload=${JSON.stringify(payload)}`);
        return;
      }
      const actorUserId = requireAuthenticatedUser(socket, "chat:join", parseUserId(payload));
      if (!actorUserId) return;

      void (async () => {
        const isMember = await isUserParticipantInChat(chatId, actorUserId);
        if (!isMember) {
          console.log(
            `[socket] chat:join rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
          );
          socket.emit("auth:error", { event: "chat:join", code: "FORBIDDEN_CHAT", chatId });
          return;
        }

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

        emitChatsRefresh(socket, actorUserId);
      })().catch((err) => console.log("❌ chat:join mark-read error", err));
    } catch (e) {
      console.log("❌ chat:join error", e);
    }
  });

  // ✅ leave room (APK nueva)
  socket.on("chat:leave", (payload: ChatJoinPayload) => {
    try {
      const chatId = parseChatId(payload);
      if (!chatId) {
        console.log(`[socket] chat:leave ignored invalid payload socket=${socket.id} payload=${JSON.stringify(payload)}`);
        return;
      }
      const actorUserId = requireAuthenticatedUser(socket, "chat:leave", parseUserId(payload));
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

      const actorUserId = requireAuthenticatedUser(socket, "chat:sync", parseUserId(payload));
      if (!actorUserId) return;

      const isMember = await isUserParticipantInChat(chatId, actorUserId);
      if (!isMember) {
        console.log(
          `[socket] chat:sync rejected forbidden chatId=${chatId} socket=${socket.id} userId=${actorUserId}`
        );
        socket.emit("auth:error", { event: "chat:sync", code: "FORBIDDEN_CHAT", chatId });
        return;
      }

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
            attributes: ["id", "text", "senderId", "date"],
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
      const chatId = parseChatId(message?.chatId != null ? message : message?.chat);
      if (!chatId) return;
      const senderId = parseUserId({
        userId: message?.senderId ?? message?.sender?.id,
      });
      if (senderId > 0) {
        (socket.data as any).userId = senderId;
      }

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
              status: { [Op.in]: ["sent", "delivered"] },
            },
          }
        );

        if (!updatedCount) return;

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
      const userId = requireAuthenticatedUser(socket, "chat:typing", parseUserId(payload));
      const typing = !!payload?.typing;

      if (!chatId || !userId) return;
      void (async () => {
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
      const userId = requireAuthenticatedUser(socket, "chat:reaction", parseUserId(payload));
      const emoji = String(payload?.emoji ?? "").trim();

      if (!chatId || !messageId || !userId || !emoji) return;
      const isMember = await isUserParticipantInChat(chatId, userId);
      if (!isMember) {
        console.log(
          `[socket] chat:reaction rejected forbidden chatId=${chatId} socket=${socket.id} userId=${userId}`
        );
        return;
      }

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
      const actorUserId = requireAuthenticatedUser(
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
      const actorUserId = requireAuthenticatedUser(socket, "chat:read", parseUserId(payload));
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
