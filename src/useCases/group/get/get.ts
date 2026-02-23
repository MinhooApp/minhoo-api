import { Request, Response, formatResponse, repository } from "../_module/module";
import { serializeGroups } from "../_shared/group_serializer";

export const my_groups = async (req: Request, res: Response) => {
  try {
    const ownerUserId = Number(req.userId);
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const groups = await repository.myGroups(ownerUserId);
    const activeMembersByGroupId = new Map<number, number>();
    const unreadByGroupId = new Map<number, number>();
    await Promise.all(
      (groups as any[]).map(async (group: any) => {
        const groupId = Number((group as any)?.id);
        if (!Number.isFinite(groupId) || groupId <= 0) return;
        const chatId = Number((group as any)?.chatId ?? 0);
        const [count, unread] = await Promise.all([
          repository.countActiveMembers(groupId),
          repository.countUnreadMessagesByChat(chatId, ownerUserId),
        ]);
        activeMembersByGroupId.set(groupId, Number(count) || 0);
        unreadByGroupId.set(groupId, Number(unread) || 0);
      })
    );
    const serializedGroups = serializeGroups(
      groups as any[],
      activeMembersByGroupId,
      unreadByGroupId
    );
    return formatResponse({
      res,
      success: true,
      body: {
        groups: serializedGroups,
        owner_limits: {
          max_groups: repository.MAX_GROUPS_PER_OWNER,
          used_groups: groups.length,
          remaining_groups: Math.max(0, repository.MAX_GROUPS_PER_OWNER - groups.length),
        },
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
