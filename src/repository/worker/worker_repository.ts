import User from "../../_models/user/user";
import Category from "../../_models/category/category";
import Worker from "../../_models/worker/worker";
import Follower from "../../_models/follower/follower";
import { workerIncludes } from "./worker_includes";
import { Op, QueryTypes, Sequelize } from "sequelize";
import sequelize from "../../_db/connection";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../libs/cache/find_session_store";

const excludeKeys = ["createdAt", "updatedAt", "password"];
const WORKER_FIND_SESSION_TTL_MS = Math.max(
  60_000,
  Number(process.env.WORKER_FIND_SESSION_TTL_MS ?? 6 * 60 * 60 * 1000) ||
    6 * 60 * 60 * 1000
);
const WORKER_CANDIDATE_POOL_MIN = Math.max(
  40,
  Number(process.env.WORKER_FIND_CANDIDATE_POOL_MIN ?? 80) || 80
);
const WORKER_CANDIDATE_POOL_MAX = Math.max(
  WORKER_CANDIDATE_POOL_MIN,
  Number(process.env.WORKER_FIND_CANDIDATE_POOL_MAX ?? 800) || 800
);
const WORKER_CANDIDATE_POOL_MULTIPLIER = Math.max(
  2,
  Number(process.env.WORKER_FIND_CANDIDATE_POOL_MULTIPLIER ?? 6) || 6
);
const WORKER_RANK_ROTATION_WINDOW_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.WORKER_RANK_ROTATION_WINDOW_MS ?? 3 * 60 * 60 * 1000) ||
    3 * 60 * 60 * 1000
);
const DEFAULT_WORKER_PAGE_SIZE = 5;
const MAX_WORKER_PAGE_SIZE = 30;
const MAX_WORKER_SESSION_SEEN = 200;
const MAX_WORKER_SESSION_TOPICS = 60;
const MAX_WORKER_SESSION_IMPRESSIONS = 400;
const MAX_WORKER_SESSION_RECENT_TOP = 24;

type WorkerFeedOptions = {
  sessionKey?: any;
};

type WorkerBucket = "interest" | "social" | "trending" | "local" | "exploration";

type WorkerSessionState = {
  updatedAt: number;
  seenWorkerIds: number[];
  recentCategoryIds: number[];
  recentTopUserIds: number[];
  workerImpressions: Record<string, number>;
};

type WorkerViewerContext = {
  viewerId: number | null;
  interestCategoryIds: Set<number>;
  followedUserIds: Set<number>;
  countryResidenceId: number | null;
  stateResidenceId: number | null;
  cityResidenceId: number | null;
};

type WorkerPoolRow = {
  id: number;
  userId: number;
  rate: number;
  planId: number | null;
  about: string | null;
  updatedAt: Date | null;
  createdAt: Date | null;
  personal_data?: {
    id: number;
    verified: boolean;
    country_residence_id: number | null;
    state_residence_id: number | null;
    city_residence_id: number | null;
  } | null;
  categoryIds: number[];
  categoryLabels: string[];
};

type WorkerCandidate = {
  id: number;
  userId: number;
  bucket: WorkerBucket;
  categoryIds: number[];
  primaryCategoryId: number | null;
  interestScore: number;
  socialScore: number;
  localScore: number;
  freshnessScore: number;
  qualityScore: number;
  explorationScore: number;
  repetitionPenalty: number;
  fatiguePenalty: number;
  recentTopPenalty: number;
  lowQualityPenalty: number;
  finalScore: number;
};

const nowMs = () => Date.now();

const normalizePositiveNumber = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const normalizePositiveInt = (value: any): number | null => {
  const n = normalizePositiveNumber(value);
  if (!n) return null;
  return Math.floor(n);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = normalizePositiveInt(value);
  if (n === null) return Math.max(0, fallback);
  return Math.max(0, n);
};

const normalizeLimit = (value: any, fallback = DEFAULT_WORKER_PAGE_SIZE) => {
  const n = normalizePositiveInt(value);
  if (n === null) return fallback;
  return Math.max(1, Math.min(MAX_WORKER_PAGE_SIZE, n));
};

const normalizeUserId = (value: any): number | null => {
  const n = normalizePositiveInt(value);
  return n && n > 0 ? n : null;
};

