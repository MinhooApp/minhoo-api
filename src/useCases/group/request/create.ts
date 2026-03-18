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

const toGroupJoinPreview = (group: any) => {
  if (!group) return null;
  const data = typeof group.toJSON === "function" ? group.toJSON() : group;
  return {
    id: Number((data as any)?.id),
    ownerUserId: Number((data as any)?.ownerUserId),
    ownerUsername: (data as any)?.ownerUsername ?? null,
    name: (data as any)?.name ?? null,
    description: (data as any)?.description ?? null,
    avatarUrl: (data as any)?.avatarUrl ?? null,
    maxMembers: Number((data as any)?.maxMembers ?? 0),
    joinMode: (data as any)?.joinMode ?? null,
    writeMode: (data as any)?.writeMode ?? null,
    isActive: Boolean((data as any)?.isActive),
  };
};

export const create_group_join_request = async (req: Request, res: Response) => {
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

    const group = await repository.getActiveGroupById(groupId);
    if (!group) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found",
      });
    }

    const alreadyMember = await repository.getActiveMembership(groupId, userId);
    if (alreadyMember) {
      return formatResponse({
        res,
        success: true,
        body: {
          requested: false,
          already_member: true,
          group,
        },
      });
    }

    const pending = await repository.getPendingJoinRequestByUser(groupId, userId);
    const groupPreview = toGroupJoinPreview(group);
    if (pending) {
      return formatResponse({
        res,
        success: true,
        body: {
          requested: false,
          already_member: false,
          already_pending: true,
          requires_admin_approval: true,
          request_id: Number((pending as any).id),
          group: groupPreview,
        },
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

    const created = await repository.createOrRefreshJoinRequest(
      groupId,
      userId,
      null,
      noteRaw || "direct join request"
    );
    const request = created.request;

    try {
      const adminIds = await repository.getGroupAdminUserIds(groupId);
      for (const adminId of adminIds) {
        if (adminId === userId) continue;
        await sendNotification({
          userId: adminId,
          interactorId: userId,
          type: "message",
          message: "New group join request pending approval",
        });
      }
    } catch (_err) {
      // Do not fail join request if notification dispatch fails.
    }

    return formatResponse({
      res,
      success: true,
      body: {
        requested: true,
        already_member: false,
        already_pending: false,
        requires_admin_approval: true,
        request_id: Number((request as any).id),
        group: groupPreview,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
