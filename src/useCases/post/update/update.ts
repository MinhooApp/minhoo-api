import { Request, Response, formatResponse, repository } from '../_module/module';


export const like = async (req: Request, res: Response) => {

    try {
        const { id } = req.params;
        await repository.toggleLike(req.userId, id);
        const post = await repository.get(id);

        return formatResponse({ res: res, success: true, body: { post: post } });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}