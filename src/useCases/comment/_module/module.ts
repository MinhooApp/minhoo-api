import fs from "fs";
import path from "path";
import multer from "multer";
import { Request, Response } from "express";
import { uploadFile } from "../../../useCases/_utils/common";
import { getInternalSocket } from "../../../libs/helper/internal_socket";
import { sendNotification } from "../../notification/add/add";
import { formatResponse } from "../../_response/format_response";
import * as repository from "../../../repository/comment/coment_repository";
import * as postRepository from "../../../repository/post/post_repository";
import * as groupRepository from "../../../repository/group/group_repository";
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
  groupRepository,
  fs,
  path,
  multer,
  uploadFile,
  socket,
  sendNotification,
};