const normalizeSessionToken = (value: any) => {
  const token = String(value ?? "").trim();
  if (!token) return "";
  return token.slice(0, 128);
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const toValidDate = (value: any): Date | null => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const toPositiveIntSet = (input: any): Set<number> => {
  const source = Array.isArray(input) ? input : [];
  const ids = new Set<number>();
  source.forEach((raw: any) => {
    const id = normalizePositiveInt(raw);
    if (id) ids.add(id);
  });
  return ids;
};

const hashString = (input: string) => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return hash >>> 0;
};

const stableRandom = (seed: string, id: number) => {
  const hash = hashString(`${seed}:${id}`);
  return (hash % 10_000) / 10_000;
};

const buildWorkerSessionMemoryKey = (
  viewerId: number | null,
  sessionTokenRaw: any
) => {
  const sessionToken = normalizeSessionToken(sessionTokenRaw);
  if (viewerId && sessionToken) return `u:${viewerId}:${sessionToken}`;
  if (viewerId) return `u:${viewerId}`;
  if (sessionToken) return `a:${sessionToken}`;
  return "";
};

const buildEmptyWorkerSessionState = (): WorkerSessionState => ({
  updatedAt: nowMs(),
  seenWorkerIds: [],
  recentCategoryIds: [],
  recentTopUserIds: [],
  workerImpressions: {},
});

const sanitizeWorkerSessionState = (raw: any): WorkerSessionState => {
  const base = raw && typeof raw === "object" ? raw : {};

  const seenWorkerIds = Array.from(
    toPositiveIntSet((base as any)?.seenWorkerIds)
  ).slice(0, MAX_WORKER_SESSION_SEEN);
  const recentCategoryIds = Array.from(
    toPositiveIntSet((base as any)?.recentCategoryIds)
  ).slice(0, MAX_WORKER_SESSION_TOPICS);
  const recentTopUserIds = Array.from(
    toPositiveIntSet((base as any)?.recentTopUserIds)
  ).slice(0, MAX_WORKER_SESSION_RECENT_TOP);

  const workerImpressions: Record<string, number> = {};
  Object.entries((base as any)?.workerImpressions ?? {}).forEach(
    ([userIdRaw, countRaw]) => {
      const userId = normalizePositiveInt(userIdRaw);
      if (!userId) return;
      const count = Math.max(0, Math.floor(Number(countRaw) || 0));
      if (count <= 0) return;
      workerImpressions[String(userId)] = count;
    }
  );

  return {
    updatedAt: Number((base as any)?.updatedAt ?? nowMs()) || nowMs(),
    seenWorkerIds,
    recentCategoryIds,
    recentTopUserIds,
    workerImpressions,
  };
};

const getWorkerSessionState = async (
  sessionMemoryKey: string
): Promise<{ state: WorkerSessionState; backend: "redis" | "memory" }> => {
  if (!sessionMemoryKey) {
    return { state: buildEmptyWorkerSessionState(), backend: "memory" };
  }

  const ttlSeconds = Math.max(60, Math.floor(WORKER_FIND_SESSION_TTL_MS / 1000));
  const loaded = await loadFindSessionState<WorkerSessionState>({
    scope: "worker",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    initialState: buildEmptyWorkerSessionState(),
  });

  const state = sanitizeWorkerSessionState(
    loaded.state ?? buildEmptyWorkerSessionState()
  );
  state.updatedAt = nowMs();

  return {
    state,
    backend: loaded.backend,
  };
};

const pushUniqueLimited = (list: number[], value: number, maxLength: number) => {
  if (!Number.isFinite(value) || value <= 0) return;
  const index = list.findIndex((item) => item === value);
  if (index >= 0) list.splice(index, 1);
  list.unshift(value);
  if (list.length > maxLength) list.length = maxLength;
};

