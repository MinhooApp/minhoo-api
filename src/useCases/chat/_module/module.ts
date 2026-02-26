import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { Request, Response } from "express";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/chat/chat_repository";
import * as groupRepository from "../../../repository/group/group_repository";
import { sendNotification } from "../../notification/add/add";

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
  groupRepository,
  socket,
  sendNotification,
};
