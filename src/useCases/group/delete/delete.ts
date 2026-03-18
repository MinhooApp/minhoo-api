import { Request, Response, formatResponse, repository } from "../_module/module";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export const delete_group = async (req: Request, res: Response) => {
  try {
    const ownerUserId = toPositiveInt((req as any).userId);
    if (!ownerUserId) {
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

    const removed = await repository.deactivateOwnedGroupAndRelations(ownerUserId, groupId);
    if (!removed) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found or you are not the owner",
      });
    }

    const activeGroups = await repository.countActiveByOwner(ownerUserId);
    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        deleted: true,
        owner_limits: {
          max_groups: repository.MAX_GROUPS_PER_OWNER,
          used_groups: activeGroups,
          remaining_groups: Math.max(0, repository.MAX_GROUPS_PER_OWNER - activeGroups),
        },
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