const updateWorkerSessionState = async (
  sessionMemoryKey: string,
  sessionState: WorkerSessionState,
  selectedCandidates: WorkerCandidate[],
  pageNumber: number
) => {
  if (!sessionMemoryKey) return "memory" as const;

  selectedCandidates.forEach((candidate) => {
    pushUniqueLimited(sessionState.seenWorkerIds, candidate.id, MAX_WORKER_SESSION_SEEN);
    if (candidate.primaryCategoryId) {
      pushUniqueLimited(
        sessionState.recentCategoryIds,
        candidate.primaryCategoryId,
        MAX_WORKER_SESSION_TOPICS
      );
    }

    const key = String(candidate.userId);
    const current = Number(sessionState.workerImpressions[key] ?? 0) || 0;
    sessionState.workerImpressions[key] = current + 1;
  });

  if (pageNumber === 0) {
    selectedCandidates.slice(0, 2).forEach((candidate) => {
      pushUniqueLimited(
        sessionState.recentTopUserIds,
        candidate.userId,
        MAX_WORKER_SESSION_RECENT_TOP
      );
    });
  }

  const impressionKeys = Object.keys(sessionState.workerImpressions);
  if (impressionKeys.length > MAX_WORKER_SESSION_IMPRESSIONS) {
    impressionKeys
      .sort(
        (a, b) =>
          Number(sessionState.workerImpressions[b] ?? 0) -
          Number(sessionState.workerImpressions[a] ?? 0)
      )
      .slice(MAX_WORKER_SESSION_IMPRESSIONS)
      .forEach((key) => {
        delete sessionState.workerImpressions[key];
      });
  }

  sessionState.updatedAt = nowMs();
  const ttlSeconds = Math.max(60, Math.floor(WORKER_FIND_SESSION_TTL_MS / 1000));
  return saveFindSessionState({
    scope: "worker",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    state: sessionState,
  });
};

const buildWorkerWhere = (viewerId: number | null) => {
  const andClauses: any[] = [];
  if (viewerId) {
    andClauses.push(
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = \`worker\`.\`userId\`)
            OR
            (ub.blocker_id = \`worker\`.\`userId\` AND ub.blocked_id = :meId)
        )
      `)
    );
  }

  return {
    where: {
      available: true,
      visible: true,
      ...(andClauses.length ? { [Op.and]: andClauses } : {}),
    },
    replacements: viewerId ? { meId: viewerId } : undefined,
  };
};

const buildActiveUserWhere = () => ({
  available: true,
  disabled: false,
  is_deleted: false,
});

const loadWorkerViewerContext = async (
  viewerId: number | null
): Promise<WorkerViewerContext> => {
  if (!viewerId) {
    return {
      viewerId: null,
      interestCategoryIds: new Set<number>(),
      followedUserIds: new Set<number>(),
      countryResidenceId: null,
      stateResidenceId: null,
      cityResidenceId: null,
    };
  }

  const [viewer, followedRows] = await Promise.all([
    User.findByPk(viewerId, {
      attributes: [
        "id",
        "job_category_ids",
        "country_residence_id",
        "state_residence_id",
        "city_residence_id",
      ],
    }),
    Follower.findAll({
      where: { followerId: viewerId },
      attributes: ["userId"],
      raw: true,
    }),
  ]);

  const interestCategoryIds = toPositiveIntSet((viewer as any)?.job_category_ids);
  const followedUserIds = new Set<number>();
  followedRows.forEach((row: any) => {
    const id = normalizePositiveInt(row?.userId);
    if (id) followedUserIds.add(id);
  });

  return {
    viewerId,
    interestCategoryIds,
    followedUserIds,
    countryResidenceId: normalizePositiveInt((viewer as any)?.country_residence_id),
    stateResidenceId: normalizePositiveInt((viewer as any)?.state_residence_id),
    cityResidenceId: normalizePositiveInt((viewer as any)?.city_residence_id),
  };
};

