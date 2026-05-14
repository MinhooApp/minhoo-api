import {
  Request,
  Response,
  formatResponse,
  sendUnifiedSuccess,
  serviceRepository,
  userRepository,
  toServiceSummary,
} from "../_module/module";
import {
  buildServiceFeedViewerContext,
  rankServiceFeedItems,
} from "../../../libs/feed/service_feed_ranking";

type ServiceFeedItem = {
  id: number | null;
  on_site: boolean;
  onSite: boolean;
  is_remote: boolean;
  isRemote: boolean;
  createdAt: string | null;
  client?: any;
  [key: string]: any;
};

const parsePositiveInt = (value: any, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
};

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const toIsoDate = (value: any): string | null => {
  const parsed = new Date(value ?? "");
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const toBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

const resolveOnSite = (serviceRaw: any): boolean => {
  const explicitOnSite = toBoolOrNull(serviceRaw?.on_site ?? serviceRaw?.onSite);
  if (explicitOnSite !== null) return explicitOnSite;

  const explicitRemote = toBoolOrNull(serviceRaw?.is_remote ?? serviceRaw?.isRemote);
  if (explicitRemote !== null) return !explicitRemote;

  const hasAddress = String(serviceRaw?.address ?? "").trim().length > 0;
  const hasCoordinates =
    Number.isFinite(Number(serviceRaw?.latitude)) &&
    Number.isFinite(Number(serviceRaw?.longitude));
  return hasAddress || hasCoordinates;
};

const toServiceFeedItem = (serviceRaw: any, viewerIdRaw: any): ServiceFeedItem => {
  const summary = toServiceSummary(serviceRaw, viewerIdRaw);
  const onSite = resolveOnSite(serviceRaw);
  const createdAt =
    summary?.createdAt ??
    toIsoDate(serviceRaw?.service_date ?? serviceRaw?.createdAt ?? serviceRaw?.updatedAt);

  return {
    ...summary,
    on_site: onSite,
    onSite,
    is_remote: !onSite,
    isRemote: !onSite,
    createdAt,
    created_at: createdAt,
    client: serviceRaw?.client ?? null,
  };
};

export const feed_services = async (req: Request, res: Response) => {
  try {
    const limit = parsePositiveInt((req.query as any)?.limit, 10, 30);
    const includeRankingDebug = isTruthy((req.query as any)?.ranking_debug);
    const candidateSize = Math.min(Math.max(limit * 5, 30), 120);
    const viewerId = Number((req as any)?.userId ?? 0);
    const viewerUser =
      Number.isFinite(viewerId) && viewerId > 0
        ? await userRepository.getUserById(viewerId)
        : null;
    const rowsRaw = await serviceRepository.getFeedServicesCandidates(candidateSize, viewerId);
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
    const lightweight = rows.map((service: any) => toServiceFeedItem(service, viewerId));
    const rankedItems = rankServiceFeedItems(
      lightweight,
      buildServiceFeedViewerContext(viewerUser),
      {
        includeRankingDebug,
      }
    );
    const items = rankedItems
      .slice(0, limit)
      .map(({ client, ...item }: any) => item);
    res.set("X-Ranking-Debug", includeRankingDebug ? "1" : "0");

    return sendUnifiedSuccess(res, {
      items,
      count: items.length,
      page: 0,
      size: limit,
      next_cursor: null,
      extras: {
        services: items,
      },
    });
  } catch (error: any) {
    console.log("[feed][services] error", error);
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: error?.message ?? String(error),
    });
  }
};
