import { Request, Response, formatResponse, repository } from '../_module/module';


export const sendMessage = async (req: Request, res: Response) => {
    const { userId, message } = req.body;
    try {
        const response = await repository.initNewChat(req.userId, userId, message);
        return formatResponse({ res: res, success: true, body: response });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}