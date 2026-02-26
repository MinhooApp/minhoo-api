import {
    Request,
    Response,
    formatResponse,
    repository,
    postRepository,
    groupRepository,
} from '../_module/module';

const toPositiveInt = (value: any): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const safe = Math.trunc(parsed);
    if (safe <= 0) return null;
    return safe;
};

export const deleteComment = async (req: Request, res: Response) => {
    const commentId = toPositiveInt((req.params as any)?.id);
    const actorUserId = toPositiveInt((req as any)?.userId);
    try {
        if (!commentId) {
            return formatResponse({
                res,
                success: false,
                code: 400,
                message: "comment id is invalid",
            });
        }

        if (!actorUserId) {
            return formatResponse({
                res,
                success: false,
                code: 401,
                message: "user not authenticated",
            });
        }

        const comment = await repository.get(commentId);
        if (!comment) {
            return formatResponse({
                res,
                success: false,
                code: 404,
                message: "comment not found",
            });
        }

        const isCommentOwner = Number((comment as any)?.userId) === actorUserId;

        const groupId =
            toPositiveInt((req.params as any)?.groupId) ??
            toPositiveInt((req.query as any)?.groupId) ??
            toPositiveInt((req.body as any)?.groupId);

        let isGroupAdmin = false;
        if (!isCommentOwner && groupId) {
            isGroupAdmin = await groupRepository.isActorAdminInGroup(groupId, actorUserId);
        }

        if (!isCommentOwner && !isGroupAdmin) {
            return formatResponse({
                res,
                success: false,
                code: 403,
                message: "only comment owner or group admin can delete this comment",
            });
        }

        await repository.deletecomment(commentId);
        const post = await postRepository.get((comment as any).postId, actorUserId);
        return formatResponse({ res, success: true, body: { post } });
    } catch (error) {
        return formatResponse({ res, success: false, message: error });
    }
}
