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
    const newMessage: any = response.messages[response.messages.length - 1];
    ////////Emit the chat/////
    socket.emit("chat", newMessage);
    await sendNotification({
      userId: userId,
      interactorId: req.userId,
      messageId: newMessage.chatId,

      type: "message",
      message: `wrote you a new message`,
    });
    return formatResponse({ res: res, success: true, body: response });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
