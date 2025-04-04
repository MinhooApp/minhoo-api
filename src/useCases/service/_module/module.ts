import axios from "axios";
import { io } from "socket.io-client";
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
const socket = io(process.env.URL_SOCKET || "");

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
