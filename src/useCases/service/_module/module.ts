import axios from "axios";
import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { Request, Response } from "express";
import { sendEmail, sendEmailToMany } from "../../_utils/send_email";
import { sendNotification } from "../../notification/add/add";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/service/service_repository";
import * as workerRepository from "../../../repository/worker/worker_repository";
import {
  sendPushToSingleUser,
  sendPushToMultipleUsers,
} from "../../common/push_notification/notification";
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
  socket,
  axios,
  sendPushToSingleUser,
  sendPushToMultipleUsers,
  workerRepository,
  sendNotification,
  sendEmail,
  sendEmailToMany,
};
