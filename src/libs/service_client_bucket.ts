export type ServiceClientBucket = "searching" | "in_progress" | "history";

export const SERVICE_STATUS_INITIALIZED = 1;
export const SERVICE_STATUS_ASSIGNED = 2;
export const SERVICE_STATUS_IN_PROGRESS = 3;
export const SERVICE_STATUS_FINALIZED = 4;
export const SERVICE_STATUS_CANCELED = 5;

const toNumberOrNull = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
};

const toCount = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const toIsoOrNull = (value: any): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const resolveStatusIdFromStatusText = (statusRaw: any): number | null => {
  const token = String(statusRaw ?? "")
    .trim()
    .toLowerCase();
  if (!token) return null;
  if (token.includes("cancel")) return SERVICE_STATUS_CANCELED;
  if (token.includes("complete") || token.includes("final")) {
    return SERVICE_STATUS_FINALIZED;
  }
  if (token.includes("progress")) return SERVICE_STATUS_IN_PROGRESS;
  if (token.includes("assign")) return SERVICE_STATUS_ASSIGNED;
  if (token.includes("init") || token.includes("search")) return SERVICE_STATUS_INITIALIZED;
  return null;
};

const resolveStatusId = (serviceRaw: any): number => {
  const service = serviceRaw ?? {};
  const direct = [
    service.status_id,
    service.statusId,
    service.status?.id,
    service.status?.status_id,
  ];

  for (const candidate of direct) {
    const parsed = toNumberOrNull(candidate);
    if (parsed && parsed > 0) return parsed;
  }

  const fromText = resolveStatusIdFromStatusText(
    service.status?.status ?? service.status?.name ?? service.status
  );
  if (fromText) return fromText;
  return SERVICE_STATUS_INITIALIZED;
};

const resolveCanonicalStatus = (statusId: number, statusRaw: any): string => {
  if (statusId === SERVICE_STATUS_INITIALIZED) return "SEARCHING";
  if (statusId === SERVICE_STATUS_ASSIGNED) return "ASSIGNED";
  if (statusId === SERVICE_STATUS_IN_PROGRESS) return "IN_PROGRESS";
  if (statusId === SERVICE_STATUS_FINALIZED) return "FINALIZED";
  if (statusId === SERVICE_STATUS_CANCELED) return "CANCELED";

  const token = String(statusRaw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return token || "UNKNOWN";
};

const resolveAcceptedCountFromOffers = (serviceRaw: any): number => {
  const offers = Array.isArray(serviceRaw?.offers) ? serviceRaw.offers : [];
  if (!offers.length) return 0;
  const uniqueWorkers = new Set<number>();

  for (const offer of offers) {
    if (!offer || !offer.accepted) continue;
    if (offer.canceled || offer.removed) continue;
    const workerId = toNumberOrNull(offer.workerId ?? offer.worker_id ?? offer.offerer?.id);
    if (!workerId || workerId <= 0) continue;
    uniqueWorkers.add(workerId);
  }

  return uniqueWorkers.size;
};

const resolveAcceptedCountFromWorkers = (serviceRaw: any): number => {
  const workers = Array.isArray(serviceRaw?.workers) ? serviceRaw.workers : [];
  if (!workers.length) return 0;
  let count = 0;
  for (const worker of workers) {
    const bridge = worker?.service_worker ?? worker?.Service_Worker ?? worker?.serviceWorker;
    if (bridge?.removed === true || bridge?.removed === 1) continue;
    count += 1;
  }
  return count;
};

const resolveAcceptedCount = (serviceRaw: any): number => {
  const explicit = serviceRaw?.accepted_count ?? serviceRaw?.acceptedCount;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return toCount(explicit);
  }

  const fromOffers = resolveAcceptedCountFromOffers(serviceRaw);
  const fromWorkers = resolveAcceptedCountFromWorkers(serviceRaw);
  return Math.max(fromOffers, fromWorkers, 0);
};