const loadWorkerCategoryMap = async (workerIds: number[]) => {
  if (!workerIds.length) {
    return {
      categoryIdsByWorkerId: new Map<number, number[]>(),
      categoryLabelsByWorkerId: new Map<number, string[]>(),
    };
  }

  const rows = await sequelize.query(
    `
      SELECT
        wc.workerId AS workerId,
        c.id AS categoryId,
        COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(c.es_name), ''), CONCAT('cat-', c.id)) AS label
      FROM worker_category wc
      JOIN categories c ON c.id = wc.categoryId
      WHERE wc.workerId IN (:workerIds)
      ORDER BY wc.workerId ASC, c.id ASC
    `,
    {
      replacements: { workerIds },
      type: QueryTypes.SELECT,
    }
  );

  const categoryIdsByWorkerId = new Map<number, number[]>();
  const categoryLabelsByWorkerId = new Map<number, string[]>();

  (rows as any[]).forEach((row: any) => {
    const workerId = normalizePositiveInt(row?.workerId);
    const categoryId = normalizePositiveInt(row?.categoryId);
    if (!workerId || !categoryId) return;

    const ids = categoryIdsByWorkerId.get(workerId) ?? [];
    if (!ids.includes(categoryId)) ids.push(categoryId);
    categoryIdsByWorkerId.set(workerId, ids);

    const label = String(row?.label ?? "").trim();
    if (label) {
      const labels = categoryLabelsByWorkerId.get(workerId) ?? [];
      if (!labels.includes(label)) labels.push(label);
      categoryLabelsByWorkerId.set(workerId, labels);
    }
  });

  return {
    categoryIdsByWorkerId,
    categoryLabelsByWorkerId,
  };
};

