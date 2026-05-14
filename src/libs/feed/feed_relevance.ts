type FeedLocationTier = "same_city" | "same_state" | "same_country" | "global";
type FeedLanguageTier = "primary" | "secondary" | "other" | "unknown";
type FeedContentKind = "job" | "video" | "reel" | "image" | "text" | "other";

const LOCATION_POINTS: Record<FeedLocationTier, number> = {
  same_city: 100,
  same_state: 70,
  same_country: 40,
  global: 10,
};

const LANGUAGE_POINTS: Record<FeedLanguageTier, number> = {
  primary: 50,
  secondary: 30,
  other: 10,
  unknown: 10,
};

const CONTENT_KIND_POINTS: Record<FeedContentKind, number> = {
  job: 30,
  video: 30,
  reel: 30,
  image: 20,
  text: 10,
  other: 10,
};

const clampMinZero = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return value;
};

const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;

export type FeedScoreBreakdown = {
  locationScore: number;
  languageScore: number;
  contentTypeScore: number;
  recencyScore: number;
  ownPostBoost: number;
};

export type FeedRankingReason = {
  locationTier: FeedLocationTier;
  languageTier: FeedLanguageTier;
  contentKind: FeedContentKind;
  ageHours: number;
  recencyHalfLifeHours: number;
  recencyMaxPoints: number;
  ownPostBoostWindowMinutes: number;
  ownPostBoostApplied: boolean;
};

export type FeedScoreResult = {
  totalScore: number;
  breakdown: FeedScoreBreakdown;
  rankingReason: FeedRankingReason;
};

export type FeedScoreInput = {
  locationTier?: FeedLocationTier | null;
  languageTier?: FeedLanguageTier | null;
  contentKind?: FeedContentKind | null;
  ageHours?: number | null;
  recencyHalfLifeHours?: number;
  recencyMaxPoints?: number;
  ownPostBoostWindowMinutes?: number;
  ownPostBoostPoints?: number;
  ownPostBoostApplied?: boolean;
};

export const calculateFeedScore = (input: FeedScoreInput): FeedScoreResult => {
  const locationTier: FeedLocationTier = input.locationTier ?? "global";
  const languageTier: FeedLanguageTier = input.languageTier ?? "unknown";
  const contentKind: FeedContentKind = input.contentKind ?? "other";
  const ageHours = clampMinZero(Number(input.ageHours ?? 0));
  const recencyHalfLifeHours = Math.max(
    1,
    Number(input.recencyHalfLifeHours ?? 24) || 24
  );
  const recencyMaxPoints = Math.max(1, Number(input.recencyMaxPoints ?? 40) || 40);
  const ownPostBoostWindowMinutes = Math.max(
    1,
    Number(input.ownPostBoostWindowMinutes ?? 30) || 30
  );
  const ownPostBoostPoints = Math.max(0, Number(input.ownPostBoostPoints ?? 60) || 60);
  const ownPostBoostApplied = Boolean(input.ownPostBoostApplied);

  const locationScore = LOCATION_POINTS[locationTier] ?? LOCATION_POINTS.global;
  const languageScore = LANGUAGE_POINTS[languageTier] ?? LANGUAGE_POINTS.unknown;
  const contentTypeScore = CONTENT_KIND_POINTS[contentKind] ?? CONTENT_KIND_POINTS.other;
  const recencyScore = recencyMaxPoints * Math.exp(-ageHours / recencyHalfLifeHours);
  const ownPostBoost = ownPostBoostApplied ? ownPostBoostPoints : 0;
  const totalScore =
    locationScore + languageScore + contentTypeScore + recencyScore + ownPostBoost;

  return {
    totalScore: round3(totalScore),
    breakdown: {
      locationScore: round3(locationScore),
      languageScore: round3(languageScore),
      contentTypeScore: round3(contentTypeScore),
      recencyScore: round3(recencyScore),
      ownPostBoost: round3(ownPostBoost),
    },
    rankingReason: {
      locationTier,
      languageTier,
      contentKind,
      ageHours: round3(ageHours),
      recencyHalfLifeHours: round3(recencyHalfLifeHours),
      recencyMaxPoints: round3(recencyMaxPoints),
      ownPostBoostWindowMinutes,
      ownPostBoostApplied,
    },
  };
};

export type { FeedLocationTier, FeedLanguageTier, FeedContentKind };
