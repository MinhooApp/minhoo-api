import { Request, Response, formatResponse, repository } from '../_module/module';

export const deleteChat = async (req: Request, res: Response) => {
    const { id } = req.params
    try {
        await repository.deleteChatByMessages(id, req.userId)
        return formatResponse({ res: res, success: true, body: true });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}