const fetchWorkerCandidatePool = async ({
  where,
  replacements,
  desiredCount,
}: {
  where: any;
  replacements?: any;
  desiredCount: number;
}): Promise<WorkerPoolRow[]> => {
  const candidateLimit = Math.min(
    WORKER_CANDIDATE_POOL_MAX,
    Math.max(
      WORKER_CANDIDATE_POOL_MIN,
      Math.floor(desiredCount * WORKER_CANDIDATE_POOL_MULTIPLIER)
    )
  );

  const rows = await Worker.findAll({
    where,
    ...(replacements ? { replacements } : {}),
    attributes: ["id", "userId", "rate", "planId", "about", "updatedAt", "createdAt"],
    include: [
      {
        model: User,
        as: "personal_data",
        required: true,
        where: buildActiveUserWhere(),
        attributes: [
          "id",
          "verified",
          "country_residence_id",
          "state_residence_id",
          "city_residence_id",
        ],
      },
    ],
    order: [
      ["updatedAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: candidateLimit,
    subQuery: false,
  });

  const plainRows = rows.map((row: any) =>
    typeof row?.toJSON === "function" ? row.toJSON() : row
  );

  const workerIds = plainRows
    .map((row: any) => normalizePositiveInt(row?.id))
    .filter((id: number | null): id is number => Boolean(id));

  const { categoryIdsByWorkerId, categoryLabelsByWorkerId } =
    await loadWorkerCategoryMap(workerIds);

  return plainRows
    .map((row: any) => {
      const workerId = normalizePositiveInt(row?.id);
      const userId = normalizePositiveInt(row?.userId);
      if (!workerId || !userId) return null;

      return {
        id: workerId,
        userId,
        rate: Number(row?.rate ?? 0) || 0,
        planId: normalizePositiveInt(row?.planId),
        about: row?.about ? String(row.about) : null,
        updatedAt: toValidDate(row?.updatedAt),
        createdAt: toValidDate(row?.createdAt),
        personal_data: row?.personal_data ?? null,
        categoryIds: categoryIdsByWorkerId.get(workerId) ?? [],
        categoryLabels: categoryLabelsByWorkerId.get(workerId) ?? [],
      } as WorkerPoolRow;
    })
    .filter(Boolean) as WorkerPoolRow[];
};

const buildWorkerCandidate = ({
  row,
  context,
  sessionState,
  seed,
}: {
  row: WorkerPoolRow;
  context: WorkerViewerContext;
  sessionState: WorkerSessionState;
  seed: string;
}): WorkerCandidate | null => {
  const workerId = normalizePositiveInt(row.id);
  const userId = normalizePositiveInt(row.userId);
  if (!workerId || !userId) return null;

  const categoryIds = Array.from(new Set((row.categoryIds ?? []).filter((id) => id > 0)));
  const primaryCategoryId = categoryIds[0] ?? null;

  const overlapCount = categoryIds.reduce((acc, categoryId) => {
    if (context.interestCategoryIds.has(categoryId)) return acc + 1;
    return acc;
  }, 0);
  const interestBase = context.interestCategoryIds.size
    ? overlapCount / Math.max(1, Math.min(context.interestCategoryIds.size, 5))
    : 0;
  const interestScore = clamp01(interestBase);

  const socialScore = context.followedUserIds.has(userId) ? 1 : 0;

  const candidateCountry = normalizePositiveInt(
    (row.personal_data as any)?.country_residence_id
  );
  const candidateState = normalizePositiveInt((row.personal_data as any)?.state_residence_id);
  const candidateCity = normalizePositiveInt((row.personal_data as any)?.city_residence_id);

  let localScore = 0;
  if (
    context.cityResidenceId &&
    candidateCity &&
    context.cityResidenceId === candidateCity
  ) {
    localScore = 1;
  } else if (
    context.stateResidenceId &&
    candidateState &&
    context.stateResidenceId === candidateState
  ) {
    localScore = 0.75;
  } else if (
    context.countryResidenceId &&
    candidateCountry &&
    context.countryResidenceId === candidateCountry
  ) {
    localScore = 0.5;
  }

  const rateNorm = clamp01((Number(row.rate) || 0) / 5);
  const verifiedBoost = Boolean((row.personal_data as any)?.verified) ? 0.15 : 0;
  const aboutBoost = row.about && row.about.trim().length >= 40 ? 0.1 : 0;
  const qualityScore = clamp01(rateNorm * 0.75 + verifiedBoost + aboutBoost);

  const updatedAt = row.updatedAt ?? row.createdAt;
  const ageDays = updatedAt
    ? Math.max(0, (nowMs() - updatedAt.getTime()) / (24 * 60 * 60 * 1000))
    : 365;
  const freshnessScore = clamp01(Math.exp(-ageDays / 30));

  const seenSet = new Set<number>(sessionState.seenWorkerIds);
  const hasSeen = seenSet.has(workerId);
  const impressions = Number(sessionState.workerImpressions[String(userId)] ?? 0) || 0;
  const recentTopRank = sessionState.recentTopUserIds.findIndex(
    (id) => id === userId
  );
  const noveltyScore = hasSeen ? 0 : 1;
  const explorationScore = clamp01(
    0.5 * noveltyScore +
      0.3 * (1 - Math.min(1, impressions / 5)) +
      0.2 * stableRandom(seed, workerId)
  );

  const repetitionPenalty = hasSeen ? 0.22 : 0;
  const fatiguePenalty = clamp01(Math.max(0, impressions - 2) * 0.08);
  const recentTopPenalty =
    recentTopRank === -1 ? 0 : clamp01(Math.max(0.08, 0.28 - recentTopRank * 0.04));
  const lowQualityPenalty = qualityScore < 0.25 ? 0.18 : 0;

  const finalScore =
    0.35 * interestScore +
    0.2 * qualityScore +
    0.15 * freshnessScore +
    0.15 * socialScore +
    0.1 * localScore +
    0.05 * explorationScore -
    repetitionPenalty -
    fatiguePenalty -
    recentTopPenalty -
    lowQualityPenalty;

  let bucket: WorkerBucket = "exploration";
  if (socialScore >= 0.9) bucket = "social";
  else if (interestScore >= 0.45) bucket = "interest";
  else if (localScore >= 0.6) bucket = "local";
  else if (qualityScore >= 0.55 && freshnessScore >= 0.45) bucket = "trending";

  return {
    id: workerId,
    userId,
    bucket,
    categoryIds,
    primaryCategoryId,
    interestScore,
    socialScore,
    localScore,
    freshnessScore,
    qualityScore,
    explorationScore,
    repetitionPenalty,
    fatiguePenalty,
    recentTopPenalty,
    lowQualityPenalty,
    finalScore,
  };
};

const buildWorkerBucketTargets = ({
  desiredCount,
  availableByBucket,
  hasViewer,
}: {
  desiredCount: number;
  availableByBucket: Record<WorkerBucket, number>;
  hasViewer: boolean;
}) => {
  const weights: Record<WorkerBucket, number> = hasViewer
    ? {
        interest: 0.4,
        social: 0.25,
        trending: 0.15,
        local: 0.1,
        exploration: 0.1,
      }
    : {
        interest: 0,
        social: 0,
        trending: 0.45,
        local: 0.2,
        exploration: 0.35,
      };

  const targets: Record<WorkerBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };

  const decimals: Array<{ bucket: WorkerBucket; decimal: number }> = [];
  let assigned = 0;

  (Object.keys(weights) as WorkerBucket[]).forEach((bucket) => {
    const desiredRaw = desiredCount * weights[bucket];
    const target = Math.min(availableByBucket[bucket], Math.floor(desiredRaw));
    targets[bucket] = target;
    assigned += target;
    decimals.push({ bucket, decimal: desiredRaw - Math.floor(desiredRaw) });
  });

  let remaining = Math.max(0, desiredCount - assigned);
  decimals
    .sort((a, b) => b.decimal - a.decimal)
    .forEach(({ bucket }) => {
      if (remaining <= 0) return;
      if (targets[bucket] >= availableByBucket[bucket]) return;
      targets[bucket] += 1;
      remaining -= 1;
    });

  if (remaining > 0) {
    (Object.keys(weights) as WorkerBucket[]).forEach((bucket) => {
      while (remaining > 0 && targets[bucket] < availableByBucket[bucket]) {
        targets[bucket] += 1;
        remaining -= 1;
      }
    });
  }

  return targets;
};

const wouldBreakTopicDiversity = (
  selected: WorkerCandidate[],
  candidate: WorkerCandidate
) => {
  if (!candidate.primaryCategoryId) return false;
  if (selected.length < 2) return false;

  const last = selected[selected.length - 1];
  const prev = selected[selected.length - 2];
  if (!last?.primaryCategoryId || !prev?.primaryCategoryId) return false;

  return (
    last.primaryCategoryId === candidate.primaryCategoryId &&
    prev.primaryCategoryId === candidate.primaryCategoryId
  );
};

const selectWorkerCandidates = ({
  scoredCandidates,
  desiredCount,
  bucketTargets,
  recentTopUserIds = [],
}: {
  scoredCandidates: WorkerCandidate[];
  desiredCount: number;
  bucketTargets: Record<WorkerBucket, number>;
  recentTopUserIds?: number[];
}) => {
  const selected: WorkerCandidate[] = [];
  const selectedUserIds = new Set<number>();
  const recentTopSet = new Set(
    (Array.isArray(recentTopUserIds) ? recentTopUserIds : []).slice(0, 6)
  );
  const usedByBucket: Record<WorkerBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };

  for (const candidate of scoredCandidates) {
    if (selected.length >= desiredCount) break;
    if (selectedUserIds.has(candidate.userId)) continue;
    if (selected.length === 0 && recentTopSet.has(candidate.userId)) continue;
    if (wouldBreakTopicDiversity(selected, candidate)) continue;
    if (usedByBucket[candidate.bucket] >= bucketTargets[candidate.bucket]) continue;

    selected.push(candidate);
    selectedUserIds.add(candidate.userId);
    usedByBucket[candidate.bucket] += 1;
  }

  for (const candidate of scoredCandidates) {
    if (selected.length >= desiredCount) break;
    if (selectedUserIds.has(candidate.userId)) continue;
    selected.push(candidate);
    selectedUserIds.add(candidate.userId);
  }

  return selected;
};

