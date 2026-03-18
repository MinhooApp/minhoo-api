import { Request, Response, formatResponse, repository } from "../_module/module";

const DEFAULT_MAX_MEMBERS = 256;
const MIN_MAX_MEMBERS = 2;
const HARD_MAX_MEMBERS = 1024;

const normalizeJoinMode = (value: any): "private" | "public_with_approval" => {
  const mode = String(value ?? "public_with_approval").trim().toLowerCase();
  return mode === "private" ? "private" : "public_with_approval";
};

const normalizeWriteMode = (value: any): "all_members" | "admins_only" => {
  const mode = String(value ?? "all_members").trim().toLowerCase();
  return mode === "admins_only" ? "admins_only" : "all_members";
};

const normalizeMaxMembers = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_MEMBERS;
  const safe = Math.trunc(parsed);
  if (safe < MIN_MAX_MEMBERS) return MIN_MAX_MEMBERS;
  if (safe > HARD_MAX_MEMBERS) return HARD_MAX_MEMBERS;
  return safe;
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

export const create_group = async (req: Request, res: Response) => {
  try {
    const ownerUserId = Number(req.userId);
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const existing = await repository.countActiveByOwner(ownerUserId);
    if (existing >= repository.MAX_GROUPS_PER_OWNER) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `Has alcanzado el máximo de ${repository.MAX_GROUPS_PER_OWNER} grupos`,
      });
    }

    const name = String(req.body?.name ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!name || name.length < 3 || name.length > 80) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "name is required (3-80 chars)",
      });
    }

    const descriptionRaw = String(req.body?.description ?? "").trim();
    if (descriptionRaw.length > 280) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "description max length is 280 chars",
      });
    }

    const avatarUrlRaw = String(req.body?.avatar_url ?? req.body?.avatarUrl ?? "").trim();
    if (avatarUrlRaw && !isHttpUrl(avatarUrlRaw)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "avatar_url must be a valid http(s) url",
      });
    }

    const owner = await repository.getOwnerUser(ownerUserId);
    if (!owner || (owner as any)?.is_deleted || (owner as any)?.available === false) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "owner user not found",
      });
    }

    const created = await repository.createGroup({
      ownerUserId,
      name,
      description: descriptionRaw || null,
      avatarUrl: avatarUrlRaw || null,
      maxMembers: normalizeMaxMembers(req.body?.max_members ?? req.body?.maxMembers),
      joinMode: normalizeJoinMode(req.body?.join_mode ?? req.body?.joinMode),
      writeMode: normalizeWriteMode(req.body?.write_mode ?? req.body?.writeMode),
    });

    if (!created) {
      return formatResponse({
        res,
        success: false,
        message: "could not create group",
      });
    }

    await repository.ensureOwnerMember(Number((created as any).id), ownerUserId);
    const hydratedGroup =
      (await repository.getActiveGroupById(Number((created as any).id))) ?? created;

    const activeGroups = await repository.countActiveByOwner(ownerUserId);

    return formatResponse({
      res,
      success: true,
      code: 201,
      body: {
        group: hydratedGroup,
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
