import { Server as SocketIOServer } from "socket.io";

let ioInstance: SocketIOServer | null = null;

export const setSocketInstance = (io: SocketIOServer) => {
  ioInstance = io;
};

export const getSocketInstance = (): SocketIOServer | null => ioInstance;

