import { Request, Response, formatResponse, repository } from "../_module/module";
import { serializeGroup } from "../_shared/group_serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

export const group_access = async (req: Request, res: Response) => {
  try {
    const groupId = toPositiveInt((req.params as any)?.groupId);
    if (!groupId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId must be a valid number",
      });
    }

    setNoCacheHeaders(res);

    const userId = toPositiveInt((req as any)?.userId);
    const snapshot = await repository.getGroupAccessSnapshot(groupId, userId);
    if (!snapshot) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found",
      });
    }

    if (snapshot.policy.is_private && !snapshot.policy.is_member) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you cannot view this private group",
      });
    }

    const activeMembers = await repository.countActiveMembers(groupId);
    const unreadCount =
      userId && snapshot.policy.is_member
        ? await repository.countUnreadMessagesByChat(
            Number(snapshot.policy.chat_id ?? 0),
            Number(userId)
          )
        : 0;

    return formatResponse({
      res,
      success: true,
      body: {
        group: serializeGroup(snapshot.group, {
          activeMembers: Number(activeMembers) || 0,
          unreadCount: Number(unreadCount) || 0,
        }),
        access: snapshot.policy,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
