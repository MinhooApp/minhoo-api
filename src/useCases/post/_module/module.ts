import fs from "fs";
import path from "path";
import multer from "multer";
import { Request, Response } from "express";
import { uploadFile } from "../../../useCases/_utils/common";
import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { sendNotification } from "../../notification/add/add";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/post/post_repository";
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
  fs,
  path,
  multer,
  uploadFile,
  socket,
  sendNotification,
};
