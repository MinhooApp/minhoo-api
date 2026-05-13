import axios from "axios";
import { createHmac } from "crypto";
import { Request, Response } from "express";
import { Op } from "sequelize";
import User from "../../../_models/user/user";
import ProfileVerificationRequest from "../../../_models/user/profile_verification_request";
import ProfileVerificationIdentity from "../../../_models/user/profile_verification_identity";
import { writeSecurityAuditFromRequest } from "../../../libs/security/security_audit_log";
import { emitProfileUpdatedRealtime } from "../_shared/profile_realtime";

const STATUS = {
  UNVERIFIED: "unverified",
  PENDING: "pending",
  PROCESSING: "processing",
  MANUAL_REVIEW: "manual_review",
  SUPERSEDED: "superseded",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;

const MAX_IMAGE_ID_LENGTH = 255;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_DOC_NUMBER_LENGTH = 120;

const VERIFICATION_MESSAGES = {
  DUPLICATE_DOCUMENT_ES:
    "Este documento ya existe en la app y está asociado a otra cuenta.",
  DUPLICATE_DOCUMENT_EN:
    "This document already exists in the app and is linked to another account.",
  DUPLICATE_PERSON_ES:
    "Este rostro/persona ya está asociado a otra cuenta en la app.",
  DUPLICATE_PERSON_EN:
    "This face/person is already linked to another account in the app.",
  POSSIBLE_DUPLICATE_IDENTITY_ES:
    "Posible identidad duplicada detectada. Enviado a revisión manual.",
  POSSIBLE_DUPLICATE_IDENTITY_EN:
    "Possible duplicate identity detected. Sent to manual review.",
  IDENTITY_SIGNALS_REQUIRED_ES:
    "No se puede aprobar: faltan señales de identidad del proveedor (documento/rostro).",
  IDENTITY_SIGNALS_REQUIRED_EN:
    "Cannot approve: identity signals from provider are missing (document/face).",
} as const;

const parsePositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const parseNonNegativeInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

const parseFloatInRange = (
  value: any,
  minValue = 0,
  maxValue = 1
): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < minValue || parsed > maxValue) return null;
  return parsed;
};

const parseOptionalText = (value: any, maxLength = 255): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
};

const toUpperNoAccents = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

const normalizeDocumentNumber = (value: any): string | null => {
  const normalized = parseOptionalText(value, MAX_DOC_NUMBER_LENGTH);
  if (!normalized) return null;
  const compact = toUpperNoAccents(normalized).replace(/[^A-Z0-9]/g, "");
  if (compact.length < 4) return null;
  return compact.slice(0, MAX_DOC_NUMBER_LENGTH);
};

const normalizeDocType = (value: any): string | null => {
  const normalized = parseOptionalText(value, 40);
  if (!normalized) return null;
  const compact = toUpperNoAccents(normalized).replace(/[^A-Z0-9_-]/g, "_");
  return compact.slice(0, 40);
};

const normalizeDocCountry = (value: any): string | null => {
  const normalized = parseOptionalText(value, 16);
  if (!normalized) return null;
  const compact = toUpperNoAccents(normalized).replace(/[^A-Z]/g, "");
  if (!compact) return null;
  return compact.slice(0, 16);
};

const normalizePersonIdentifier = (value: any): string | null => {
  const normalized = parseOptionalText(value, 255);
  if (!normalized) return null;
  const compact = toUpperNoAccents(normalized).replace(/[^A-Z0-9:_-]/g, "");
  if (compact.length < 6) return null;
  return compact.slice(0, 255);
};

const normalizeHumanName = (value: any): string | null => {
  const normalized = parseOptionalText(value, 255);
  if (!normalized) return null;
  const compact = toUpperNoAccents(normalized).replace(/[^A-Z0-9 ]/g, " ");
  const collapsed = compact.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, 255);
};

const getIdentityFingerprintSecret = () =>
  parseOptionalText(process.env.PROFILE_VERIFICATION_IDENTITY_HASH_SECRET, 255) ??
  parseOptionalText(process.env.JWT_SECRET, 255) ??
  parseOptionalText(process.env.TOKEN_SECRET, 255) ??
  "minhoo_profile_identity_default_secret";

const hashIdentityFingerprint = (scope: string, value: string): string => {
  const secret = getIdentityFingerprintSecret();
  return createHmac("sha256", secret)
    .update(`${scope}|${value}`)
    .digest("hex")
    .slice(0, MAX_FINGERPRINT_LENGTH);
};

const isSpanishLocale = (req: Request) => {
  const langHeader = String(req.header("accept-language") ?? "")
    .trim()
    .toLowerCase();
  return langHeader.startsWith("es");
};

const pickMessage = (req: Request, es: string, en: string) =>
  isSpanishLocale(req) ? es : en;

const getPathValue = (obj: any, path: string): any => {
  if (!obj || typeof obj !== "object") return null;
  const chunks = path.split(".");
  let pointer: any = obj;
  for (const key of chunks) {
    if (!pointer || typeof pointer !== "object") return null;
    pointer = pointer[key];
  }
  return pointer ?? null;
};

const pickFirstTextByPaths = (sources: any[], paths: string[], maxLength = 255): string | null => {
  for (const source of sources) {
    for (const path of paths) {
      const value = parseOptionalText(getPathValue(source, path), maxLength);
      if (value) return value;
    }
  }
  return null;
};

type IdentitySignals = {
  documentFingerprint: string | null;
  personFingerprint: string | null;
  nameFingerprint: string | null;
  documentLast4: string | null;
  docType: string | null;
  docCountry: string | null;
};

const extractIdentitySignals = ({
  providerResponse,
  reqBody,
  docTypeFallback,
  docCountryFallback,
  user,
}: {
  providerResponse: any;
  reqBody: any;
  docTypeFallback: string | null;
  docCountryFallback: string | null;
  user: any;
}): IdentitySignals => {
  const providerPayload = providerResponse ?? {};
  const nestedSources = [
    reqBody ?? {},
    providerPayload,
    providerPayload?.data ?? null,
    providerPayload?.result ?? null,
    providerPayload?.payload ?? null,
    providerPayload?.verification ?? null,
    providerPayload?.identity ?? null,
    providerPayload?.document ?? null,
    providerPayload?.ocr ?? null,
    providerPayload?.data?.identity ?? null,
    providerPayload?.data?.document ?? null,
    providerPayload?.result?.identity ?? null,
    providerPayload?.result?.document ?? null,
  ].filter(Boolean);

  const rawDocumentNumber = pickFirstTextByPaths(nestedSources, [
    "document_number",
    "documentNumber",
    "doc_number",
    "docNumber",
    "id_number",
    "idNumber",
    "national_id",
    "nationalId",
    "document.number",
    "document.document_number",
    "document.id_number",
    "ocr.document_number",
    "ocr.id_number",
  ]);

  const rawPersonIdentifier = pickFirstTextByPaths(nestedSources, [
    "person_identifier",
    "personIdentifier",
    "person_id",
    "personId",
    "identity_id",
    "identityId",
    "subject_id",
    "subjectId",
    "face_id",
    "faceId",
    "face_hash",
    "faceHash",
    "face_embedding_hash",
    "faceEmbeddingHash",
    "identity.person_id",
    "identity.face_id",
    "document.face_id",
  ]);

  const rawName = pickFirstTextByPaths(nestedSources, [
    "document_full_name",
    "documentFullName",
    "full_name",
    "fullName",
    "document_name",
    "documentName",
    "name",
    "identity.full_name",
    "document.full_name",
    "document.name",
  ]);

  const documentNumber = normalizeDocumentNumber(rawDocumentNumber);
  const personIdentifier = normalizePersonIdentifier(rawPersonIdentifier);

  const docType = normalizeDocType(
    pickFirstTextByPaths(nestedSources, ["doc_type", "docType", "document.type"]) ??
      docTypeFallback
  );
  const docCountry = normalizeDocCountry(
    pickFirstTextByPaths(nestedSources, ["doc_country", "docCountry", "document.country"]) ??
      docCountryFallback
  );

  const normalizedName =
    normalizeHumanName(rawName) ??
    normalizeHumanName(`${(user as any)?.name ?? ""} ${(user as any)?.last_name ?? ""}`);
  const birthdayIso =
    (user as any)?.birthday && !Number.isNaN(new Date((user as any).birthday).getTime())
      ? new Date((user as any).birthday).toISOString().slice(0, 10)
      : null;

  const documentFingerprint = documentNumber
    ? hashIdentityFingerprint(
        "document",
        `${docCountry ?? "XX"}|${docType ?? "UNKNOWN"}|${documentNumber}`
      )
    : null;
  const personFingerprint = personIdentifier
    ? hashIdentityFingerprint("person", personIdentifier)
    : null;

  const nameFingerprint =
    normalizedName && birthdayIso
      ? hashIdentityFingerprint("name_birthdate", `${normalizedName}|${birthdayIso}`)
      : null;

  return {
    documentFingerprint,
    personFingerprint,
    nameFingerprint,
    documentLast4: documentNumber ? documentNumber.slice(-4) : null,
    docType,
    docCountry,
  };
};

