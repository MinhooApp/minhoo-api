import { Request, Response, formatResponse, repository } from "../_module/module";

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

    const group = await repository.getActiveGroupById(groupId);
    if (!group) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found",
      });
    }

    await (group as any).update(body);

    return formatResponse({
      res,
      success: true,
      body: {
        group,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
