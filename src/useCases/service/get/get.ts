import { Request, Response, formatResponse, repository } from "../_module/module";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import { isSummaryMode, toServiceSummary } from "../../../libs/summary_response";
import {
  enrichServiceApplicantsStatus,
  enrichServicesApplicantsStatus,
} from "../../../libs/applicants_status";

type ServiceHistoryDateRange = {
  from?: Date | null;
  to?: Date | null;
};

const normalizeQueryToken = (input: unknown): string => {
  const raw = Array.isArray(input) ? input[0] : input;
  return String(raw ?? "").trim().toLowerCase();
};

const parseHistoryYear = (input: unknown): number | null => {
  const raw = normalizeQueryToken(input);
  if (!raw) return null;
  const year = Number(raw);
  if (!Number.isInteger(year)) return null;
  if (year < 1970 || year > 9999) return null;
  return year;
};

const subtractUtcMonths = (base: Date, months: number): Date => {
  const date = new Date(base.getTime());
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

const resolveHistoryDateRange = (
  query: Record<string, unknown> = {}
): ServiceHistoryDateRange => {
  const now = new Date();
  const year = parseHistoryYear(query.year);
  if (year !== null) {
    const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1);
    return { from, to };
  }

  const filter = normalizeQueryToken(
    query.filter ??
      query.date_filter ??
      query.dateFilter ??
      query.history_filter ??
      query.historyFilter ??
      "latest"
  );

  if (filter === "last_30_days") {
    const from = new Date(now.getTime());
    from.setUTCDate(from.getUTCDate() - 30);
    return { from, to: now };
  }

  if (filter === "last_3_months") {
    return { from: subtractUtcMonths(now, 3), to: now };
  }

  if (filter === "last_6_months") {
    return { from: subtractUtcMonths(now, 6), to: now };
  }

  // latest (default): no date restriction, only newest-first sorting.
  return {};
};

function toPlain<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

function toBool(input: unknown, defaultVal = true): boolean {
  if (input === undefined || input === null) return defaultVal;
  const s = String(Array.isArray(input) ? input[0] : input).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultVal;
}

function parsePageAndSize(query: Record<string, unknown> = {}) {
  const pageNum = Math.max(0, Number(query.page ?? 0) || 0);
  const sizeNum = Math.min(Math.max(Number(query.size ?? 15) || 15, 1), 50);
  return { pageNum, sizeNum };
}

