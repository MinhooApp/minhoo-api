import { io, Socket } from "socket.io-client";
import { Request, Response } from "express";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/chat/chat_repository";
import { sendNotification } from "../../notification/add/add";

const socket: Socket = io(process.env.URL_SOCKET || "");

export {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
};
