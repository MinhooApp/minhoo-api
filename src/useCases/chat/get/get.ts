import { Request, Response, formatResponse, repository, } from '../_module/module';
export const myChats = async (req: Request, res: Response) => {

    try {
        const chats = await repository.getUserChats(req.userId);
        return formatResponse({ res: res, success: true, body: { chats } });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}

export const messages = async (req: Request, res: Response) => {
    const { id } = req.params
    try {
        const messages = await repository.getChatByUser(req.userId, id);
        const payload = {
            chatId: messages.length > 0 ? messages[0].chatId : null,
            messages
        }
        return formatResponse({ res: res, success: true, body: payload });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}