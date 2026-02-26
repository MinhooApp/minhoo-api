import { Request, Response, formatResponse, repository } from "../_module/module";
import {
  emitChatsRefreshRealtime,
  emitGroupUpdatedRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { serializeGroup } from "../_shared/group_serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const normalizeJoinMode = (
  value: any
): "private" | "public_with_approval" | null => {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!mode) return null;
  if (mode === "private") return "private";
  if (mode === "public_with_approval") return "public_with_approval";
  return null;
};

const normalizeWriteMode = (
  value: any
): "all_members" | "admins_only" | null => {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!mode) return null;
  if (mode === "all_members") return "all_members";
  if (mode === "admins_only") return "admins_only";
  return null;
};

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

export const update_group = async (req: Request, res: Response) => {
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
        message: "only group admins can update group settings",
      });
    }

    const body: any = {};

    if ((req.body as any)?.name !== undefined) {
      const name = String((req.body as any)?.name ?? "")
        .trim()
        .replace(/\s+/g, " ");
      if (!name || name.length < 3 || name.length > 80) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "name must be between 3 and 80 chars",
        });
      }
      body.name = name;
    }

    if ((req.body as any)?.description !== undefined) {
      const description = String((req.body as any)?.description ?? "").trim();
      if (description.length > 280) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "description max length is 280 chars",
        });
      }
      body.description = description || null;
    }

    if (
      (req.body as any)?.avatar_url !== undefined ||
      (req.body as any)?.avatarUrl !== undefined
    ) {
      const avatarRaw = String(
        (req.body as any)?.avatar_url ?? (req.body as any)?.avatarUrl ?? ""
      ).trim();
      if (!avatarRaw) {
        body.avatarUrl = null;
      } else {
        if (!isHttpUrl(avatarRaw)) {
          return formatResponse({
            res,
            success: false,
            code: 400,
            message: "avatar_url must be a valid http(s) url",
          });
        }
        body.avatarUrl = avatarRaw;
      }
    }

    if (
      (req.body as any)?.join_mode !== undefined ||
      (req.body as any)?.joinMode !== undefined
    ) {
      const joinMode = normalizeJoinMode(
        (req.body as any)?.join_mode ?? (req.body as any)?.joinMode
      );
      if (!joinMode) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "join_mode must be private or public_with_approval",
        });
      }
      body.joinMode = joinMode;
    }

    if (
      (req.body as any)?.write_mode !== undefined ||
      (req.body as any)?.writeMode !== undefined
    ) {
      const writeMode = normalizeWriteMode(
        (req.body as any)?.write_mode ?? (req.body as any)?.writeMode
      );
      if (!writeMode) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "write_mode must be all_members or admins_only",
        });
      }
      body.writeMode = writeMode;
    }

    if (Object.keys(body).length === 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message:
          "at least one field is required: name, description, avatar_url, join_mode, write_mode",
      });
    }

    setNoCacheHeaders(res);

    const updated = await repository.updateGroupSettingsTransactional({
      groupId,
      payload: body,
    });

    if (!updated || !updated.group) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found",
      });
    }

    const serializedGroup = serializeGroup(updated.group);
    const chatId =
      toPositiveInt((updated as any)?.chatId) ??
      toPositiveInt((serializedGroup as any)?.chatId) ??
      toPositiveInt((serializedGroup as any)?.chat_id);

    const updatedAtDate = new Date(
      (updated as any)?.updatedAt ?? (serializedGroup as any)?.updatedAt ?? new Date()
    );
    const updatedAt = Number.isFinite(updatedAtDate.getTime())
      ? updatedAtDate.toISOString()
      : new Date().toISOString();
    const version = Number.isFinite(updatedAtDate.getTime())
      ? updatedAtDate.getTime()
      : Date.now();

    const groupPayload = {
      ...serializedGroup,
      id: toPositiveInt((serializedGroup as any)?.id) ?? groupId,
      groupId,
      chatId: chatId ?? null,
      chat_id: chatId ?? null,
      name: String((serializedGroup as any)?.name ?? "").trim() || null,
      description:
        (serializedGroup as any)?.description !== undefined
          ? (serializedGroup as any)?.description
          : null,
      avatarUrl:
        String(
          (serializedGroup as any)?.avatarUrl ??
            (serializedGroup as any)?.avatar_url ??
            ""
        ).trim() || null,
      avatar_url:
        String(
          (serializedGroup as any)?.avatarUrl ??
            (serializedGroup as any)?.avatar_url ??
            ""
        ).trim() || null,
      updatedAt,
      version,
    };

    const eventPayload = {
      type: "group_updated" as const,
      groupId,
      chatId: chatId ?? null,
      name: groupPayload.name,
      description: groupPayload.description,
      avatarUrl: groupPayload.avatarUrl,
      joinMode:
        (groupPayload as any)?.joinMode !== undefined
          ? (groupPayload as any)?.joinMode
          : null,
      writeMode:
        (groupPayload as any)?.writeMode !== undefined
          ? (groupPayload as any)?.writeMode
          : null,
      updatedAt,
      version,
    };

    emitGroupUpdatedRealtime(chatId ?? null, eventPayload, (updated as any).memberUserIds);

    const memberUserIds = Array.isArray((updated as any).memberUserIds)
      ? (updated as any).memberUserIds
      : [];
    for (const memberIdRaw of memberUserIds) {
      const memberId = toPositiveInt(memberIdRaw);
      if (memberId) emitChatsRefreshRealtime(memberId);
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group: groupPayload,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