function toCount(countValue: unknown): number {
  if (Array.isArray(countValue)) return countValue.length;
  const parsed = Number(countValue ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const resolveWorkerHistoryScopeToken = (query: Record<string, unknown> = {}) => {
  return normalizeQueryToken(
    query.scope ??
      query.history_scope ??
      query.status_scope ??
      query.tab ??
      query.type ??
      query.state ??
      query.section ??
      query.status ??
      query.filter ??
      "all"
  );
};

const resolveWorkerHistoryStatusIds = (
  query: Record<string, unknown> = {}
): number[] | undefined => {
  const scopeCandidate = resolveWorkerHistoryScopeToken(query);

  // Date filters are handled separately. Don't interpret as scope.
  if (
    ["latest", "last_30_days", "last_3_months", "last_6_months"].includes(scopeCandidate)
  ) {
    return undefined;
  }

  if (!scopeCandidate || scopeCandidate === "all") return undefined;
  if (scopeCandidate === "in_progress" || scopeCandidate === "in-progress") return [1, 3];
  if (scopeCandidate === "assigned") return [2];
  if (scopeCandidate === "working") return [3];
  if (scopeCandidate === "completed") return [4];
  if (scopeCandidate === "closed") return [2, 4];
  if (scopeCandidate === "canceled" || scopeCandidate === "cancelled") return [5];

  const numeric = Number(scopeCandidate);
  if (Number.isInteger(numeric) && numeric > 0) return [numeric];

  // unknown scope -> keep backward-compatible all-history behavior
  return undefined;
};

function ensureCurrencyOnService(svc: any) {
  if (!svc) return svc;

  const code = svc.currencyCode ?? svc.currency_code;
  const prefix = svc.currencyPrefix ?? svc.currency_prefix;

  if (!code) {
    svc.currencyCode = "AUD";
    svc.currency_code = "AUD";
  } else {
    svc.currencyCode = code;
    svc.currency_code = code;
  }

  if (!prefix) {
    svc.currencyPrefix = "AU$";
    svc.currency_prefix = "AU$";
  } else {
    svc.currencyPrefix = prefix;
    svc.currency_prefix = prefix;
  }

  return svc;
}

function ensureCurrencyOnList(list: any[]) {
  if (!Array.isArray(list)) return list;
  return list.map(ensureCurrencyOnService);
}

function mirrorUsername(target: any, source: any) {
  if (!target || !source) return target;

  const username =
    source.username ??
    source.user_name ??
    target.username ??
    target.user_name ??
    null;

  if (!username) return target;

  target.username = username;
  target.user_name = username;
  return target;
}

function normalizeApplicantUsernamesOnService(service: any) {
  if (!service || typeof service !== "object") return service;

  if (service.client) {
    mirrorUsername(service.client, service.client);
  }

  if (Array.isArray(service.offers)) {
    service.offers = service.offers.map((offer: any) => {
      if (offer?.offerer && offer?.offerer?.personal_data) {
        mirrorUsername(offer.offerer, offer.offerer.personal_data);
      }
      return offer;
    });
  }

  if (Array.isArray(service.workers)) {
    service.workers = service.workers.map((worker: any) => {
      if (worker?.personal_data) {
        mirrorUsername(worker, worker.personal_data);
      }
      return worker;
    });
  }

  return service;
}

function normalizeApplicantUsernamesOnList(list: any[]) {
  if (!Array.isArray(list)) return list;
  return list.map(normalizeApplicantUsernamesOnService);
}

/**
 * ✅ Orden “más nuevo primero” para cualquier lista de servicios.
 * Intenta con varios campos comunes. Si no existen, cae a id DESC.
 */
function sortNewestFirst(list: any[]) {
  if (!Array.isArray(list)) return list;

  const pickDate = (x: any): number => {
    const raw =
      x?.service_date ??
      x?.serviceDate ??
      x?.createdAt ??
      x?.created_at ??
      x?.date ??
      x?.updatedAt ??
      x?.updated_at;

    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isNaN(t)) return t;

    // fallback final: por id
    const id = Number(x?.id ?? 0);
    return Number.isFinite(id) ? id : 0;
  };

  return [...list].sort((a, b) => pickDate(b) - pickDate(a));
}

export const gets = async (req: Request, res: Response) => {
  try {
    const summary = isSummaryMode((req.query as any)?.summary);
    const size = Math.min(Math.max(Number((req.query as any)?.size) || 20, 1), 20);
    const servicesRaw = summary ? await repository.getsSummary(size) : await repository.gets();
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    if (summary) {
      services = services.map((service: any) => toServiceSummary(service));
    }

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myonGoing = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.onGoing(req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoing = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.onGoing(req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const getsOnGoing = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const summary = isSummaryMode((req.query as any)?.summary);
    const servicesRaw = await (summary
      ? repository.getsOnGoingSummary
      : repository.getsOnGoing)(pageNum, sizeNum, req.userId);

    // ✅ findAndCountAll -> {count, rows}
    const safe = toPlain(servicesRaw) as any;

    let rows = ensureCurrencyOnList(safe.rows ?? []);
    rows = normalizeApplicantUsernamesOnList(rows);
    rows = enrichServicesApplicantsStatus(rows);
    rows = sortNewestFirst(rows);
    const responseRows = summary
      ? rows.map((service: any) => toServiceSummary(service))
      : rows;

    const payload = {
      page: pageNum,
      size: sizeNum,
      count: toCount(safe.count),
      services: responseRows,
    };

    setCacheControl(res, {
      visibility: req.userId ? "private" : "public",
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 60,
      staleIfErrorSeconds: 120,
    });
    if (respondNotModifiedIfFresh(req, res, payload)) return;

    return formatResponse({
      res: res,
      success: true,
      body: payload,
    });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoingWorkers = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const servicesRaw = await repository.onGoingWorkersPaged(
      req.workerId,
      req.userId,
      pageNum,
      sizeNum
    );
    const safe = toPlain(servicesRaw) as any;
    let services = ensureCurrencyOnList(safe.rows ?? []);
    const totalCount = toCount(safe.count);

    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    const visibleCount = services.length;
    const hasMore = (pageNum + 1) * sizeNum < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        has_more: hasMore,
        services,
      },
    });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const onGoingCanceledWorkers = async (req: Request, res: Response) => {
  try {
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.onGoingCanceledWorkersPaged(
      req.workerId,
      req.userId,
      pageNum,
      sizeNum,
      historyDateRange
    );
    const safe = toPlain(servicesRaw) as any;
    let services = ensureCurrencyOnList(safe.rows ?? []);
    const totalCount = toCount(safe.count);

    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    const visibleCount = services.length;
    const hasMore = (pageNum + 1) * sizeNum < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        has_more: hasMore,
        services,
      },
    });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const historyWorkers = async (req: Request, res: Response) => {
  try {
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const workerHistoryStatusIds = resolveWorkerHistoryStatusIds(
      req.query as Record<string, unknown>
    );
    const { pageNum, sizeNum } = parsePageAndSize(req.query as Record<string, unknown>);
    const servicesRaw = await repository.historyWorkersPaged(
      req.workerId,
      req.userId,
      pageNum,
      sizeNum,
      historyDateRange,
      workerHistoryStatusIds
    );
    const safe = toPlain(servicesRaw) as any;
    let services = ensureCurrencyOnList(safe.rows ?? []);
    const totalCount = toCount(safe.count);
    const statusCounts = await repository.historyWorkersStatusCounts(
      req.workerId,
      req.userId,
      historyDateRange
    );
    const countAssigned = Number(statusCounts[2] ?? 0) || 0;
    const countWorking = Number(statusCounts[3] ?? 0) || 0;
    const countCompleted = Number(statusCounts[4] ?? 0) || 0;
    const countInitialized = Number(statusCounts[1] ?? 0) || 0;
    const countInProgress = countInitialized + countWorking;
    const countClosed = countAssigned + countCompleted;

    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    const visibleCount = services.length;
    const hasMore = (pageNum + 1) * sizeNum < totalCount;

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: pageNum,
        size: sizeNum,
        count: totalCount,
        count_page: visibleCount,
        count_total: totalCount,
        count_in_progress: countInProgress,
        count_closed: countClosed,
        count_assigned: countAssigned,
        count_working: countWorking,
        count_completed: countCompleted,
        has_more: hasMore,
        services,
      },
    });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const serviceRaw = await repository.get(id);
    let service = toPlain(serviceRaw);

    service = ensureCurrencyOnService(service);
    service = normalizeApplicantUsernamesOnService(service);
    service = enrichServiceApplicantsStatus(service);

    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myHistory = async (req: Request, res: Response) => {
  try {
    const { canceled } = req.query as Record<string, unknown>;
    const canceledBool = toBool(canceled, true);
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);

    const servicesRaw = await repository.history(req.userId, canceledBool, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    return formatResponse({ res, success: true, body: { services } });
  } catch (error: any) {
    console.error(error);
    return formatResponse({
      res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const myHistoryCanceled = async (req: Request, res: Response) => {
  try {
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.historyCanceled(req.userId, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

export const history = async (req: Request, res: Response) => {
  try {
    const historyDateRange = resolveHistoryDateRange(req.query as Record<string, unknown>);
    const servicesRaw = await repository.history(undefined, true, historyDateRange);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
    services = enrichServicesApplicantsStatus(services);
    services = sortNewestFirst(services);

    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};
