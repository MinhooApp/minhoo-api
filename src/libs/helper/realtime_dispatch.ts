import { getSocketInstance } from "../../_sockets/socket_instance";
import { getInternalSocket } from "./internal_socket";

const userRoom = (userId: number) => `user_${userId}`;
const chatRoom = (chatId: number) => `chat_${chatId}`;
const chatActiveRoom = (chatId: number) => `chat_active_${chatId}`;
const COMPAT_NAMESPACES = ["/", "/api", "/api/v1"] as const;
const chatsRefreshLastEmit = new Map<number, number>();
const chatsRefreshDebounceMs = Math.max(
  0,
  Number(process.env.CHATS_REFRESH_DEBOUNCE_MS ?? 1200) || 1200
);

const toUserIds = (userIds?: Array<number | string | null | undefined>): number[] => {
  if (!userIds || userIds.length === 0) return [];
  const unique = new Set<number>();
  for (const raw of userIds) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) unique.add(n);
  }
  return [...unique];
};

const emitGlobal = (event: string, payload?: unknown) => {
  const io = getSocketInstance();
  if (io) {
    const clients = io.engine.clientsCount;
    if (event.startsWith("chat/") || event === "chat" || event.startsWith("chats")) {
      console.log(`[realtime-direct] emit event=${event} clients=${clients}`);
    }
    for (const namespace of COMPAT_NAMESPACES) {
      io.of(namespace).emit(event, payload);
    }
    return;
  }
  // Fallback para escenarios donde aún no existe instancia local.
  getInternalSocket().emit(event, payload);
};

const emitToChat = (chatId: number, event: string, payload?: unknown) => {
  const io = getSocketInstance();
  if (!io) {
    getInternalSocket().emit(event, payload);
    return;
  }

  const room = chatRoom(chatId);
  for (const namespace of COMPAT_NAMESPACES) {
    io.of(namespace).to(room).emit(event, payload);
  }
};

const emitToChatExcludingUsers = (
  chatId: number,
  event: string,
  payload: unknown,
  excludeUserIds?: Array<number | string | null | undefined>
) => {
  const io = getSocketInstance();
  if (!io) {
    getInternalSocket().emit(event, payload);
    return;
  }

  const excluded = new Set(toUserIds(excludeUserIds));
  if (excluded.size === 0) {
    emitToChat(chatId, event, payload);
    return;
  }

  const room = chatRoom(chatId);
  for (const namespace of COMPAT_NAMESPACES) {
    const nsp = io.of(namespace);
    const socketIds = nsp.adapter.rooms.get(room);
    if (!socketIds || socketIds.size === 0) continue;

    for (const socketId of socketIds) {
      const sock = nsp.sockets.get(socketId);
      if (!sock) continue;
      const boundUserId = Number((sock.data as any)?.userId ?? 0);
      if (excluded.has(boundUserId)) continue;
      sock.emit(event, payload);
    }
  }
};

const emitToUsers = (
  event: string,
  payload: unknown,
  userIds?: Array<number | string | null | undefined>
) => {
  const ids = toUserIds(userIds);
  if (ids.length === 0) return;

  const io = getSocketInstance();
  if (!io) return;

  for (const id of ids) {
    for (const namespace of COMPAT_NAMESPACES) {
      io.of(namespace).to(userRoom(id)).emit(event, payload);
    }
  }
};

const emitToUsersOutsideChat = (
  chatId: number,
  event: string,
  payload: unknown,
  userIds?: Array<number | string | null | undefined>
) => {
  const ids = toUserIds(userIds);
  if (ids.length === 0) return;

  const io = getSocketInstance();
  if (!io) return;

  const chatRoomName = chatRoom(chatId);
  for (const namespace of COMPAT_NAMESPACES) {
    const nsp = io.of(namespace);
    const chatSockets = nsp.adapter.rooms.get(chatRoomName) ?? new Set<string>();

    for (const id of ids) {
      const roomSockets = nsp.adapter.rooms.get(userRoom(id));
      if (!roomSockets) continue;

      for (const socketId of roomSockets) {
        // Evita duplicar eventos en sockets que ya están en la sala del chat.
        if (chatSockets.has(socketId)) continue;
        nsp.to(socketId).emit(event, payload);
      }
    }
  }
};

export const emitChatMessageRealtime = (
  chatId: number,
  payload: unknown,
  userIds?: Array<number | string | null | undefined>,
  excludeUserIds?: Array<number | string | null | undefined>
) => {
  console.log(`[realtime-direct] chat message chatId=${chatId}`);
  const roomEvent = `room/chat/${chatId}`;
  emitToChatExcludingUsers(chatId, roomEvent, payload, excludeUserIds);
  emitToUsersOutsideChat(chatId, roomEvent, payload, userIds);
};

export const emitChatStatusRealtime = (
  chatId: number,
  payload: unknown,
  userIds?: Array<number | string | null | undefined>
) => {
  console.log(`[realtime-direct] chat status chatId=${chatId}`);
  const roomEvent = `room/chat/status/${chatId}`;
  emitToChat(chatId, roomEvent, payload);
  emitToUsersOutsideChat(chatId, roomEvent, payload, userIds);
};

export const emitChatsRefreshRealtime = (userId: number) => {
  if (!Number.isFinite(userId) || userId <= 0) return;
  const now = Date.now();
  const last = chatsRefreshLastEmit.get(userId) ?? 0;
  if (now - last < chatsRefreshDebounceMs) return;
  chatsRefreshLastEmit.set(userId, now);

  console.log(`[realtime-direct] chats refresh userId=${userId}`);
  emitToUsers(`chats/${userId}`, undefined, [userId]);
  emitToUsers("chats", { userId }, [userId]);
};

export const emitNotificationRealtime = (userId: number, payload: unknown) => {
  emitToUsers(`notification/${userId}`, payload, [userId]);
  emitToUsers("notification", payload, [userId]);
};

const getRoomSizeAcrossNamespaces = (room: string): number => {
  const io = getSocketInstance();
  if (!io) return 0;

  let size = 0;
  for (const namespace of COMPAT_NAMESPACES) {
    size += io.of(namespace).adapter.rooms.get(room)?.size ?? 0;
  }
  return size;
};

export const isUserOnlineRealtime = (userId: number): boolean => {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  return getRoomSizeAcrossNamespaces(userRoom(userId)) > 0;
};

export const getChatSocketsCount = (chatId: number): number => {
  if (!Number.isFinite(chatId) || chatId <= 0) return 0;
  return getRoomSizeAcrossNamespaces(chatRoom(chatId));
};

export const getChatActiveSocketsCount = (chatId: number): number => {
  if (!Number.isFinite(chatId) || chatId <= 0) return 0;
  return getRoomSizeAcrossNamespaces(chatActiveRoom(chatId));
};

export const isUserActiveInChatRealtime = async (
  userId: number,
  chatId: number
): Promise<boolean> => {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  if (!Number.isFinite(chatId) || chatId <= 0) return false;

  const io = getSocketInstance();
  if (!io) return false;

  for (const namespace of COMPAT_NAMESPACES) {
    const sockets = await io.of(namespace).in(chatActiveRoom(chatId)).fetchSockets();
    for (const s of sockets) {
      const boundUserId = Number((s.data as any)?.userId ?? 0);
      const inUserRoom = s.rooms.has(userRoom(userId));
      if (boundUserId === userId || inUserRoom) return true;
    }
  }

  return false;
};
