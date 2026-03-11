import { Request, Response } from "express";
import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { formatResponse } from "../../_response/format_response";
import { sendNotification } from "../../notification/add/add";
import * as repository from "../../../repository/reel/reel_repository";

const socket = {
  emit: (event: string, payload?: any) => {
    getInternalSocket().emit(event, payload);
  },
};

export { Request, Response, formatResponse, repository, socket, sendNotification };
