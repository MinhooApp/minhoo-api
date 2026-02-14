import { io } from "socket.io-client";
import { Request, Response } from "express";
import { sendEmail } from "../../_utils/send_email";
import Offer from "../../../_models/offer/offer";
import { sendNotification } from "../../notification/add/add";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/offer/offer_repository";
import * as userRepository from "../../../repository/user/user_repository";
import * as serviceRepository from "../../../repository/service/service_repository";
const socket = io(process.env.URL_SOCKET || "");
export {
  Request,
  Response,
  formatResponse,
  repository,
  userRepository,
  serviceRepository,
  socket,
  Offer,
  sendNotification,
  sendEmail,
};
