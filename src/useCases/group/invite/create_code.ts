import { Request, Response, formatResponse, repository } from "../_module/module";

const DEFAULT_EXPIRES_HOURS = 72;
const MAX_EXPIRES_HOURS = 24 * 30;
const DEFAULT_MAX_USES = 100;
const MAX_MAX_USES = 1000;

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const normalizeExpiresAt = (rawHours: any): Date => {
  const parsed = Number(rawHours);
  const safe = Number.isFinite(parsed)
    ? Math.max(1, Math.min(Math.trunc(parsed), MAX_EXPIRES_HOURS))
    : DEFAULT_EXPIRES_HOURS;
  return new Date(Date.now() + safe * 60 * 60 * 1000);
};

const normalizeMaxUses = (raw: any): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_USES;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_MAX_USES));
};

const buildShareUrl = (code: string) => {
  const base = String(process.env.GROUP_SHARE_BASE_URL ?? "https://minhoo.xyz").trim();
  const normalizedBase = base.replace(/\/+$/, "");
  return `${normalizedBase}/join/${encodeURIComponent(code)}`;
};

export const create_group_invite_code = async (req: Request, res: Response) => {
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

    const group = await repository.getOwnedActiveGroup(ownerUserId, groupId);
    if (!group) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "group not found or you are not the owner",
      });
    }

    const invite = await repository.createInviteCode({
      groupId,
      createdByUserId: ownerUserId,
      expiresAt: normalizeExpiresAt(
        (req.body as any)?.expires_in_hours ?? (req.body as any)?.expiresInHours
      ),
      maxUses: normalizeMaxUses((req.body as any)?.max_uses ?? (req.body as any)?.maxUses),
    });

    const code = String((invite as any).code ?? "");
    return formatResponse({
      res,
      success: true,
      body: {
        invite: {
          id: Number((invite as any).id),
          group_id: groupId,
          code,
          expires_at: (invite as any).expiresAt ?? null,
          max_uses: Number((invite as any).maxUses ?? 0),
          uses_count: Number((invite as any).usesCount ?? 0),
          is_active: Boolean((invite as any).isActive),
          share_url: buildShareUrl(code),
        },
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
