import {
  calculateFeedScore,
  FeedLanguageTier,
  FeedLocationTier,
} from "./feed_relevance";

type ServiceFeedViewerContext = {
  userId: number | null;
  cityId: number | null;
  stateId: number | null;
  countryId: number | null;
  primaryLanguageCode: string | null;
  secondaryLanguageCodes: Set<string>;
};

type ServiceFeedItem = {
  id: number | null;
  on_site?: boolean;
  onSite?: boolean;
  is_remote?: boolean;
  isRemote?: boolean;
  createdAt?: string | null;
  service_date?: string | null;
  client?: any;
  [key: string]: any;
};

type RankServiceFeedOptions = {
  includeRankingDebug?: boolean;
};

const normalizeLanguageCode = (value: any): string | null => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!raw) return null;
  const token = raw.split("-")[0];
  if (!token || !/^[a-z]{2,8}$/.test(token)) return null;
  return token;
};

const parseJsonArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  if (typeof value === "object") return [value];
  return [value];
};

const toUniqueLanguageCodes = (values: any[]): string[] => {
  const unique = new Set<string>();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const code = normalizeLanguageCode(value);
    if (code) unique.add(code);
  });
  return Array.from(unique.values());
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toIsoDate = (value: any): string | null => {
  const parsed = new Date(value ?? "");
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const toTimestamp = (value: any): number => {
  const parsed = new Date(value ?? "").getTime();
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const resolveServiceLocationTier = (
  viewer: ServiceFeedViewerContext,
  provider: any
): FeedLocationTier => {
  const providerCityId = toPositiveInt(provider?.city_residence_id ?? provider?.cityId);
  const providerStateId = toPositiveInt(provider?.state_residence_id);
  const providerCountryId = toPositiveInt(
    provider?.country_residence_id ?? provider?.countryId
  );

  if (
    viewer.cityId &&
    providerCityId &&
    Number(viewer.cityId) === Number(providerCityId)
  ) {
    return "same_city";
  }
  if (
    viewer.stateId &&
    providerStateId &&
    Number(viewer.stateId) === Number(providerStateId)
  ) {
    return "same_state";
  }
  if (
    viewer.countryId &&
    providerCountryId &&
    Number(viewer.countryId) === Number(providerCountryId)
  ) {
    return "same_country";
  }
  return "global";
};

const resolveServiceLanguageTier = (
  viewer: ServiceFeedViewerContext,
  provider: any
): FeedLanguageTier => {
  const providerLanguageCodes = toUniqueLanguageCodes([
    ...parseJsonArray(provider?.language_codes),
    ...parseJsonArray(provider?.language_names),
    provider?.language,
  ]);
  if (!providerLanguageCodes.length) return "unknown";

  const viewerPrimary = normalizeLanguageCode(viewer.primaryLanguageCode);
  if (viewerPrimary && providerLanguageCodes.includes(viewerPrimary)) return "primary";

  if (
    viewer.secondaryLanguageCodes.size > 0 &&
    providerLanguageCodes.some((code) => viewer.secondaryLanguageCodes.has(code))
  ) {
    return "secondary";
  }
  return "other";
};

const isOnSiteService = (item: ServiceFeedItem) => {
  if (item.is_remote === true || item.isRemote === true) return false;
  if (item.on_site === false || item.onSite === false) return false;
  return true;
};

const passesOnSiteCityRule = (item: ServiceFeedItem, viewer: ServiceFeedViewerContext) => {
  if (!isOnSiteService(item)) return true;
  if (!viewer.cityId) return false;
  const provider = item?.client ?? null;
  const providerCityId = toPositiveInt(provider?.city_residence_id ?? provider?.cityId);
  if (!providerCityId) return false;
  return Number(providerCityId) === Number(viewer.cityId);
};

const resolveServiceAgeHours = (item: ServiceFeedItem): number => {
  const sourceDate = item?.service_date ?? item?.createdAt ?? item?.created_at;
  const timestamp = toTimestamp(sourceDate);
  if (!timestamp) return 96;
  return Math.max(0, (Date.now() - timestamp) / (60 * 60 * 1000));
};

export const buildServiceFeedViewerContext = (
  viewerRaw: any
): ServiceFeedViewerContext => {
  const viewer = viewerRaw ?? {};
  const languageCodes = toUniqueLanguageCodes([
    ...parseJsonArray((viewer as any)?.language_codes),
    ...parseJsonArray((viewer as any)?.language_names),
    (viewer as any)?.language,
  ]);
  return {
    userId: toPositiveInt((viewer as any)?.id),
    cityId: toPositiveInt((viewer as any)?.city_residence_id ?? (viewer as any)?.cityId),
    stateId: toPositiveInt((viewer as any)?.state_residence_id),
    countryId: toPositiveInt(
      (viewer as any)?.country_residence_id ?? (viewer as any)?.countryId
    ),
    primaryLanguageCode: languageCodes[0] ?? null,
    secondaryLanguageCodes: new Set(languageCodes.slice(1)),
  };
};

export const rankServiceFeedItems = (
  itemsRaw: ServiceFeedItem[],
  viewer: ServiceFeedViewerContext,
  options: RankServiceFeedOptions = {}
): ServiceFeedItem[] => {
  const includeRankingDebug = Boolean(options.includeRankingDebug);
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];

  const ranked = items
    .filter((item) => passesOnSiteCityRule(item, viewer))
    .map((item) => {
      const provider = item?.client ?? null;
      const ageHours = resolveServiceAgeHours(item);
      const locationTier = resolveServiceLocationTier(viewer, provider);
      const languageTier = resolveServiceLanguageTier(viewer, provider);
      const score = calculateFeedScore({
        locationTier,
        languageTier,
        contentKind: "job",
        ageHours,
        recencyHalfLifeHours: 24,
        recencyMaxPoints: 45,
        ownPostBoostApplied: false,
      });
      const nextItem: any = {
        ...item,
        createdAt: toIsoDate(item?.createdAt ?? item?.service_date ?? item?.created_at),
      };
      if (includeRankingDebug) {
        const rankingReason = {
          ...score.rankingReason,
          scoreBreakdown: score.breakdown,
          score: score.totalScore,
        };
        nextItem.score = score.totalScore;
        nextItem.feed_score = score.totalScore;
        nextItem.rankingReason = rankingReason;
        nextItem.ranking_reason = rankingReason;
      }
      return {
        item: nextItem,
        score: score.totalScore,
        createdTs: toTimestamp(nextItem.createdAt),
        id: Number(nextItem.id ?? 0) || 0,
      };
    });

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.createdTs !== b.createdTs) return b.createdTs - a.createdTs;
    return b.id - a.id;
  });

  return ranked.map((entry) => entry.item);
};

export type { ServiceFeedItem, ServiceFeedViewerContext, RankServiceFeedOptions };