type DuplicateIdentityDetection = {
  kind: "document" | "person" | "name";
  conflictingUserId: number | null;
};

const getUserSummaryForAdminNote = async (userIdRaw: any) => {
  const userId = parsePositiveInt(userIdRaw);
  if (!userId) return null;
  const user = await User.findOne({
    where: { id: userId },
    attributes: ["id", "username", "name", "last_name"],
  });
  if (!user) return null;
  return {
    id: parsePositiveInt((user as any)?.id),
    username: parseOptionalText((user as any)?.username, 120),
    name: parseOptionalText((user as any)?.name, 120),
    last_name: parseOptionalText((user as any)?.last_name, 120),
  };
};

const buildAdminReviewNote = ({
  requestId,
  userId,
  decisionSource,
  failureCode,
  failureReason,
  duplicateIdentity,
  conflictingUser,
}: {
  requestId: number | null;
  userId: number;
  decisionSource: string | null;
  failureCode: string | null;
  failureReason: string | null;
  duplicateIdentity?: DuplicateIdentityDetection | null;
  conflictingUser?: {
    id: number | null;
    username: string | null;
    name: string | null;
    last_name: string | null;
  } | null;
}) => {
  const chunks: string[] = [];
  chunks.push(`review_request`);
  chunks.push(`request_id=${requestId ?? "n/a"}`);
  chunks.push(`user_id=${userId}`);
  if (decisionSource) chunks.push(`source=${decisionSource}`);
  if (failureCode) chunks.push(`code=${failureCode}`);
  if (failureReason) chunks.push(`reason=${failureReason}`);

  if (duplicateIdentity?.kind) {
    chunks.push(`duplicate_kind=${duplicateIdentity.kind}`);
  }
  if (duplicateIdentity?.conflictingUserId) {
    chunks.push(`duplicate_user_id=${duplicateIdentity.conflictingUserId}`);
  }
  if (conflictingUser?.username) {
    chunks.push(`duplicate_username=${conflictingUser.username}`);
  }
  if (conflictingUser?.name || conflictingUser?.last_name) {
    const fullName = `${conflictingUser?.name ?? ""} ${conflictingUser?.last_name ?? ""}`.trim();
    if (fullName) chunks.push(`duplicate_name=${fullName}`);
  }

  return chunks.join(" | ").slice(0, 1000);
};

const findDuplicateIdentityForAnotherUser = async ({
  userId,
  documentFingerprint,
  personFingerprint,
  nameFingerprint,
  includeWeakNameSignal = false,
}: {
  userId: number;
  documentFingerprint: string | null;
  personFingerprint: string | null;
  nameFingerprint?: string | null;
  includeWeakNameSignal?: boolean;
}): Promise<DuplicateIdentityDetection | null> => {
  if (documentFingerprint) {
    const documentHit = await ProfileVerificationIdentity.findOne({
      where: {
        documentFingerprint,
        userId: {
          [Op.ne]: userId,
        },
      },
      attributes: ["userId"],
    });
    if (documentHit) {
      return {
        kind: "document",
        conflictingUserId: parsePositiveInt((documentHit as any)?.userId),
      };
    }
  }

  if (personFingerprint) {
    const personHit = await ProfileVerificationIdentity.findOne({
      where: {
        personFingerprint,
        userId: {
          [Op.ne]: userId,
        },
      },
      attributes: ["userId"],
    });
    if (personHit) {
      return {
        kind: "person",
        conflictingUserId: parsePositiveInt((personHit as any)?.userId),
      };
    }
  }

  if (includeWeakNameSignal && nameFingerprint) {
    const nameHit = await ProfileVerificationIdentity.findOne({
      where: {
        nameFingerprint,
        userId: {
          [Op.ne]: userId,
        },
      },
      attributes: ["userId"],
    });
    if (nameHit) {
      return {
        kind: "name",
        conflictingUserId: parsePositiveInt((nameHit as any)?.userId),
      };
    }
  }

  return null;
};

const upsertIdentityForUser = async ({
  userId,
  requestId,
  status,
  decisionSource,
  provider,
  identity,
}: {
  userId: number;
  requestId: number | null;
  status: string;
  decisionSource: string;
  provider: string | null;
  identity: IdentitySignals;
}) => {
  if (
    !identity.documentFingerprint &&
    !identity.personFingerprint &&
    !identity.nameFingerprint
  ) {
    return;
  }

  const orFilters: any[] = [];
  if (identity.documentFingerprint) orFilters.push({ documentFingerprint: identity.documentFingerprint });
  if (identity.personFingerprint) orFilters.push({ personFingerprint: identity.personFingerprint });
  if (identity.nameFingerprint) orFilters.push({ nameFingerprint: identity.nameFingerprint });

  const existingForUser = orFilters.length
    ? await ProfileVerificationIdentity.findOne({
        where: {
          userId,
          [Op.or]: orFilters,
        },
      })
    : null;

  const body = {
    userId,
    requestId,
    status,
    decisionSource,
    provider,
    documentFingerprint: identity.documentFingerprint,
    personFingerprint: identity.personFingerprint,
    nameFingerprint: identity.nameFingerprint,
    documentLast4: identity.documentLast4,
    docType: identity.docType,
    docCountry: identity.docCountry,
    meta: {
      updated_from: "profile_verification_submit",
    },
  };

  if (existingForUser) {
    await existingForUser.update(body);
    return;
  }

  await ProfileVerificationIdentity.create(body);
};

const extractIdentitySignalsFromRequestRow = (requestRow: any): IdentitySignals => {
  const metaIdentity = requestRow?.meta?.identity ?? {};
  return {
    documentFingerprint:
      parseOptionalText(metaIdentity?.document_fingerprint, MAX_FINGERPRINT_LENGTH) ?? null,
    personFingerprint:
      parseOptionalText(metaIdentity?.person_fingerprint, MAX_FINGERPRINT_LENGTH) ?? null,
    nameFingerprint:
      parseOptionalText(metaIdentity?.name_fingerprint, MAX_FINGERPRINT_LENGTH) ?? null,
    documentLast4: parseOptionalText(metaIdentity?.document_last4, 8) ?? null,
    docType: normalizeDocType(metaIdentity?.doc_type),
    docCountry: normalizeDocCountry(metaIdentity?.doc_country),
  };
};

