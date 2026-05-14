import {
  SERVICE_STATUS_INITIALIZED,
  attachServiceRoutingFields,
} from "./service_client_bucket";

export type ApplicantsLevel = "low" | "high";

export type ApplicantsStatus = {
  level: ApplicantsLevel;
  label_es: string;
  label_en: string;
};

const LOW_LABEL_ES = "Sé de los primeros en postularte";
const LOW_LABEL_EN = "Be among the first to apply";
const HIGH_LABEL_ES = "Alta demanda";
const HIGH_LABEL_EN = "High demand";

const toCount = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const isOfferActive = (offerRaw: any) => {
  const offer = offerRaw ?? {};
  return !Boolean(offer.canceled) && !Boolean(offer.removed);
};

const pickWorkerId = (offerRaw: any) => {
  const offer = offerRaw ?? {};
  const workerId = Number(
    offer.workerId ?? offer.worker_id ?? offer.offerer?.id ?? 0
  );
  if (!Number.isFinite(workerId) || workerId <= 0) return null;
  return Math.floor(workerId);
};

export const buildApplicantsStatus = (applicantsCountRaw: any): ApplicantsStatus => {
  const applicantsCount = toCount(applicantsCountRaw);
  if (applicantsCount >= 11) {
    return {
      level: "high",
      label_es: HIGH_LABEL_ES,
      label_en: HIGH_LABEL_EN,
    };
  }
  return {
    level: "low",
    label_es: LOW_LABEL_ES,
    label_en: LOW_LABEL_EN,
  };
};

export const resolveApplicantsCount = (serviceRaw: any): number => {
  const service = serviceRaw ?? {};
  const explicitCount = service.applicants_count ?? service.applicantsCount;
  if (explicitCount !== undefined && explicitCount !== null && explicitCount !== "") {
    return toCount(explicitCount);
  }

  const offers = Array.isArray(service.offers) ? service.offers : [];
  if (!offers.length) return 0;

  const uniqueApplicants = new Set<number>();
  offers.forEach((offer: any) => {
    if (!isOfferActive(offer)) return;
    const workerId = pickWorkerId(offer);
    if (!workerId) return;
    uniqueApplicants.add(workerId);
  });

  return uniqueApplicants.size;
};

export const attachApplicantsCountAliases = (
  targetRaw: any,
  applicantsCountRaw: any
): number => {
  const applicantsCount = toCount(applicantsCountRaw);
  if (!targetRaw || typeof targetRaw !== "object") return applicantsCount;

  const aliases = {
    applicants_count: applicantsCount,
    applicantsCount,
    offers_count: applicantsCount,
    offersCount: applicantsCount,
  };

  if (typeof (targetRaw as any).setDataValue === "function") {
    Object.entries(aliases).forEach(([key, value]) => {
      (targetRaw as any).setDataValue(key, value);
    });
  } else {
    Object.assign(targetRaw as any, aliases);
  }

  return applicantsCount;
};

export const normalizeApplicantsStatus = (statusRaw: any, applicantsCountRaw: any) => {
  const status = statusRaw ?? {};
  const normalizedLevel =
    String(status.level ?? "").trim().toLowerCase() === "high" ? "high" : "low";

  const fallback = buildApplicantsStatus(applicantsCountRaw);
  return {
    level: normalizedLevel as ApplicantsLevel,
    label_es: String(status.label_es ?? "").trim() || fallback.label_es,
    label_en: String(status.label_en ?? "").trim() || fallback.label_en,
  };
};

export const enrichServiceApplicantsStatus = (serviceRaw: any) => {
  if (!serviceRaw || typeof serviceRaw !== "object") return serviceRaw;

  const routing = attachServiceRoutingFields(serviceRaw);
  const canApply =
    Number(routing.status_id) === SERVICE_STATUS_INITIALIZED &&
    String(routing.client_bucket).toLowerCase() === "searching" &&
    !Boolean(routing.has_assigned_workers);
  const applicantsCount = resolveApplicantsCount(serviceRaw);
  const normalizedApplicantsStatus = normalizeApplicantsStatus(
    serviceRaw.applicants_status ?? serviceRaw.applicantsStatus,
    applicantsCount
  );
  const applicantsStatus = canApply
    ? normalizedApplicantsStatus
    : {
        ...normalizedApplicantsStatus,
        label_es: "",
        label_en: "",
      };

  attachApplicantsCountAliases(serviceRaw, applicantsCount);
  (serviceRaw as any).applicants_status = applicantsStatus;
  (serviceRaw as any).applicantsStatus = applicantsStatus;
  (serviceRaw as any).can_apply = canApply;
  (serviceRaw as any).canApply = canApply;
  return serviceRaw;
};

export const enrichServicesApplicantsStatus = (servicesRaw: any[]) => {
  if (!Array.isArray(servicesRaw)) return servicesRaw;
  return servicesRaw.map((service) => enrichServiceApplicantsStatus(service));
};
