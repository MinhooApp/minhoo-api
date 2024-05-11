import { Request, Response, formatResponse, repository, socket } from '../_module/module';


export const sendMessage = async (req: Request, res: Response) => {
    const { userId, message } = req.body;
    try {
        const response: any = await repository.initNewChat(req.userId, userId, message);
        const newMessage = response.messages[response.messages.length - 1];
        ////////Emit the chat/////
        socket.emit('chat', newMessage);
        return formatResponse({ res: res, success: true, body: response });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}