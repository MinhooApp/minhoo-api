import * as repository from "../../../repository/user/user_repository";
import * as followerRepo from "../../../repository/follower/follower_repository";
import * as chatRepository from "../../../repository/chat/chat_repository";
import {
  emitChatsRefreshRealtime,
  emitUserUpdatedRealtime,
} from "../../../libs/helper/realtime_dispatch";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toNonNegativeInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

const toText = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};

const toUserIds = (values?: Array<number | string | null | undefined>) => {
  return [...new Set((values ?? []).map(toPositiveInt).filter(Boolean) as number[])];
};

const normalizeCounts = (counts: any) => {
  const followersCount =
    toNonNegativeInt(counts?.followersCount ?? counts?.followers_count) ?? 0;
  const followingCount =
    toNonNegativeInt(
      counts?.followingCount ?? counts?.followingsCount ?? counts?.followings_count
    ) ?? 0;

  return { followersCount, followingCount };
};

export const buildUserUpdatedRealtimePayload = (
  user: any,
  fallbackUserId: number,
  counts?: any
) => {
  const safeUser = user ?? {};
  const resolvedUserId =
    toPositiveInt((safeUser as any)?.id) ?? toPositiveInt(fallbackUserId) ?? 0;
  const avatarUrl =
    toText((safeUser as any)?.image_profil) ??
    toText((safeUser as any)?.avatarUrl) ??
    toText((safeUser as any)?.avatar_url);
  const normalizedCounts = normalizeCounts(counts ?? safeUser);

  return {
    type: "user_updated" as const,
    userId: resolvedUserId,
    name: toText((safeUser as any)?.name),
    lastName: toText((safeUser as any)?.last_name),
    last_name: toText((safeUser as any)?.last_name),
    username: toText((safeUser as any)?.username),
    avatarUrl,
    avatar_url: avatarUrl,
    image_profil: avatarUrl,
    followersCount: normalizedCounts.followersCount,
    followers_count: normalizedCounts.followersCount,
    followingCount: normalizedCounts.followingCount,
    following_count: normalizedCounts.followingCount,
    followingsCount: normalizedCounts.followingCount,
    followings_count: normalizedCounts.followingCount,
    updatedAt: new Date().toISOString(),
  };
};

type EmitProfileUpdatedRealtimeOptions = {
  user?: any;
  userId: any;
  counts?: any;
  targetUserIds?: Array<number | string | null | undefined>;
  includeRelatedUsers?: boolean;
  emitChatsRefresh?: boolean;
  action?: string | null;
};

export const emitProfileUpdatedRealtime = async ({
  user,
  userId,
  counts,
  targetUserIds,
  includeRelatedUsers = false,
  emitChatsRefresh = false,
  action = null,
}: EmitProfileUpdatedRealtimeOptions) => {
  const resolvedUserId = toPositiveInt(userId);
  if (!resolvedUserId) return null;

  let recipientIds = toUserIds(targetUserIds);
  if (includeRelatedUsers) {
    try {
      const relatedUserIds = await chatRepository.getRelatedUserIdsByUser(resolvedUserId, {
        includeSelf: true,
      });
      recipientIds = toUserIds([...recipientIds, ...relatedUserIds]);
    } catch (error) {
      console.error("[profile-realtime] failed to load related users", error);
    }
  }

  if (recipientIds.length === 0) {
    recipientIds = [resolvedUserId];
  }

  try {
    const [resolvedUser, resolvedCounts] = await Promise.all([
      user ?? repository.get(resolvedUserId),
      counts ?? followerRepo.getCounts(resolvedUserId),
    ]);
    const basePayload = buildUserUpdatedRealtimePayload(
      resolvedUser,
      resolvedUserId,
      resolvedCounts
    );
    const payload = action ? { ...basePayload, action } : basePayload;

    emitUserUpdatedRealtime(payload, recipientIds);
    if (emitChatsRefresh) {
      for (const recipientId of recipientIds) {
        emitChatsRefreshRealtime(recipientId);
      }
    }

    return payload;
  } catch (error) {
    console.error("[profile-realtime] failed to emit user update", error);
    return null;
  }
};
