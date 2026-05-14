import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import * as savedRepository from "../../../repository/saved/saved_repository";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";
import { emitPostDeletedRealtime } from "../../../libs/helper/realtime_dispatch";

const toPositiveIntOrNull = (value: any): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const broadcastPostDeletedRealtime = (params: {
  postRaw?: any;
  postIdRaw?: any;
  ownerIdRaw?: any;
  actorUserIdRaw?: any;
}) => {
  const postSource = params.postRaw ?? {};
  const postId = toPositiveIntOrNull(postSource?.id ?? params.postIdRaw);
  if (!postId) return;

  const ownerId = toPositiveIntOrNull(
    postSource?.userId ?? postSource?.user_id ?? postSource?.user?.id ?? params.ownerIdRaw
  );
  const actorUserId = toPositiveIntOrNull(params.actorUserIdRaw);
  const deletedAt = new Date().toISOString();

  emitPostDeletedRealtime({
    action: "deleted",
    postId,
    post_id: postId,
    ownerId,
    owner_id: ownerId,
    actorUserId,
    actor_user_id: actorUserId,
    removed: true,
    deleted: true,
    deletedAt,
    deleted_at: deletedAt,
    updatedAt: deletedAt,
    updated_at: deletedAt,
    post: {
      ...(typeof postSource?.toJSON === "function"
        ? postSource.toJSON()
        : postSource ?? {}),
      id: postId,
      userId: ownerId,
      user_id: ownerId,
      is_delete: true,
      isDeleted: true,
      deleted: true,
      removed: true,
    },
  });
};

export const deletePost = async (req: Request, res: Response) => {
  const { id } = req.params;
  const tempService = await repository.getOneByUser(id, req.userId);
  if (!tempService) {
    return formatResponse({
      res: res,
      success: false,
      message: "Post not found",
    });
  }
  await repository.deletePost(id);
  await savedRepository.removeByPostId(Number(id));
  await bumpHomeContentSectionVersion("posts");
  broadcastPostDeletedRealtime({
    postRaw: tempService,
    postIdRaw: id,
    ownerIdRaw: req.userId,
    actorUserIdRaw: req.userId,
  });

  return formatResponse({
    res: res,
    success: true,
    message: "Post deleted successfully",
  });
};

export const deletePostAdmin = async (req: Request, res: Response) => {
  const { id } = req.params;
  const tempService = await repository.get(id);
  if (!tempService) {
    return formatResponse({
      res: res,
      success: false,
      message: "Post not found",
    });
  }
  await repository.deletePost(id);
  await savedRepository.removeByPostId(Number(id));
  await bumpHomeContentSectionVersion("posts");
  broadcastPostDeletedRealtime({
    postRaw: tempService,
    postIdRaw: id,
    ownerIdRaw: (tempService as any)?.userId ?? (tempService as any)?.user_id,
    actorUserIdRaw: req.userId,
  });

  return formatResponse({
    res: res,
    success: true,
    message: "Post deleted successfully",
  });
};
