import Router from "express";
import {
  myChats,
  sendMessage,
  deleteChat,
  messages,
  getUserByMessage,
  pinChat,
} from "../../../useCases/chat/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();

router.get("/", TokenValidation(), myChats);
router.get("/user/message/:id", getUserByMessage);
router.get("/message/:id", TokenValidation(), messages);
router.post("/", TokenValidation(), sendMessage);
router.patch("/:id/pin", TokenValidation(), pinChat);
router.delete("/:id", TokenValidation(), deleteChat);

export default router;