const resolveClientBucket = ({
  statusId,
  hasAssignedWorkers,
  manualClosedAt,
  closedAt,
}: {
  statusId: number;
  hasAssignedWorkers: boolean;
  manualClosedAt: string | null;
  closedAt: string | null;
}): ServiceClientBucket => {
  if (statusId === SERVICE_STATUS_CANCELED) return "history";

  if (statusId === SERVICE_STATUS_ASSIGNED || statusId === SERVICE_STATUS_IN_PROGRESS) {
    return "in_progress";
  }

  if (statusId === SERVICE_STATUS_FINALIZED) {
    if (!hasAssignedWorkers) return "history";
    if (manualClosedAt) return "history";
    if (!closedAt) return "history";
    return "in_progress";
  }

  return "searching";
};

export type ServiceRoutingFields = {
  status_id: number;
  statusId: number;
  status: string;
  accepted_count: number;
  acceptedCount: number;
  has_assigned_workers: boolean;
  hasAssignedWorkers: boolean;
  client_bucket: ServiceClientBucket;
  clientBucket: ServiceClientBucket;
  manual_close_required: boolean;
  manualCloseRequired: boolean;
  manual_closed_at: string | null;
  manualClosedAt: string | null;
  closed_at: string | null;
  closedAt: string | null;
};

export const buildServiceRoutingFields = (
  serviceRaw: any,
  overrides: {
    acceptedCount?: number;
    statusId?: number;
    manualClosedAt?: string | null;
    closedAt?: string | null;
  } = {}
): ServiceRoutingFields => {
  const statusId = Math.max(
    1,
    toNumberOrNull(overrides.statusId) ?? resolveStatusId(serviceRaw)
  );
  let acceptedCount = Math.max(
    0,
    toCount(overrides.acceptedCount ?? resolveAcceptedCount(serviceRaw))
  );
  if (statusId === SERVICE_STATUS_CANCELED) {
    acceptedCount = 0;
  }
  const hasAssignedWorkers = acceptedCount > 0;
  const manualClosedAt = toIsoOrNull(
    overrides.manualClosedAt ??
      serviceRaw?.manual_closed_at ??
      serviceRaw?.manualClosedAt
  );
  let closedAt = toIsoOrNull(
    overrides.closedAt ?? serviceRaw?.closed_at ?? serviceRaw?.closedAt
  );

  if (!closedAt && statusId === SERVICE_STATUS_CANCELED) {
    closedAt = toIsoOrNull(serviceRaw?.updatedAt ?? serviceRaw?.updated_at);
  }

  const status = resolveCanonicalStatus(
    statusId,
    serviceRaw?.status?.status ?? serviceRaw?.status?.name ?? serviceRaw?.status
  );
  const clientBucket = resolveClientBucket({
    statusId,
    hasAssignedWorkers,
    manualClosedAt,
    closedAt,
  });
  const manualCloseRequired =
    statusId === SERVICE_STATUS_FINALIZED &&
    hasAssignedWorkers &&
    !!closedAt &&
    !manualClosedAt;

  return {
    status_id: statusId,
    statusId,
    status,
    accepted_count: acceptedCount,
    acceptedCount,
    has_assigned_workers: hasAssignedWorkers,
    hasAssignedWorkers,
    client_bucket: clientBucket,
    clientBucket,
    manual_close_required: manualCloseRequired,
    manualCloseRequired,
    manual_closed_at: manualClosedAt,
    manualClosedAt: manualClosedAt,
    closed_at: closedAt,
    closedAt: closedAt,
  };
};

export const attachServiceRoutingFields = (
  targetRaw: any,
  overrides: Parameters<typeof buildServiceRoutingFields>[1] = {}
): ServiceRoutingFields => {
  const target = targetRaw ?? {};
  const fields = buildServiceRoutingFields(target, overrides);

  const statusRelation =
    target?.status && typeof target.status === "object" ? target.status : null;
  if (statusRelation) {
    target.status_detail = statusRelation;
    target.status_obj = statusRelation;
  }

  Object.assign(target, fields);
  return fields;
};

export const toServiceUpdatedSocketPayload = (serviceRaw: any) => {
  const service = serviceRaw ?? {};
  const routing = buildServiceRoutingFields(service);
  return {
    id: Number(service.id ?? 0) || null,
    ...routing,
  };
};
