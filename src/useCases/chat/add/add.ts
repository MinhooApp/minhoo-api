import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";

export const sendMessage = async (req: Request, res: Response) => {
  const { userId, message } = req.body;
  try {
    const response: any = await repository.initNewChat(
      req.userId,
      userId,
      message
    );
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

    return formatResponse({ res: res, success: true, body: messages });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