const applyWorkerTopKShuffle = (
  candidates: WorkerCandidate[],
  seedRaw: any,
  recentTopUserIds: number[] = []
): WorkerCandidate[] => {
  if (!Array.isArray(candidates) || candidates.length <= 2) return candidates;

  const seed = String(seedRaw ?? "worker").trim() || "worker";
  const recentTopSet = new Set(
    (Array.isArray(recentTopUserIds) ? recentTopUserIds : []).slice(0, 6)
  );
  const topN = Math.min(20, candidates.length);
  const top = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  const shuffledTop = top
    .slice()
    .sort((a, b) => {
      const recentPenaltyA = recentTopSet.has(a.userId) ? 0.22 : 0;
      const recentPenaltyB = recentTopSet.has(b.userId) ? 0.22 : 0;
      const scoreA =
        a.finalScore - recentPenaltyA + (stableRandom(seed, a.id) - 0.5) * 0.08;
      const scoreB =
        b.finalScore - recentPenaltyB + (stableRandom(seed, b.id) - 0.5) * 0.08;
      return scoreB - scoreA;
    });

  if (shuffledTop.length > 1 && recentTopSet.has(shuffledTop[0].userId)) {
    const replacementIndex = shuffledTop.findIndex(
      (candidate, index) => index > 0 && !recentTopSet.has(candidate.userId)
    );
    if (replacementIndex > 0) {
      const [replacement] = shuffledTop.splice(replacementIndex, 1);
      shuffledTop.unshift(replacement);
    }
  }

  return [...shuffledTop, ...tail];
};