const hasVerificationMediaEvidence = (requestRow: any): boolean => {
  const selfie = normalizeImageId(requestRow?.selfieImageId);
  const documentFront = normalizeImageId(requestRow?.documentFrontImageId);
  const documentBack = normalizeImageId(requestRow?.documentBackImageId);
  const selfieWithDocument = normalizeImageId(requestRow?.selfieWithDocumentImageId);
  return Boolean(selfie && documentFront && documentBack && selfieWithDocument);
};

const normalizeImageId = (value: any): string | null => {
  const normalized = parseOptionalText(value, MAX_IMAGE_ID_LENGTH);
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._-]{6,255}$/.test(normalized)) return null;
  return normalized;
};

const toBool = (value: any): boolean | null => {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
};

const parseAgeFromDate = (dateRaw: any): number | null => {
  if (!dateRaw) return null;
  const date = new Date(dateRaw);
  if (Number.isNaN(date.getTime())) return null;

  const today = new Date();
  let years = today.getUTCFullYear() - date.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - date.getUTCMonth();
  const dayDiff = today.getUTCDate() - date.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years -= 1;

  if (!Number.isFinite(years) || years < 0 || years > 120) return null;
  return years;
};

const normalizeVerificationStatus = (value: any): string | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!normalized) return null;
  if (Object.values(STATUS).includes(normalized as any)) return normalized;
  if (normalized === "needs_manual_review") return STATUS.MANUAL_REVIEW;
  if (normalized === "under_review") return STATUS.MANUAL_REVIEW;
  if (normalized === "failed") return STATUS.REJECTED;
  if (normalized === "success") return STATUS.APPROVED;
  return null;
};

const getProviderTimeoutMs = () => {
  const parsed = Number(process.env.PROFILE_VERIFICATION_PROVIDER_TIMEOUT_MS ?? 15_000);
  if (!Number.isFinite(parsed) || parsed < 1_000) return 15_000;
  return Math.floor(parsed);
};

const getMinAgeYears = () => {
  const parsed = Number(process.env.PROFILE_VERIFICATION_MIN_AGE_YEARS ?? 19);
  if (!Number.isFinite(parsed) || parsed < 18) return 19;
  return Math.floor(parsed);
};

const getMinFaceMatchScore = () => {
  const parsed = Number(process.env.PROFILE_VERIFICATION_MIN_FACE_MATCH_SCORE ?? 0.82);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return 0.82;
  return parsed;
};

const getMinOverallConfidenceScore = () => {
  const parsed = Number(process.env.PROFILE_VERIFICATION_MIN_OVERALL_CONFIDENCE ?? 0.8);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return 0.8;
  return parsed;
};

const getMinLivenessScore = () => {
  const parsed = Number(process.env.PROFILE_VERIFICATION_MIN_LIVENESS_SCORE ?? 0.7);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return 0.7;
  return parsed;
};

const isLivenessRequired = () =>
  String(process.env.PROFILE_VERIFICATION_REQUIRE_LIVENESS ?? "0").trim() === "1";

const isLocalAutomaticModeEnabled = () =>
  String(process.env.PROFILE_VERIFICATION_LOCAL_AUTOMATIC_MODE ?? "0").trim() === "1";

const isIdentitySignalRequiredForAutoApproval = () =>
  String(process.env.PROFILE_VERIFICATION_REQUIRE_IDENTITY_SIGNALS ?? "1").trim() !== "0";

const resolvePublicBaseUrl = (req: Request) => {
  const forwardedProto = String(req.header("x-forwarded-proto") ?? "").trim().toLowerCase();
  const protocol = forwardedProto || req.protocol || "https";
  const host = String(req.header("x-forwarded-host") ?? req.get("host") ?? "").trim();
  if (!host) return "";
  return `${protocol}://${host}`;
};

const buildImagePlaybackUrl = (req: Request, imageId: string) => {
  const path = `/api/v1/media/image/play?id=${encodeURIComponent(imageId)}`;
  const baseUrl = resolvePublicBaseUrl(req);
  if (!baseUrl) return path;
  return `${baseUrl}${path}`;
};

const sanitizeQueueItem = (
  rowRaw: any,
  options?: {
    includeImages?: boolean;
  }
) => {
  const row = rowRaw && typeof rowRaw.toJSON === "function" ? rowRaw.toJSON() : rowRaw ?? {};
  const user = row?.user ?? null;
  const includeImages = options?.includeImages !== false;
  const images = includeImages
    ? {
        selfie_image_id: String(row?.selfieImageId ?? "").trim() || null,
        document_front_image_id: String(row?.documentFrontImageId ?? "").trim() || null,
        document_back_image_id: String(row?.documentBackImageId ?? "").trim() || null,
        selfie_with_document_image_id:
          String(row?.selfieWithDocumentImageId ?? "").trim() || null,
      }
    : {
        selfie_image_id: null,
        document_front_image_id: null,
        document_back_image_id: null,
        selfie_with_document_image_id: null,
      };
  return {
    id: Number(row?.id ?? 0) || null,
    user_id: Number(row?.userId ?? 0) || null,
    user: user
      ? {
          id: Number(user?.id ?? 0) || null,
          name: String(user?.name ?? "").trim() || null,
          last_name: String(user?.last_name ?? "").trim() || null,
          username: String(user?.username ?? "").trim() || null,
          image_profil: String(user?.image_profil ?? "").trim() || null,
          profile_verified: Boolean(user?.profile_verified),
          profile_verification_status:
            String(user?.profile_verification_status ?? "").trim() || STATUS.UNVERIFIED,
        }
      : null,
    status: String(row?.status ?? "").trim() || STATUS.PENDING,
    decision_source: String(row?.decisionSource ?? "").trim() || "system",
    attempt_number: Number(row?.attemptNumber ?? 0) || 0,
    age_years: parseNonNegativeInt(row?.ageYears),
    is_adult: toBool(row?.isAdult),
    face_match_score: Number.isFinite(Number(row?.faceMatchScore))
      ? Number(row?.faceMatchScore)
      : null,
    liveness_score: Number.isFinite(Number(row?.livenessScore))
      ? Number(row?.livenessScore)
      : null,
    document_confidence_score: Number.isFinite(Number(row?.documentConfidenceScore))
      ? Number(row?.documentConfidenceScore)
      : null,
    overall_confidence_score: Number.isFinite(Number(row?.overallConfidenceScore))
      ? Number(row?.overallConfidenceScore)
      : null,
    failure_code: String(row?.failureCode ?? "").trim() || null,
    failure_reason: String(row?.failureReason ?? "").trim() || null,
    admin_note:
      parseOptionalText(row?.meta?.admin_review_note, 1000) ??
      parseOptionalText(row?.meta?.review_note, 1000) ??
      parseOptionalText(row?.failureReason, 255) ??
      null,
    admin_note_context: row?.meta?.admin_review_context ?? null,
    created_at: row?.createdAt ? new Date(row.createdAt).toISOString() : null,
    updated_at: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    reviewed_at: row?.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    reviewed_by_user_id: parsePositiveInt(row?.reviewedByUserId),
    submitted_at: row?.submittedAt ? new Date(row.submittedAt).toISOString() : null,
    images,
  };
};

type AutoDecision = {
  status: string;
  decisionSource: string;
  failureCode: string | null;
  failureReason: string | null;
  provider: string | null;
  providerRequestId: string | null;
  ageYears: number | null;
  isAdult: boolean | null;
  faceMatchScore: number | null;
  livenessScore: number | null;
  documentConfidenceScore: number | null;
  overallConfidenceScore: number | null;
  providerResponse: any;
};

