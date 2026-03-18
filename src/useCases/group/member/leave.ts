import { Request, Response, formatResponse, repository } from "../_module/module";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export const leave_group = async (req: Request, res: Response) => {
  try {
    const userId = toPositiveInt((req as any).userId);
    if (!userId) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const groupId = toPositiveInt((req.params as any)?.groupId);
    if (!groupId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId must be a valid number",
      });
    }

    const left = await repository.leaveGroupByUser({
      groupId,
      userId,
    });

    if (!left.ok) {
      if (left.reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }

      if (left.reason === "owner_cannot_leave") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "group owner cannot leave; transfer ownership or delete group",
        });
      }

      if (left.reason === "not_member") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "user is not an active member of this group",
        });
      }

      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not leave group",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        user_id: userId,
        left: true,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