const fetchWorkersByIdsOrdered = async (workerIds: number[]) => {
  if (!workerIds.length) return [];

  const rows = await Worker.findAll({
    where: { id: { [Op.in]: workerIds } },
    include: workerIncludes,
    attributes: { exclude: excludeKeys },
  });

  const byId = new Map<number, any>();
  rows.forEach((row: any) => {
    byId.set(Number((row as any)?.id), row);
  });

  return workerIds.map((workerId) => byId.get(workerId)).filter(Boolean);
};

export const add = async (body: any) => {
  const userId = Number(body?.userId);
  if (Number.isFinite(userId) && userId > 0) {
    const existing = await Worker.findOne({
      where: { userId },
      order: [
        ["available", "DESC"],
        ["id", "DESC"],
      ],
    });

    if (existing) {
      const updateBody: any = { ...body, available: true };
      delete updateBody.userId;
      await existing.update(updateBody);
      return existing;
    }
  }

  const worker = await Worker.create(body);
  return worker;
};

export const gets = async () => {
  const worker = await Worker.findAll({
    where: { available: true, visible: true },
    include: workerIncludes,
  });
  return worker;
};

export const workers = async (
  page: any,
  size: any,
  meId: any = -1,
  options: WorkerFeedOptions = {}
) => {
  const pageNumber = normalizePage(page, 0);
  const sizeNumber = normalizeLimit(size, DEFAULT_WORKER_PAGE_SIZE);
  const viewerId = normalizeUserId(meId);
  const sessionMemoryKey = buildWorkerSessionMemoryKey(viewerId, options.sessionKey);

  const start = pageNumber * sizeNumber;
  const end = start + sizeNumber;
  const desiredCount = Math.max(end, sizeNumber);

  const { state: sessionState } = await getWorkerSessionState(sessionMemoryKey);
  const { where, replacements } = buildWorkerWhere(viewerId);

  const [totalCount, viewerContext, candidatePoolRows] = await Promise.all([
    Worker.count({
      where,
      ...(replacements ? { replacements } : {}),
      include: [
        {
          model: User,
          as: "personal_data",
          required: true,
          where: buildActiveUserWhere(),
          attributes: [],
        },
      ],
      distinct: true,
      col: "id",
    } as any),
    loadWorkerViewerContext(viewerId),
    fetchWorkerCandidatePool({
      where,
      replacements,
      desiredCount,
    }),
  ]);

  const seedBase = sessionMemoryKey || `viewer:${viewerId ?? "anon"}`;
  const seedBucket = Math.floor(nowMs() / WORKER_RANK_ROTATION_WINDOW_MS);
  const rankingSeed = `${seedBase}:r:${seedBucket}`;
  const scoredCandidates = candidatePoolRows
    .map((row) =>
      buildWorkerCandidate({
        row,
        context: viewerContext,
        sessionState,
        seed: rankingSeed,
      })
    )
    .filter(Boolean) as WorkerCandidate[];

  scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);

  const availableByBucket: Record<WorkerBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };
  scoredCandidates.forEach((candidate) => {
    availableByBucket[candidate.bucket] += 1;
  });

  const bucketTargets = buildWorkerBucketTargets({
    desiredCount,
    availableByBucket,
    hasViewer: Boolean(viewerId),
  });

  const selectedCandidates = selectWorkerCandidates({
    scoredCandidates,
    desiredCount,
    bucketTargets,
    recentTopUserIds: sessionState.recentTopUserIds,
  });
  const shuffledCandidates = applyWorkerTopKShuffle(
    selectedCandidates,
    rankingSeed,
    sessionState.recentTopUserIds
  );
  const pageCandidates = shuffledCandidates.slice(start, end);
  const pageIds = pageCandidates.map((candidate) => candidate.id);

  const orderedWorkers = await fetchWorkersByIdsOrdered(pageIds);
  await updateWorkerSessionState(
    sessionMemoryKey,
    sessionState,
    pageCandidates,
    pageNumber
  );

  return {
    count: Number(totalCount || 0),
    rows: orderedWorkers,
  };
};

