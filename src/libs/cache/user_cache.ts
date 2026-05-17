/**
 * Redis-backed cache for user profile data and follower counts.
 *
 * Reduces DB load on the most-called endpoint (/user/one/:id):
 *   - getCounts  → 2 COUNT queries saved per profile view (TTL 30 s)
 *   - getProfile → 1 lightweight SELECT saved per profile view (TTL 30 s)
 *
 * Falls back silently to DB on any Redis error.
 * Invalidation: call invalidateUser(id) on profile update or follow/unfollow.
 */

import { createClient } from "redis";

const REDIS_URL = String(process.env.REDIS_URL ?? "redis://127.0.0.1:6379").trim();
const COUNTS_TTL_S  = Math.max(10, Number(process.env.USER_COUNTS_CACHE_TTL_S  ?? 30) || 30);
const PROFILE_TTL_S = Math.max(10, Number(process.env.USER_PROFILE_CACHE_TTL_S ?? 30) || 30);

const KEY_COUNTS  = (id: number) => `user:counts:${id}`;
const KEY_PROFILE = (id: number) => `user:profile:${id}`;

// ------------------------------------------------------------------
// Lazy singleton Redis client
// ------------------------------------------------------------------
let _client: ReturnType<typeof createClient> | null = null;
let _connecting = false;
let _disabledUntil = 0;

const getClient = async (): Promise<ReturnType<typeof createClient> | null> => {
  if (Date.now() < _disabledUntil) return null;
  if (_client?.isReady) return _client;
  if (_connecting) return null;

  _connecting = true;
  try {
    const c = createClient({ url: REDIS_URL });
    c.on("error", (err: any) => {
      console.warn("[user_cache] Redis connection error:", String(err?.message ?? err));
    });
    await c.connect();
    _client = c;
    return _client;
  } catch {
    _client = null;
    _disabledUntil = Date.now() + 30_000;
    return null;
  } finally {
    _connecting = false;
  }
};

// ------------------------------------------------------------------
// Follower counts cache
// ------------------------------------------------------------------
export type FollowerCounts = {
  followersCount: number;
  followingCount: number;
};

export const getCachedCounts = async (
  userId: number,
  fetcher: () => Promise<FollowerCounts>
): Promise<FollowerCounts> => {
  const client = await getClient();
  if (client) {
    try {
      const raw = await client.get(KEY_COUNTS(userId));
      if (raw) return JSON.parse(raw) as FollowerCounts;
    } catch { /* fall through to DB */ }
  }

  const counts = await fetcher();

  if (client) {
    try {
      await client.setEx(KEY_COUNTS(userId), COUNTS_TTL_S, JSON.stringify(counts));
    } catch { /* ignore write errors */ }
  }

  return counts;
};

// ------------------------------------------------------------------
// User base profile cache (lightweight — no posts, no block check)
// ------------------------------------------------------------------
export type CachedUserProfile = {
  id: number;
  name: string | null;
  last_name: string | null;
  username: string | null;
  image_profil: string | null;
  about: string | null;
  role: number | null;
  disabled: boolean;
  is_deleted: boolean;
  [key: string]: any;
};

export const getCachedProfile = async (
  userId: number,
  fetcher: () => Promise<CachedUserProfile | null>
): Promise<CachedUserProfile | null> => {
  const client = await getClient();
  if (client) {
    try {
      const raw = await client.get(KEY_PROFILE(userId));
      if (raw) return JSON.parse(raw) as CachedUserProfile;
    } catch { /* fall through */ }
  }

  const profile = await fetcher();

  if (profile && client) {
    try {
      await client.setEx(KEY_PROFILE(userId), PROFILE_TTL_S, JSON.stringify(profile));
    } catch { /* ignore */ }
  }

  return profile;
};

// ------------------------------------------------------------------
// Invalidation — call on profile update or follow/unfollow
// ------------------------------------------------------------------
export const invalidateUserCache = async (userId: number): Promise<void> => {
  const client = await getClient();
  if (!client) return;
  try {
    await Promise.all([
      client.del(KEY_COUNTS(userId)),
      client.del(KEY_PROFILE(userId)),
    ]);
  } catch { /* ignore */ }
};

export const invalidateUserCounts = async (userId: number): Promise<void> => {
  const client = await getClient();
  if (!client) return;
  try { await client.del(KEY_COUNTS(userId)); } catch { /* ignore */ }
};

// ------------------------------------------------------------------
// Full auth user cache (roles + worker + categories + plan — used by saveToken)
// TTL 5 min: short enough to reflect role/worker changes without hammering DB on refresh.
// ------------------------------------------------------------------
const AUTH_USER_TTL_S = Math.max(60, Number(process.env.USER_AUTH_CACHE_TTL_S ?? 300) || 300);
const KEY_AUTH_USER = (id: number) => `user:auth:${id}`;

export const getCachedAuthUser = async <T>(
  userId: number,
  fetcher: () => Promise<T | null>
): Promise<T | null> => {
  const client = await getClient();
  if (client) {
    try {
      const raw = await client.get(KEY_AUTH_USER(userId));
      if (raw) return JSON.parse(raw) as T;
    } catch { /* fall through */ }
  }

  const user = await fetcher();

  if (user !== null && user !== undefined && client) {
    try {
      await client.setEx(KEY_AUTH_USER(userId), AUTH_USER_TTL_S, JSON.stringify(user));
    } catch { /* ignore */ }
  }

  return user;
};

export const invalidateAuthUserCache = async (userId: number): Promise<void> => {
  const client = await getClient();
  if (!client) return;
  try { await client.del(KEY_AUTH_USER(userId)); } catch { /* ignore */ }
};
