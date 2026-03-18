import { Request, Response, formatResponse, repository } from "../_module/module";
import { serializeGroups } from "../_shared/group_serializer";
import { createHash } from "crypto";

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

const buildWeakEtag = (payload: any) => {
  const hash = createHash("sha1").update(JSON.stringify(payload ?? {})).digest("hex");
  return `W/"${hash}"`;
};

const isEtagFresh = (req: Request, etag: string): boolean => {
  const raw = String(req.headers["if-none-match"] ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const tags = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tags.includes(etag);
};

export const my_groups = async (req: Request, res: Response) => {
  try {
    const userId = Number(req.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    setNoCacheHeaders(res);

    const [groups, ownedGroupsCount] = await Promise.all([
      repository.myGroupsByUser(userId),
      repository.countActiveByOwner(userId),
    ]);
    const activeMembersByGroupId = new Map<number, number>();
    const unreadByGroupId = new Map<number, number>();
    await Promise.all(
      (groups as any[]).map(async (group: any) => {
        const groupId = Number((group as any)?.id);
        if (!Number.isFinite(groupId) || groupId <= 0) return;
        const chatId = Number((group as any)?.chatId ?? 0);
        const membershipStatus = String(
          (typeof (group as any)?.getDataValue === "function"
            ? (group as any).getDataValue("membershipStatus") ??
              (group as any).getDataValue("membership_status")
            : undefined) ??
            (group as any)?.membershipStatus ??
            (group as any)?.membership_status ??
            "member"
        )
          .trim()
          .toLowerCase();
        const isPending = membershipStatus === "pending";
        const [count, unread] = await Promise.all([
          repository.countActiveMembers(groupId),
          isPending
            ? Promise.resolve(0)
            : repository.countUnreadMessagesByChat(chatId, userId),
        ]);
        activeMembersByGroupId.set(groupId, Number(count) || 0);
        unreadByGroupId.set(groupId, Number(unread) || 0);
      })
    );
    const serializedGroups = serializeGroups(
      groups as any[],
      activeMembersByGroupId,
      unreadByGroupId
    );

    const body = {
      groups: serializedGroups,
      owner_limits: {
        max_groups: repository.MAX_GROUPS_PER_OWNER,
        used_groups: Number(ownedGroupsCount) || 0,
        remaining_groups: Math.max(
          0,
          repository.MAX_GROUPS_PER_OWNER - (Number(ownedGroupsCount) || 0)
        ),
      },
    };
    const etag = buildWeakEtag(body);
    res.set("ETag", etag);
    if (isEtagFresh(req, etag)) {
      res.status(304).end();
      return;
    }

    return formatResponse({
      res,
      success: true,
      body,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
