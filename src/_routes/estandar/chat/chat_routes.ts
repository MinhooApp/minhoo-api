import Router from "express";
import {
  myChats,
  starredChats,
  sendMessage,
  deleteChat,
  deleteMessage,
  messages,
  getUserByMessage,
  pinChat,
  starChat,
  report,
} from "../../../useCases/chat/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();

router.get("/", TokenValidation(), myChats);
router.get("/starred", TokenValidation(), starredChats);
router.get("/user/message/:messageId", TokenValidation(), getUserByMessage);
router.get("/message/:id", TokenValidation(), messages);
router.delete("/message/:messageId", TokenValidation(), deleteMessage);
router.post("/", TokenValidation(), sendMessage);
router.post("/:id/report", TokenValidation(), report);
router.put("/:id/report", TokenValidation(), report);
router.patch("/:id/report", TokenValidation(), report);
router.post("/report/:id", TokenValidation(), report);
router.put("/report/:id", TokenValidation(), report);
router.patch("/report/:id", TokenValidation(), report);
router.patch("/:id/pin", TokenValidation(), pinChat);
router.patch("/:id/starred", TokenValidation(), starChat);
router.delete("/:id", TokenValidation(), deleteChat);

export default router;