const evaluateAutomaticDecision = async ({
  req,
  user,
  input,
}: {
  req: Request;
  user: any;
  input: {
    selfieImageId: string;
    documentFrontImageId: string;
    documentBackImageId: string;
    selfieWithDocumentImageId: string;
    docType: string | null;
    docCountry: string | null;
  };
}): Promise<AutoDecision> => {
  const providerUrl = String(process.env.PROFILE_VERIFICATION_PROVIDER_URL ?? "").trim();
  if (!providerUrl && isLocalAutomaticModeEnabled()) {
    const minAgeYears = getMinAgeYears();
    const ageYears = parseAgeFromDate((user as any)?.birthday);

    if (ageYears === null) {
      return {
        status: STATUS.MANUAL_REVIEW,
        decisionSource: "automatic_local_fallback",
        failureCode: "birthday_missing_or_invalid",
        failureReason:
          "Could not determine age from user birthday. Sent to manual review.",
        provider: "local_mode",
        providerRequestId: null,
        ageYears: null,
        isAdult: null,
        faceMatchScore: 0.85,
        livenessScore: 0.8,
        documentConfidenceScore: 0.8,
        overallConfidenceScore: 0.8,
        providerResponse: {
          mode: "local_automatic",
          reason: "birthday_missing_or_invalid",
        },
      };
    }

    if (ageYears < minAgeYears) {
      return {
        status: STATUS.REJECTED,
        decisionSource: "automatic_local",
        failureCode: "underage",
        failureReason: `User does not meet minimum age requirement (${minAgeYears}+).`,
        provider: "local_mode",
        providerRequestId: null,
        ageYears,
        isAdult: false,
        faceMatchScore: 0.85,
        livenessScore: 0.8,
        documentConfidenceScore: 0.8,
        overallConfidenceScore: 0.8,
        providerResponse: {
          mode: "local_automatic",
          reason: "underage",
        },
      };
    }

    return {
      status: STATUS.APPROVED,
      decisionSource: "automatic_local",
      failureCode: null,
      failureReason: null,
      provider: "local_mode",
      providerRequestId: null,
      ageYears,
      isAdult: true,
      faceMatchScore: 0.9,
      livenessScore: 0.85,
      documentConfidenceScore: 0.88,
      overallConfidenceScore: 0.9,
      providerResponse: {
        mode: "local_automatic",
        reason: "approved_by_age_rule",
        min_age_years: minAgeYears,
      },
    };
  }

  if (!providerUrl) {
    return {
      status: STATUS.MANUAL_REVIEW,
      decisionSource: "system_fallback",
      failureCode: "provider_not_configured",
      failureReason:
        "Automatic provider not configured. Sent to manual review queue.",
      provider: null,
      providerRequestId: null,
      ageYears: null,
      isAdult: null,
      faceMatchScore: null,
      livenessScore: null,
      documentConfidenceScore: null,
      overallConfidenceScore: null,
      providerResponse: null,
    };
  }

  const providerToken = String(process.env.PROFILE_VERIFICATION_PROVIDER_TOKEN ?? "").trim();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (providerToken) headers.authorization = `Bearer ${providerToken}`;

  const payload = {
    minhoo_user_id: Number(user?.id ?? 0) || null,
    evidence: {
      selfie_image_id: input.selfieImageId,
      document_front_image_id: input.documentFrontImageId,
      document_back_image_id: input.documentBackImageId,
      selfie_with_document_image_id: input.selfieWithDocumentImageId,
      selfie_url: buildImagePlaybackUrl(req, input.selfieImageId),
      document_front_url: buildImagePlaybackUrl(req, input.documentFrontImageId),
      document_back_url: buildImagePlaybackUrl(req, input.documentBackImageId),
      selfie_with_document_url: buildImagePlaybackUrl(req, input.selfieWithDocumentImageId),
      doc_type: input.docType,
      doc_country: input.docCountry,
    },
    rules: {
      min_age_years: getMinAgeYears(),
      min_face_match_score: getMinFaceMatchScore(),
      min_overall_confidence: getMinOverallConfidenceScore(),
      min_liveness_score: getMinLivenessScore(),
      require_liveness: isLivenessRequired(),
    },
  };

  try {
    const response = await axios.post(providerUrl, payload, {
      headers,
      timeout: getProviderTimeoutMs(),
    });

    const providerData = response?.data?.data ?? response?.data?.result ?? response?.data ?? {};
    const providerStatus = normalizeVerificationStatus(
      providerData?.status ?? providerData?.decision ?? providerData?.verification_status
    );
    const providerRequestId = parseOptionalText(
      providerData?.request_id ?? providerData?.requestId ?? providerData?.id,
      255
    );
    const providerName = parseOptionalText(
      providerData?.provider ?? process.env.PROFILE_VERIFICATION_PROVIDER_NAME ?? "external_provider",
      120
    );

    const ageYearsFromResponse = parseNonNegativeInt(
      providerData?.age_years ?? providerData?.ageYears
    );
    const ageYearsFromDob = parseAgeFromDate(
      providerData?.dob ??
        providerData?.birth_date ??
        providerData?.birthDate ??
        providerData?.date_of_birth
    );
    const ageYears = ageYearsFromResponse ?? ageYearsFromDob;
    const minAgeYears = getMinAgeYears();
    const isAdult = toBool(providerData?.is_adult ?? providerData?.isAdult);
    const computedAdult = isAdult ?? (ageYears !== null ? ageYears >= minAgeYears : null);

    const faceMatchScore = parseFloatInRange(
      providerData?.face_match_score ?? providerData?.faceMatchScore
    );
    const livenessScore = parseFloatInRange(
      providerData?.liveness_score ?? providerData?.livenessScore
    );
    const documentConfidenceScore = parseFloatInRange(
      providerData?.document_confidence_score ??
        providerData?.documentConfidenceScore ??
        providerData?.document_score
    );
    const overallConfidenceScore = parseFloatInRange(
      providerData?.overall_confidence_score ??
        providerData?.overallConfidenceScore ??
        providerData?.confidence_score ??
        providerData?.confidenceScore
    );

    const minFace = getMinFaceMatchScore();
    const minOverall = getMinOverallConfidenceScore();
    const minLiveness = getMinLivenessScore();
    const requireLiveness = isLivenessRequired();

    const hasMinimumSignals =
      computedAdult === true &&
      faceMatchScore !== null &&
      overallConfidenceScore !== null;
    const meetsScoreThresholds =
      hasMinimumSignals &&
      faceMatchScore >= minFace &&
      overallConfidenceScore >= minOverall &&
      (!requireLiveness || (livenessScore !== null && livenessScore >= minLiveness));

    if (providerStatus === STATUS.REJECTED) {
      return {
        status: STATUS.REJECTED,
        decisionSource: "automatic",
        failureCode: parseOptionalText(
          providerData?.failure_code ?? providerData?.error_code ?? "verification_rejected",
          120
        ),
        failureReason: parseOptionalText(
          providerData?.failure_reason ?? providerData?.message ?? "Verification rejected by provider",
          255
        ),
        provider: providerName,
        providerRequestId,
        ageYears,
        isAdult: computedAdult,
        faceMatchScore,
        livenessScore,
        documentConfidenceScore,
        overallConfidenceScore,
        providerResponse: response.data ?? null,
      };
    }

    if (meetsScoreThresholds) {
      return {
        status: STATUS.APPROVED,
        decisionSource: "automatic",
        failureCode: null,
        failureReason: null,
        provider: providerName,
        providerRequestId,
        ageYears,
        isAdult: computedAdult,
        faceMatchScore,
        livenessScore,
        documentConfidenceScore,
        overallConfidenceScore,
        providerResponse: response.data ?? null,
      };
    }

    const underageDetected = computedAdult === false;
    if (underageDetected) {
      return {
        status: STATUS.REJECTED,
        decisionSource: "automatic",
        failureCode: "underage",
        failureReason: `User does not meet minimum age requirement (${minAgeYears}+).`,
        provider: providerName,
        providerRequestId,
        ageYears,
        isAdult: computedAdult,
        faceMatchScore,
        livenessScore,
        documentConfidenceScore,
        overallConfidenceScore,
        providerResponse: response.data ?? null,
      };
    }

    return {
      status: STATUS.MANUAL_REVIEW,
      decisionSource: "automatic_fallback",
      failureCode: "insufficient_confidence",
      failureReason:
        "Automatic validation did not meet confidence thresholds. Sent to manual review.",
      provider: providerName,
      providerRequestId,
      ageYears,
      isAdult: computedAdult,
      faceMatchScore,
      livenessScore,
      documentConfidenceScore,
      overallConfidenceScore,
      providerResponse: response.data ?? null,
    };
  } catch (error: any) {
    return {
      status: STATUS.MANUAL_REVIEW,
      decisionSource: "automatic_error_fallback",
      failureCode: "provider_error",
      failureReason: parseOptionalText(error?.message, 255) ?? "Provider call failed",
      provider: parseOptionalText(process.env.PROFILE_VERIFICATION_PROVIDER_NAME, 120),
      providerRequestId: null,
      ageYears: null,
      isAdult: null,
      faceMatchScore: null,
      livenessScore: null,
      documentConfidenceScore: null,
      overallConfidenceScore: null,
      providerResponse: {
        message: String(error?.message ?? "provider error"),
        status: Number(error?.response?.status ?? 0) || null,
        data: error?.response?.data ?? null,
      },
    };
  }
};

