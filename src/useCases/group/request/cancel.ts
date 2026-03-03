import { Request, Response, formatResponse, repository } from "../_module/module";
import { serializeJoinRequest } from "./serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export const cancel_group_join_request = async (req: Request, res: Response) => {
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

    const canceled = await repository.cancelPendingJoinRequestByUser({
      groupId,
      userId,
    });

    if (!canceled.ok) {
      if (canceled.reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }

      if (canceled.reason === "pending_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "pending join request not found",
        });
      }

      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not cancel join request",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        request: canceled.request ? serializeJoinRequest(canceled.request) : null,
        canceled: true,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

