import { io, Socket } from "socket.io-client";

let internalSocket: Socket | null = null;
let internalSocketUrl = "";

const resolveInternalSocketUrl = (): string => {
  const explicit = String(process.env.INTERNAL_SOCKET_URL ?? "").trim();
  if (explicit) return explicit;

  const port = String(process.env.PORT ?? "3000").trim() || "3000";
  return `http://127.0.0.1:${port}`;
};

const buildSocket = (url: string): Socket => {
  const socket = io(url, {
    transports: ["websocket", "polling"],
    upgrade: true,
    rememberUpgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 20000,
    autoConnect: true,
  });

  socket.on("connect_error", (error) => {
    console.log(`[internal-socket] connect_error ${url}: ${error.message}`);
  });

  return socket;
};

export const getInternalSocket = (): Socket => {
  const url = resolveInternalSocketUrl();

  if (!internalSocket || internalSocketUrl !== url) {
    if (internalSocket) {
      internalSocket.removeAllListeners();
      internalSocket.disconnect();
    }
    internalSocket = buildSocket(url);
    internalSocketUrl = url;
  }

  if (!internalSocket.connected) {
    internalSocket.connect();
  }

  return internalSocket;
};
