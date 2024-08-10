import { io } from "socket.io-client";
import { Request, Response } from "express";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/notification/notification_repository";
import * as userRepository from "../../../repository/user/user_repository";
import { sendPushToSingleUser } from "../../common/push_notification/notification";
const socket = io(process.env.URL_SOCKET || "");
export {
  Request,
  Response,
  formatResponse,
  repository,
  userRepository,
  sendPushToSingleUser,
  socket,
};
