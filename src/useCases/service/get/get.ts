import { Request, Response, formatResponse, repository } from "../_module/module";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import { isSummaryMode, toServiceSummary } from "../../../libs/summary_response";

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
      x?.createdAt ??
      x?.created_at ??
      x?.service_date ??
      x?.serviceDate ??
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
    const pageNum = Math.max(0, Number(req.query.page ?? 0) || 0);
    const sizeNum = Math.min(Math.max(Number(req.query.size ?? 10) || 10, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const servicesRaw = await (summary
      ? repository.getsOnGoingSummary
      : repository.getsOnGoing)(pageNum, sizeNum, req.userId);

    // ✅ findAndCountAll -> {count, rows}
    const safe = toPlain(servicesRaw) as any;

    let rows = ensureCurrencyOnList(safe.rows ?? []);
    rows = normalizeApplicantUsernamesOnList(rows);
    rows = sortNewestFirst(rows);
    const responseRows = summary
      ? rows.map((service: any) => toServiceSummary(service))
      : rows;

    const payload = {
      page: pageNum,
      size: sizeNum,
      count: safe.count ?? 0,
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
    const servicesRaw = await repository.onGoingWorkers(req.workerId, req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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

export const onGoingCanceledWorkers = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.onGoingCanceledWorkers(req.workerId, req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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

export const historyWorkers = async (req: Request, res: Response) => {
  try {
    const servicesRaw = await repository.historyWorkers(req.workerId, req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const serviceRaw = await repository.get(id);
    let service = toPlain(serviceRaw);

    service = ensureCurrencyOnService(service);
    service = normalizeApplicantUsernamesOnService(service);

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

    const servicesRaw = await repository.history(req.userId, canceledBool);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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
    const servicesRaw = await repository.historyCanceled(req.userId);
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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
    const servicesRaw = await repository.history();
    let services = toPlain(servicesRaw) as any[];

    services = ensureCurrencyOnList(services);
    services = normalizeApplicantUsernamesOnList(services);
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
