import { Request, Response, formatResponse, repository, followerRepo } from '../_module/module';

export const follow = async (req: Request, res: Response) => {
    const { userId } = req.body

    try {
        const response = await followerRepo.toggleFollow(userId, req.userId);
        return formatResponse({ res: res, success: true, body: { "following": response } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}