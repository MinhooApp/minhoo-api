import { Request, Response, formatResponse, repository, postRepository } from '../_module/module';

export const deleteComment = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const comment = await repository.get(id);
        if (!comment || (comment.userId != req.userId)) {
            return formatResponse({ res: res, success: false, message: "Comment no found" });
        }

        var body = { is_delete: true }
        await repository.deletecomment(id);
        const post = await postRepository.get(comment.postId);
        return formatResponse({ res: res, success: true, body: { post } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}