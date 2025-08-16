import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";
//
export const sendMessage = async (req: Request, res: Response) => {
  const { userId, message } = req.body;
  try {
    const flag = await repository.validateBlock(req.userId, userId);

    if (flag) {
      return formatResponse({
        res: res,
        success: false,
        message: "User not fount",
      });
    }
    await repository.initNewChat(req.userId, userId, message);
    const messages = await repository.getChatByUser(req.userId, userId);
    const lastMessage = messages.reduce(
      (max, msg) => (msg.id > max.id ? msg : max),
      messages[0]
    );

    ////////Emit the chat/////
    socket.emit("chat", lastMessage);
    socket.emit("chats", userId);
    await sendNotification({
      userId: userId,
      interactorId: req.userId,
      messageId: lastMessage.id,
      type: "message",
      message: `wrote you a new message`,
    });

    const payload = {
      chatId: messages.length > 0 ? messages[0].chatId : null,
      messages,
    };
    return formatResponse({ res: res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
