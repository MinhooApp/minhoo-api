import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { Request, Response } from "express";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/notification/notification_repository";
import * as userRepository from "../../../repository/user/user_repository";
import { sendPushToSingleUser } from "../../common/push_notification/notification";
const socket = {
  emit: (event: string, payload?: any) => {
    getInternalSocket().emit(event, payload);
  },
};
export {
  Request,
  Response,
  formatResponse,
  repository,
  userRepository,
  sendPushToSingleUser,
  socket,
};
