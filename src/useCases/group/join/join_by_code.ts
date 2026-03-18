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

export const join_group_by_code = async (req: Request, res: Response) => {
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

    const code = String((req.params as any)?.code ?? "").trim();
    if (!code) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "invite code is required",
      });
    }

    const invite = await repository.getActiveInviteByCode(code);
    if (!invite) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "invite code not found",
      });
    }

    const now = Date.now();
    const expiresAt = (invite as any).expiresAt ? new Date((invite as any).expiresAt).getTime() : 0;
    if (expiresAt > 0 && expiresAt <= now) {
      await repository.disableInvite(Number((invite as any).id));
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "invite code expired",
      });
    }

    const maxUses = Number((invite as any).maxUses ?? 0);
    const usesCount = Number((invite as any).usesCount ?? 0);
    if (maxUses > 0 && usesCount >= maxUses) {
      await repository.disableInvite(Number((invite as any).id));
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "invite code reached max uses",
      });
    }

    const groupId = Number((invite as any).groupId);
    const group = await repository.getActiveGroupById(groupId);
    if (!group) {
      await repository.disableInvite(Number((invite as any).id));
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

    const joinMode = String((group as any).joinMode ?? "public_with_approval");
    const groupPreview = toGroupJoinPreview(group);
    const pending = await repository.getPendingJoinRequestByUser(groupId, userId);
    if (pending) {
      return formatResponse({
        res,
        success: true,
        body: {
          requested: false,
          already_member: false,
          already_pending: true,
          requires_admin_approval: true,
          join_mode: joinMode,
          request_id: Number((pending as any).id),
          group: groupPreview,
        },
      });
    }

    const created = await repository.createOrRefreshJoinRequest(
      groupId,
      userId,
      Number((invite as any).id),
      "join by code request"
    );
    const request = created.request;

    if (!created.alreadyPending) {
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
    }

    return formatResponse({
      res,
      success: true,
      body: {
        requested: true,
        already_member: false,
        already_pending: created.alreadyPending,
        requires_admin_approval: true,
        join_mode: joinMode,
        request_id: Number((request as any).id),
        group: groupPreview,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