const updateUserVerificationState = async ({
  userId,
  status,
  failureReason,
  reviewerUserId,
}: {
  userId: number;
  status: string;
  failureReason: string | null;
  reviewerUserId?: number | null;
}) => {
  const now = new Date();
  const isApproved = status === STATUS.APPROVED;
  const isTerminalDecision = status === STATUS.APPROVED || status === STATUS.REJECTED;
  const body: any = {
    profile_verified: isApproved,
    profile_verification_status: status,
    profile_verification_failure_reason: failureReason,
    profile_verification_reviewed_at: isTerminalDecision ? now : null,
    profile_verification_reviewed_by: isTerminalDecision ? reviewerUserId ?? null : null,
  };

  if (isApproved) {
    body.profile_verified_at = now;
  } else {
    body.profile_verified_at = null;
  }

  await User.update(body, {
    where: {
      id: userId,
    },
  });
};

const emitVerificationUserRealtime = async (userId: number) => {
  try {
    await emitProfileUpdatedRealtime({
      userId,
      includeRelatedUsers: true,
      emitChatsRefresh: false,
      action: "profile_verification_updated",
    });
  } catch (error) {
    console.error("[profile-verification] emit realtime error", error);
  }
};

export const submit_profile_verification = async (req: Request, res: Response) => {
  try {
    const userId = parsePositiveInt((req as any)?.userId);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "authentication required",
      });
    }

    const user = await User.findOne({
      where: {
        id: userId,
        available: true,
        disabled: false,
        is_deleted: false,
      },
      attributes: [
        "id",
        "birthday",
        "profile_verified",
        "profile_verification_status",
      ],
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "user not found",
      });
    }

    if (Boolean((user as any)?.profile_verified)) {
      return res.status(200).json({
        success: true,
        data: {
          profile_verified: true,
          profile_verification_status: STATUS.APPROVED,
          message: "profile already verified",
        },
      });
    }

    const selfieImageId = normalizeImageId(
      (req.body as any)?.selfie_image_id ?? (req.body as any)?.selfieImageId
    );
    const documentFrontImageId = normalizeImageId(
      (req.body as any)?.document_front_image_id ?? (req.body as any)?.documentFrontImageId
    );
    const documentBackImageId = normalizeImageId(
      (req.body as any)?.document_back_image_id ?? (req.body as any)?.documentBackImageId
    );
    const selfieWithDocumentImageId = normalizeImageId(
      (req.body as any)?.selfie_with_document_image_id ??
        (req.body as any)?.selfieWithDocumentImageId
    );
    const docType = parseOptionalText(
      (req.body as any)?.doc_type ?? (req.body as any)?.docType,
      40
    );
    const docCountry = parseOptionalText(
      (req.body as any)?.doc_country ?? (req.body as any)?.docCountry,
      16
    );

    if (
      !selfieImageId ||
      !documentFrontImageId ||
      !documentBackImageId ||
      !selfieWithDocumentImageId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "selfie_image_id, document_front_image_id, document_back_image_id and selfie_with_document_image_id are required",
      });
    }

    const latestRequestForUser = await ProfileVerificationRequest.findOne({
      where: { userId },
      order: [
        ["id", "DESC"],
      ],
    });
    const previousAttempt = parsePositiveInt((latestRequestForUser as any)?.attemptNumber) ?? 0;
    const attemptNumber = previousAttempt + 1;
    const submittedAt = new Date();

    await User.update(
      {
        profile_verification_status: STATUS.PROCESSING,
        profile_verification_last_submitted_at: submittedAt,
        profile_verification_failure_reason: null,
      },
      { where: { id: userId } }
    );

    let requestRow: any = latestRequestForUser;
    if (requestRow) {
      await requestRow.update({
        status: STATUS.PROCESSING,
        decisionSource: "system",
        attemptNumber,
        provider: null,
        providerRequestId: null,
        selfieImageId,
        documentFrontImageId,
        documentBackImageId,
        selfieWithDocumentImageId,
        docType,
        docCountry,
        ageYears: null,
        isAdult: null,
        faceMatchScore: null,
        livenessScore: null,
        documentConfidenceScore: null,
        overallConfidenceScore: null,
        failureCode: null,
        failureReason: null,
        autoDecisionAt: null,
        reviewedByUserId: null,
        reviewedAt: null,
        submittedAt,
        providerResponse: null,
        meta: {
          source: "mobile_app",
          replaced_previous_submission: true,
        },
      });

      await ProfileVerificationRequest.update(
        {
          status: STATUS.SUPERSEDED,
          decisionSource: "system_superseded",
          failureCode: "superseded_by_new_submission",
          failureReason: "Replaced by a newer verification submission.",
          reviewedAt: submittedAt,
          reviewedByUserId: null,
        },
        {
          where: {
            userId,
            id: {
              [Op.ne]: parsePositiveInt((requestRow as any)?.id) ?? 0,
            },
            status: {
              [Op.in]: [
                STATUS.PENDING,
                STATUS.PROCESSING,
                STATUS.MANUAL_REVIEW,
              ],
            },
          },
        }
      );
    } else {
      requestRow = await ProfileVerificationRequest.create({
        userId,
        status: STATUS.PROCESSING,
        decisionSource: "system",
        attemptNumber,
        selfieImageId,
        documentFrontImageId,
        documentBackImageId,
        selfieWithDocumentImageId,
        docType,
        docCountry,
        submittedAt,
        meta: {
          source: "mobile_app",
        },
      });
    }

    let autoDecision: AutoDecision = await evaluateAutomaticDecision({
      req,
      user,
      input: {
        selfieImageId,
        documentFrontImageId,
        documentBackImageId,
        selfieWithDocumentImageId,
        docType,
        docCountry,
      },
    });

    // Seguridad: el modo local (sin proveedor de identidad) no puede aprobar perfiles.
    // Si se usa local_automatic, forzamos revisión manual para evitar verificaciones
    // sin huellas fuertes de identidad (document/person fingerprint).
    if (
      autoDecision.status === STATUS.APPROVED &&
      String(autoDecision.decisionSource ?? "").trim().toLowerCase() === "automatic_local"
    ) {
      autoDecision = {
        ...autoDecision,
        status: STATUS.MANUAL_REVIEW,
        decisionSource: "automatic_local_manual_review",
        failureCode: "identity_provider_required",
        failureReason:
          "Local automatic mode cannot approve verification without strong identity signals. Sent to manual review.",
      };
    }

    const identitySignals = extractIdentitySignals({
      providerResponse: autoDecision.providerResponse,
      reqBody: req.body as any,
      docTypeFallback: docType,
      docCountryFallback: docCountry,
      user,
    });

    const duplicateIdentity = await findDuplicateIdentityForAnotherUser({
      userId,
      documentFingerprint: identitySignals.documentFingerprint,
      personFingerprint: identitySignals.personFingerprint,
      nameFingerprint: identitySignals.nameFingerprint,
      includeWeakNameSignal: true,
    });
    const conflictingUserSummary = duplicateIdentity?.conflictingUserId
      ? await getUserSummaryForAdminNote(duplicateIdentity.conflictingUserId)
      : null;

    if (duplicateIdentity) {
      const duplicateIsDocument = duplicateIdentity.kind === "document";
      const duplicateIsWeakName = duplicateIdentity.kind === "name";

      if (duplicateIsWeakName) {
        autoDecision = {
          ...autoDecision,
          status: STATUS.MANUAL_REVIEW,
          decisionSource: "automatic_possible_duplicate_identity",
          failureCode: "possible_duplicate_identity",
          failureReason: pickMessage(
            req,
            VERIFICATION_MESSAGES.POSSIBLE_DUPLICATE_IDENTITY_ES,
            VERIFICATION_MESSAGES.POSSIBLE_DUPLICATE_IDENTITY_EN
          ),
        };
      } else {
        autoDecision = {
          ...autoDecision,
          status: STATUS.REJECTED,
          decisionSource: "automatic_duplicate_identity",
          failureCode: duplicateIsDocument ? "duplicate_document" : "duplicate_person_identity",
          failureReason: pickMessage(
            req,
            duplicateIsDocument
              ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_ES
              : VERIFICATION_MESSAGES.DUPLICATE_PERSON_ES,
            duplicateIsDocument
              ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_EN
              : VERIFICATION_MESSAGES.DUPLICATE_PERSON_EN
          ),
        };
      }
    }

    const requestIdentityMeta = {
      document_fingerprint: identitySignals.documentFingerprint,
      person_fingerprint: identitySignals.personFingerprint,
      name_fingerprint: identitySignals.nameFingerprint,
      document_last4: identitySignals.documentLast4,
      doc_type: identitySignals.docType,
      doc_country: identitySignals.docCountry,
      duplicate_detected: duplicateIdentity ? duplicateIdentity.kind : null,
      duplicate_user_id: duplicateIdentity?.conflictingUserId ?? null,
      duplicate_username: conflictingUserSummary?.username ?? null,
      duplicate_name: `${conflictingUserSummary?.name ?? ""} ${conflictingUserSummary?.last_name ?? ""}`.trim() || null,
    };

    const hasIdentitySignalsForDedup = Boolean(
      identitySignals.documentFingerprint || identitySignals.personFingerprint
    );
    if (
      autoDecision.status === STATUS.APPROVED &&
      isIdentitySignalRequiredForAutoApproval() &&
      !hasIdentitySignalsForDedup
    ) {
      autoDecision = {
        ...autoDecision,
        status: STATUS.MANUAL_REVIEW,
        decisionSource: "automatic_identity_signal_fallback",
        failureCode: "identity_signals_missing",
        failureReason:
          "Automatic identity signals missing (document/person key). Sent to manual review.",
      };
    }

    const requestId = parsePositiveInt((requestRow as any)?.id);
    const adminReviewNote =
      autoDecision.status === STATUS.MANUAL_REVIEW
        ? buildAdminReviewNote({
            requestId,
            userId,
            decisionSource: autoDecision.decisionSource,
            failureCode: autoDecision.failureCode,
            failureReason: autoDecision.failureReason,
            duplicateIdentity,
            conflictingUser: conflictingUserSummary,
          })
        : null;

    if (autoDecision.status === STATUS.APPROVED) {
      try {
        await upsertIdentityForUser({
          userId,
          requestId: parsePositiveInt((requestRow as any)?.id),
          status: "active",
          decisionSource: autoDecision.decisionSource,
          provider: autoDecision.provider,
          identity: identitySignals,
        });
      } catch (error: any) {
        const message = String(error?.message ?? "").toLowerCase();
        const duplicateConstraint =
          String(error?.name ?? "").toLowerCase().includes("uniqueconstraint") ||
          String(error?.code ?? "").toLowerCase().includes("duplicate") ||
          message.includes("duplicate");
        if (!duplicateConstraint) throw error;

        const duplicateOnDocument = message.includes("document");
        autoDecision = {
          ...autoDecision,
          status: STATUS.REJECTED,
          decisionSource: "automatic_duplicate_identity_race",
          failureCode: duplicateOnDocument
            ? "duplicate_document"
            : "duplicate_person_identity",
          failureReason: pickMessage(
            req,
            duplicateOnDocument
              ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_ES
              : VERIFICATION_MESSAGES.DUPLICATE_PERSON_ES,
            duplicateOnDocument
              ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_EN
              : VERIFICATION_MESSAGES.DUPLICATE_PERSON_EN
          ),
        };
      }
    }

    await requestRow.update({
      status: autoDecision.status,
      decisionSource: autoDecision.decisionSource,
      provider: autoDecision.provider,
      providerRequestId: autoDecision.providerRequestId,
      ageYears: autoDecision.ageYears,
      isAdult: autoDecision.isAdult,
      faceMatchScore: autoDecision.faceMatchScore,
      livenessScore: autoDecision.livenessScore,
      documentConfidenceScore: autoDecision.documentConfidenceScore,
      overallConfidenceScore: autoDecision.overallConfidenceScore,
      failureCode: autoDecision.failureCode,
      failureReason: autoDecision.failureReason,
      autoDecisionAt: new Date(),
      providerResponse: autoDecision.providerResponse,
      meta: {
        source: "mobile_app",
        identity: requestIdentityMeta,
        admin_review_note: adminReviewNote,
        admin_review_context: {
          duplicate_kind: duplicateIdentity?.kind ?? null,
          duplicate_user_id: duplicateIdentity?.conflictingUserId ?? null,
          duplicate_username: conflictingUserSummary?.username ?? null,
        },
      },
    });

    await updateUserVerificationState({
      userId,
      status: autoDecision.status,
      failureReason: autoDecision.failureReason,
      reviewerUserId: null,
    });

    await emitVerificationUserRealtime(userId);

    writeSecurityAuditFromRequest(req, {
      event: "user.profile_verification.submit",
      level: autoDecision.status === STATUS.APPROVED ? "info" : "warn",
      actorUserId: userId,
      targetUserId: userId,
      success: autoDecision.status === STATUS.APPROVED,
      reason: autoDecision.failureCode ?? autoDecision.status,
      meta: {
        requestId: Number((requestRow as any)?.id ?? 0) || null,
        status: autoDecision.status,
        decisionSource: autoDecision.decisionSource,
        provider: autoDecision.provider,
        adminReviewNote,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        request_id: Number((requestRow as any)?.id ?? 0) || null,
        status: autoDecision.status,
        profile_verified: autoDecision.status === STATUS.APPROVED,
        profile_verification_status: autoDecision.status,
        can_submit_new_documents: autoDecision.status !== STATUS.APPROVED,
        failure_code: autoDecision.failureCode,
        failure_reason: autoDecision.failureReason,
        attempt_number: attemptNumber,
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] submit error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};

export const get_profile_verification_status = async (req: Request, res: Response) => {
  try {
    const userId = parsePositiveInt((req as any)?.userId);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "authentication required",
      });
    }

    const user = await User.findOne({
      where: {
        id: userId,
        available: true,
        disabled: false,
        is_deleted: false,
      },
      attributes: [
        "id",
        "profile_verified",
        "profile_verification_status",
        "profile_verified_at",
        "profile_verification_last_submitted_at",
        "profile_verification_failure_reason",
        "profile_verification_reviewed_at",
        "profile_verification_reviewed_by",
      ],
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "user not found",
      });
    }

    const lastRequest = await ProfileVerificationRequest.findOne({
      where: { userId },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });

    const profileVerified = Boolean((user as any)?.profile_verified);
    const profileVerificationStatus =
      parseOptionalText((user as any)?.profile_verification_status, 32) || STATUS.UNVERIFIED;
    const isApprovedState =
      profileVerified && String(profileVerificationStatus).trim().toLowerCase() === STATUS.APPROVED;

    return res.status(200).json({
      success: true,
      data: {
        user_id: userId,
        profile_verified: profileVerified,
        profile_verification_status: profileVerificationStatus,
        can_submit_new_documents: !profileVerified,
        profile_verified_at: (user as any)?.profile_verified_at
          ? new Date((user as any).profile_verified_at).toISOString()
          : null,
        // Backward-compatibility guard:
        // only expose last submitted timestamp for approved profiles to avoid
        // clients inferring "verified badge" from document submission activity.
        profile_verification_last_submitted_at:
          isApprovedState && (user as any)?.profile_verification_last_submitted_at
            ? new Date((user as any).profile_verification_last_submitted_at).toISOString()
            : null,
        profile_verification_failure_reason:
          parseOptionalText((user as any)?.profile_verification_failure_reason, 255) ?? null,
        profile_verification_reviewed_at: (user as any)?.profile_verification_reviewed_at
          ? new Date((user as any).profile_verification_reviewed_at).toISOString()
          : null,
        profile_verification_reviewed_by:
          parsePositiveInt((user as any)?.profile_verification_reviewed_by) ?? null,
        latest_request: lastRequest
          ? sanitizeQueueItem(lastRequest, {
              includeImages: isApprovedState,
            })
          : null,
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] status error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};

export const admin_list_profile_verification_queue = async (req: Request, res: Response) => {
  try {
    const page = parsePositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = parsePositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;

    const statusQuery = parseOptionalText((req.query as any)?.status, 100);
    const statuses = statusQuery
      ? statusQuery
          .split(",")
          .map((value) => normalizeVerificationStatus(value))
          .filter((value): value is string => Boolean(value))
      : [STATUS.MANUAL_REVIEW, STATUS.PENDING, STATUS.PROCESSING];

    const where: any = {};
    if (statuses.length) where.status = { [Op.in]: statuses };

    const rows = await ProfileVerificationRequest.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "user",
          required: true,
          where: {
            [Op.and]: [
              {
                [Op.or]: [
                  { profile_verified: { [Op.ne]: true } },
                  { profile_verified: { [Op.is]: null } },
                ],
              },
              {
                [Op.or]: [
                  { profile_verification_status: { [Op.ne]: STATUS.APPROVED } },
                  { profile_verification_status: { [Op.is]: null } },
                ],
              },
            ],
          },
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
        },
      ],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
    });

    return res.status(200).json({
      success: true,
      data: {
        page,
        limit,
        count: Number(rows.count ?? 0) || 0,
        requests: (Array.isArray(rows.rows) ? rows.rows : []).map((row) =>
          sanitizeQueueItem(row)
        ),
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] admin list error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};

export const admin_review_profile_verification_request = async (
  req: Request,
  res: Response
) => {
  try {
    const actorUserId = parsePositiveInt((req as any)?.userId);
    const requestId = parsePositiveInt((req.params as any)?.requestId);
    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "requestId must be a valid number",
      });
    }

    const action = String((req.body as any)?.action ?? "")
      .trim()
      .toLowerCase();
    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({
        success: false,
        message: "action must be approve or reject",
      });
    }

    const reason = parseOptionalText((req.body as any)?.reason, 255);
    const forceApprove =
      toBool((req.body as any)?.force_approve ?? (req.body as any)?.forceApprove) === true;

    const requestRow = await ProfileVerificationRequest.findOne({
      where: { id: requestId },
    });
    if (!requestRow) {
      return res.status(404).json({
        success: false,
        message: "verification request not found",
      });
    }

    const userId = parsePositiveInt((requestRow as any)?.userId);
    if (!userId) {
      return res.status(409).json({
        success: false,
        message: "invalid user in verification request",
      });
    }

    const nextStatus = action === "approve" ? STATUS.APPROVED : STATUS.REJECTED;
    const failureCode = action === "approve" ? null : "manual_rejected";
    const failureReason =
      action === "approve"
        ? null
        : reason ?? "Rejected by manual verification review";
    const manualDecisionNote = buildAdminReviewNote({
      requestId,
      userId,
      decisionSource: action === "approve" ? "manual_admin" : "manual_admin_reject",
      failureCode,
      failureReason: reason ?? failureReason,
    });
    const previousMeta =
      (requestRow as any)?.meta && typeof (requestRow as any).meta === "object"
        ? { ...(requestRow as any).meta }
        : {};

    let approvalIdentitySignals: IdentitySignals | null = null;
    let usedForceApprove = false;
    if (action === "approve") {
      const identitySignals = extractIdentitySignalsFromRequestRow(requestRow);
      approvalIdentitySignals = identitySignals;
      const hasStrongIdentitySignals = Boolean(
        identitySignals.documentFingerprint || identitySignals.personFingerprint
      );
      if (!hasStrongIdentitySignals) {
        const hasMediaEvidence = hasVerificationMediaEvidence(requestRow);
        if (!forceApprove && !hasMediaEvidence) {
          return res.status(409).json({
            success: false,
            message: pickMessage(
              req,
              VERIFICATION_MESSAGES.IDENTITY_SIGNALS_REQUIRED_ES,
              VERIFICATION_MESSAGES.IDENTITY_SIGNALS_REQUIRED_EN
            ),
            data: {
              failure_code: "identity_signals_missing",
            },
          });
        }
        usedForceApprove = true;
      }

      if (hasStrongIdentitySignals) {
        const duplicateIdentity = await findDuplicateIdentityForAnotherUser({
          userId,
          documentFingerprint: identitySignals.documentFingerprint,
          personFingerprint: identitySignals.personFingerprint,
        });
        if (duplicateIdentity) {
          const duplicateIsDocument = duplicateIdentity.kind === "document";
          return res.status(409).json({
            success: false,
            message: duplicateIsDocument
              ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_EN
              : VERIFICATION_MESSAGES.DUPLICATE_PERSON_EN,
            data: {
              failure_code: duplicateIsDocument
                ? "duplicate_document"
                : "duplicate_person_identity",
              conflicting_user_id: duplicateIdentity.conflictingUserId ?? null,
            },
          });
        }
      }
    }

    await requestRow.update({
      status: nextStatus,
      decisionSource:
        action === "approve" && usedForceApprove
          ? "manual_admin_force_approve"
          : "manual_admin",
      failureCode,
      failureReason,
      reviewedByUserId: actorUserId ?? null,
      reviewedAt: new Date(),
      autoDecisionAt: new Date(),
      meta: {
        ...previousMeta,
        admin_review_note: manualDecisionNote,
        admin_review_context: {
          ...(previousMeta as any)?.admin_review_context,
          reviewed_by_admin_user_id: actorUserId ?? null,
          manual_action: action,
          manual_force_approve: usedForceApprove,
        },
      },
    });

    await updateUserVerificationState({
      userId,
      status: nextStatus,
      failureReason,
      reviewerUserId: actorUserId ?? null,
    });

    if (action === "approve") {
      try {
        await upsertIdentityForUser({
          userId,
          requestId,
          status: "active",
          decisionSource: "manual_admin",
          provider: parseOptionalText((requestRow as any)?.provider, 120),
          identity:
            approvalIdentitySignals ?? extractIdentitySignalsFromRequestRow(requestRow),
        });
      } catch (error: any) {
        const message = String(error?.message ?? "").toLowerCase();
        const duplicateConstraint =
          String(error?.name ?? "").toLowerCase().includes("uniqueconstraint") ||
          String(error?.code ?? "").toLowerCase().includes("duplicate") ||
          message.includes("duplicate");
        if (!duplicateConstraint) throw error;
        return res.status(409).json({
          success: false,
          message: message.includes("document")
            ? VERIFICATION_MESSAGES.DUPLICATE_DOCUMENT_EN
            : VERIFICATION_MESSAGES.DUPLICATE_PERSON_EN,
          data: {
            failure_code: message.includes("document")
              ? "duplicate_document"
              : "duplicate_person_identity",
          },
        });
      }
    }

    await emitVerificationUserRealtime(userId);

    writeSecurityAuditFromRequest(req, {
      event: "admin.profile_verification.review",
      level: action === "approve" ? "info" : "warn",
      actorUserId: actorUserId ?? null,
      targetUserId: userId,
      success: action === "approve",
      reason: failureCode ?? "manual_approved",
      meta: {
        requestId,
        action,
        force_approve: usedForceApprove,
        failureReason,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        request_id: requestId,
        user_id: userId,
        status: nextStatus,
        profile_verified: nextStatus === STATUS.APPROVED,
        can_submit_new_documents: nextStatus !== STATUS.APPROVED,
        force_approved: action === "approve" ? usedForceApprove : false,
        failure_reason: failureReason,
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] admin review error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};

export const admin_revoke_profile_verification = async (
  req: Request,
  res: Response
) => {
  try {
    const actorUserId = parsePositiveInt((req as any)?.userId);
    const userId = parsePositiveInt((req.params as any)?.userId);
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId must be a valid number",
      });
    }

    const reason =
      parseOptionalText((req.body as any)?.reason, 255) ??
      "Verification badge revoked by admin";

    const user = await User.findOne({
      where: { id: userId },
      attributes: ["id", "profile_verified", "profile_verification_status"],
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "user not found",
      });
    }

    // Revocar badge NO borra evidencias enviadas (fotos/documentos).
    // Se conserva trazabilidad para revisión futura.
    await User.update(
      {
        profile_verified: false,
        profile_verification_status: STATUS.UNVERIFIED,
        profile_verified_at: null,
        profile_verification_failure_reason: null,
        profile_verification_reviewed_at: null,
        profile_verification_reviewed_by: null,
      },
      { where: { id: userId } }
    );

    const [updatedVerificationRequests] = await ProfileVerificationRequest.update(
      {
        status: STATUS.REJECTED,
        decisionSource: "manual_admin_revoke",
        failureCode: "revoked_by_admin",
        failureReason: reason,
        reviewedByUserId: actorUserId ?? null,
        reviewedAt: new Date(),
        meta: {
          admin_review_note: `revoke | user_id=${userId} | reason=${reason}`,
          admin_review_context: {
            manual_action: "revoke",
            reviewed_by_admin_user_id: actorUserId ?? null,
          },
        },
      },
      {
        where: {
          userId,
          status: {
            [Op.in]: [
              STATUS.APPROVED,
              STATUS.PENDING,
              STATUS.PROCESSING,
              STATUS.MANUAL_REVIEW,
            ],
          },
        },
      }
    );

    const [updatedVerificationIdentities] = await ProfileVerificationIdentity.update(
      {
        status: "revoked",
        decisionSource: "manual_admin_revoke",
      },
      { where: { userId } }
    );

    await emitVerificationUserRealtime(userId);

    writeSecurityAuditFromRequest(req, {
      event: "admin.profile_verification.revoke",
      level: "warn",
      actorUserId: actorUserId ?? null,
      targetUserId: userId,
      success: true,
      reason: "admin_revoked",
      meta: {
        reason,
        updated_verification_requests: updatedVerificationRequests,
        updated_verification_identities: updatedVerificationIdentities,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        user_id: userId,
        profile_verified: false,
        profile_verification_status: STATUS.UNVERIFIED,
        can_submit_new_documents: true,
        reason,
        evidences_retained: true,
        updated_verification_requests: updatedVerificationRequests,
        updated_verification_identities: updatedVerificationIdentities,
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] admin revoke error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};

export const admin_force_approve_profile_verification = async (
  req: Request,
  res: Response
) => {
  try {
    const actorUserId = parsePositiveInt((req as any)?.userId);
    const userId = parsePositiveInt((req.params as any)?.userId);
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId must be a valid number",
      });
    }

    const reason =
      parseOptionalText((req.body as any)?.reason, 255) ??
      "Approved by admin without verification documents";

    const user = await User.findOne({
      where: { id: userId },
      attributes: ["id", "profile_verified", "profile_verification_status"],
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "user not found",
      });
    }

    const lastRequest = await ProfileVerificationRequest.findOne({
      where: { userId },
      order: [
        ["id", "DESC"],
      ],
    });

    if (lastRequest) {
      const previousMeta =
        (lastRequest as any)?.meta && typeof (lastRequest as any).meta === "object"
          ? { ...(lastRequest as any).meta }
          : {};
      await lastRequest.update({
        status: STATUS.APPROVED,
        decisionSource: "manual_admin_force_no_docs",
        failureCode: null,
        failureReason: null,
        reviewedByUserId: actorUserId ?? null,
        reviewedAt: new Date(),
        autoDecisionAt: new Date(),
        meta: {
          ...previousMeta,
          admin_review_note: `force_approve_without_docs | user_id=${userId} | reason=${reason}`,
          admin_review_context: {
            ...(previousMeta as any)?.admin_review_context,
            manual_action: "force_approve_without_docs",
            reviewed_by_admin_user_id: actorUserId ?? null,
          },
        },
      });
    }

    await updateUserVerificationState({
      userId,
      status: STATUS.APPROVED,
      failureReason: null,
      reviewerUserId: actorUserId ?? null,
    });

    await emitVerificationUserRealtime(userId);

    writeSecurityAuditFromRequest(req, {
      event: "admin.profile_verification.force_approve",
      level: "warn",
      actorUserId: actorUserId ?? null,
      targetUserId: userId,
      success: true,
      reason: "manual_force_approve_without_documents",
      meta: {
        has_verification_request: Boolean(lastRequest),
        reason,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        user_id: userId,
        profile_verified: true,
        profile_verification_status: STATUS.APPROVED,
        can_submit_new_documents: false,
        approved_without_documents: !lastRequest,
        reason,
      },
    });
  } catch (error: any) {
    console.error("[profile-verification] admin force approve error", error);
    return res.status(500).json({
      success: false,
      message: error?.message ?? "internal server error",
    });
  }
};
