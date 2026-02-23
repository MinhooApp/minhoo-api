import { Request, Response, formatResponse, repository } from "../_module/module";
import { serializeJoinRequests } from "./serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const normalizeStatus = (value: any): "pending" | "approved" | "rejected" | null => {
  const raw = String(value ?? "pending").trim().toLowerCase();
  if (raw === "pending" || raw === "approved" || raw === "rejected") return raw;
  return null;
};

export const list_group_join_requests = async (req: Request, res: Response) => {
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
    if (!groupId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId must be a valid number",
      });
    }

    const isAdmin = await repository.isActorAdminInGroup(groupId, actorUserId);
    if (!isAdmin) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "only group admins can view join requests",
      });
    }

    const status = normalizeStatus((req.query as any)?.status);
    if (!status) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "status must be pending, approved or rejected",
      });
    }

    const requests = await repository.getJoinRequestsByGroup(groupId, status);
    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        status,
        requests: serializeJoinRequests(requests as any[]),
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
