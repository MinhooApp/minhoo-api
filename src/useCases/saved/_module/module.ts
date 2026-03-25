import { Request, Response } from "express";
import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/saved/saved_repository";
import * as postRepository from "../../../repository/post/post_repository";
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
  postRepository,
  socket,
  sendNotification,
};
