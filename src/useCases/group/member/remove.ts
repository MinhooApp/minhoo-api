import {
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
} from "../_module/module";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export const remove_group_member = async (req: Request, res: Response) => {
  try {
    const actorUserId = toPositiveInt((req as any).userId);
    if (!actorUserId) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const groupId = toPositiveInt((req.params as any)?.groupId);
    const targetUserId = toPositiveInt((req.params as any)?.userId);
    if (!groupId || !targetUserId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId and userId must be valid numbers",
      });
    }

    if (actorUserId === targetUserId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "cannot remove yourself with this endpoint",
      });
    }

    const removed = await repository.removeMemberByAdmin({
      groupId,
      actorUserId,
      targetUserId,
    });
    if (!removed.ok) {
      if (removed.reason === "forbidden") {
        return formatResponse({
          res,
          success: false,
          code: 403,
          message: "only admins can remove members",
        });
      }
      if (removed.reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }
      if (removed.reason === "target_not_member") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "target user is not a group member",
        });
      }
      if (removed.reason === "cannot_remove_owner") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "cannot remove the group owner",
        });
      }
      if (removed.reason === "admin_cannot_remove_admin") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "admin cannot remove another admin",
        });
      }
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not remove member",
      });
    }

    try {
      await sendNotification({
        userId: targetUserId,
        interactorId: actorUserId,
        type: "message",
        message: "You were removed from a group",
      });
    } catch (_err) {
      // Do not fail member removal if notification fails.
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        user_id: targetUserId,
        removed: true,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
