import {
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
} from "../_module/module";
import { serializeJoinRequest } from "./serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const normalizeDecision = (value: any): "approved" | "rejected" | null => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "approved" || raw === "approve" || raw === "accepted") return "approved";
  if (raw === "rejected" || raw === "reject" || raw === "declined") return "rejected";
  return null;
};

export const review_group_join_request = async (req: Request, res: Response) => {
  try {
    const reviewerUserId = toPositiveInt((req as any).userId);
    if (!reviewerUserId) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const groupId = toPositiveInt((req.params as any)?.groupId);
    const requestId = toPositiveInt((req.params as any)?.requestId);
    if (!groupId || !requestId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId and requestId must be valid numbers",
      });
    }

    const isAdmin = await repository.isActorAdminInGroup(groupId, reviewerUserId);
    if (!isAdmin) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "only group admins can review requests",
      });
    }

    const decision = normalizeDecision(
      (req.body as any)?.decision ?? (req.body as any)?.status ?? (req.body as any)?.action
    );
    if (!decision) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "decision must be approved or rejected",
      });
    }

    const noteRaw = String((req.body as any)?.note ?? "").trim();
    if (noteRaw.length > 280) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "note max length is 280 chars",
      });
    }

    const reviewed = await repository.reviewJoinRequest({
      groupId,
      requestId,
      reviewerUserId,
      approve: decision === "approved",
      note: noteRaw || null,
    });

    if (!reviewed.ok) {
      const reason = reviewed.reason;
      if (reason === "request_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "join request not found",
        });
      }
      if (reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }
      if (reason === "group_full") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "group reached max members",
        });
      }
      if (reason === "request_already_reviewed") {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "join request already reviewed",
        });
      }
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not review join request",
      });
    }

    const request = await repository.getJoinRequestById(groupId, requestId);
    const requesterId = Number((request as any)?.userId ?? 0);
    if (requesterId > 0) {
      try {
        await sendNotification({
          userId: requesterId,
          interactorId: reviewerUserId,
          type: "message",
          message:
            decision === "approved"
              ? "Your group join request was approved"
              : "Your group join request was rejected",
        });
      } catch (_err) {
        // Do not fail request review if notification fails.
      }
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        request: request ? serializeJoinRequest(request) : null,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
