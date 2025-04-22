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

    ////////Emit the chat/////
    socket.emit("chat", response);
    socket.emit("chats", userId);
    /*await sendNotification({
      userId: userId,
      interactorId: req.userId,
      messageId: response.id,
      type: "message",
      message: `wrote you a new message`,
    });*/
    //  const messages = await repository.getChatByUser(req.userId, userId);
    return formatResponse({ res: res, success: true, body: response });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