export const update = async (id: any, body: any) => {
  const workerTemp = await Worker.findOne({
    where: { id },
    include: workerIncludes,
  });

  const worker = await workerTemp?.update(body);
  if (Array.isArray(body.categories)) {
    const currentCategories = await worker?.getCategories();
    await worker?.removeCategories(currentCategories);
    await worker?.addCategories(body.categories);
  }
  return worker;
};

export const visibleProfile = async (id: any, body: any) => {
  const workerTemp = await Worker.findOne({
    where: { userId: id, available: true },
    order: [["id", "DESC"]],
    include: workerIncludes,
  });
  const response = await workerTemp?.update(body);
  return response;
};

export const worker = async (id: any, meId: any = -1) => {
  const viewerId = normalizeUserId(meId);
  const andClauses: any[] = [];
  if (viewerId) {
    andClauses.push(
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = :meId AND ub.blocked_id = \`worker\`.\`userId\`)
            OR
            (ub.blocker_id = \`worker\`.\`userId\` AND ub.blocked_id = :meId)
        )
      `)
    );
  }

  const worker = await Worker.findOne({
    where: {
      userId: id,
      available: true,
      ...(andClauses.length ? { [Op.and]: andClauses } : {}),
    },
    ...(viewerId ? { replacements: { meId: viewerId } } : {}),
    order: [["id", "DESC"]],
    include: workerIncludes,
    attributes: { exclude: excludeKeys },
  });
  return worker;
};

export const tokensByNewService = async (categoryId: any, meId: any) => {
  const rows = await Worker.findAll({
    include: [
      {
        model: Category,
        attributes: [],
        required: true,
        where: {
          [Op.or]: [{ id: categoryId }, { name: "all" }],
        },
        through: { attributes: [] },
      },
      {
        model: User,
        as: "personal_data",
        attributes: ["uuid"],
        required: true,
        where: {
          alert: true,
          id: { [Op.ne]: meId },
        },
      },
    ],
    attributes: [],
    subQuery: false,
  });

  const uuids = Array.from(
    new Set(rows.map((w: any) => w.personal_data?.uuid).filter(Boolean))
  );
  return uuids;
};

export type NewServicePushTarget = {
  token: string;
  language: string | null;
  language_codes: string[];
  language_names: string[];
};

const toStringArray = (value: any): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => String(item ?? "").trim()).filter(Boolean);
};

export const pushTargetsByNewService = async (
  categoryId: any,
  meId: any
): Promise<NewServicePushTarget[]> => {
  const rows = await Worker.findAll({
    include: [
      {
        model: Category,
        attributes: [],
        required: true,
        where: {
          [Op.or]: [{ id: categoryId }, { name: "all" }],
        },
        through: { attributes: [] },
      },
      {
        model: User,
        as: "personal_data",
        attributes: ["uuid", "language", "language_codes", "language_names"],
        required: true,
        where: {
          alert: true,
          id: { [Op.ne]: meId },
        },
      },
    ],
    attributes: [],
    subQuery: false,
  });

  const deduped = new Map<string, NewServicePushTarget>();
  for (const row of rows) {
    const personal = (row as any)?.personal_data;
    const token = String(personal?.uuid ?? "").trim();
    if (!token) continue;
    if (deduped.has(token)) continue;

    deduped.set(token, {
      token,
      language: personal?.language ? String(personal.language).trim() : null,
      language_codes: toStringArray(personal?.language_codes),
      language_names: toStringArray(personal?.language_names),
    });
  }

  return Array.from(deduped.values());
};

export const deleteImageProfil = async (id: any) => {
  return await User.update(
    {
      image_profil:
        "https://imagedelivery.net/byMb3jxLYxr0Esz1Tf7NcQ/ff67a5c9-2984-45be-9502-925d46939100/public",
    },
    { where: { id } }
  );
};
