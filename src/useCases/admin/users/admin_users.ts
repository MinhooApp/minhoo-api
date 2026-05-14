import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../../user/_module/module";
import { readJsonFile } from "../../catalog/_module/module";
import { writeSecurityAuditFromRequest } from "../../../libs/security/security_audit_log";
import ProfileVerificationRequest from "../../../_models/user/profile_verification_request";
import * as followerRepository from "../../../repository/follower/follower_repository";
import * as chatRepository from "../../../repository/chat/chat_repository";
import Post from "../../../_models/post/post";
import MediaPost from "../../../_models/post/media_post";
import Comment from "../../../_models/comment/comment";
import User from "../../../_models/user/user";
import Message from "../../../_models/chat/message";
import Reel from "../../../_models/reel/reel";
import ReelComment from "../../../_models/reel/reel_comment";
import Service from "../../../_models/service/service";
import Offer from "../../../_models/offer/offer";
import Worker from "../../../_models/worker/worker";
import Category from "../../../_models/category/category";
import StatusService from "../../../_models/status/statusService";
import { TypeNotification } from "../../../_models/notification/type_notification";
import { buildServiceRoutingFields } from "../../../libs/service_client_bucket";
import {
  emitChatMessageRealtime,
  emitChatStatusRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { enqueuePushJob } from "../../../libs/jobs/push_queue";
import sequelize from "../../../_db/connection";
import { Sequelize, Op, QueryTypes } from "sequelize";
import { deletePostAdmin as deletePostAdminUseCase } from "../../post/delete/delete";
import { sendNotification } from "../../notification/add/add";
import { invalidateChatSummaryCacheByUser } from "../../chat/get/get";
import {
  serializeMessageToCanonical,
} from "../../chat/_shared/message_contract";
import {
  buildMessagePayload,
  resolveClientMessageIdFromRequest,
} from "../../chat/add/add";

const toOptionalPositiveInt = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "Authorization, Cookie");
};

const MIN_PUSH_TOKEN_LENGTH = Math.max(
  20,
  Number(process.env.PUSH_MIN_TOKEN_LENGTH ?? 100) || 100
);
const MAX_PUSH_TOKENS_PER_USER = Math.max(
  1,
  Number(process.env.PUSH_MAX_TOKENS_PER_USER ?? 10) || 10
);

const toIsoOrNull = (value: any) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toDateOnlyOrNull = (value: any) => {
  const iso = toIsoOrNull(value);
  return iso ? iso.slice(0, 10) : null;
};

const resolvePublicBaseUrl = (req: Request) => {
  const forwardedProto = String(req.header("x-forwarded-proto") ?? "")
    .trim()
    .toLowerCase();
  const protocol = forwardedProto || req.protocol || "https";
  const host = String(req.header("x-forwarded-host") ?? req.get("host") ?? "").trim();
  if (!host) return "";
  return `${protocol}://${host}`;
};

const buildImagePlaybackUrl = (req: Request, imageIdRaw: any) => {
  const imageId = String(imageIdRaw ?? "").trim();
  if (!imageId) return null;
  const path = `/api/v1/media/image/play?id=${encodeURIComponent(imageId)}`;
  const baseUrl = resolvePublicBaseUrl(req);
  return baseUrl ? `${baseUrl}${path}` : path;
};

const normalizeAdminVerificationRequest = (req: Request, rowRaw: any) => {
  if (!rowRaw) return null;
  const row = typeof rowRaw?.toJSON === "function" ? rowRaw.toJSON() : rowRaw;
  const selfieImageId = String(row?.selfieImageId ?? "").trim() || null;
  const documentFrontImageId = String(row?.documentFrontImageId ?? "").trim() || null;
  const documentBackImageId = String(row?.documentBackImageId ?? "").trim() || null;
  const selfieWithDocumentImageId =
    String(row?.selfieWithDocumentImageId ?? "").trim() || null;

  return {
    id: Number(row?.id ?? 0) || null,
    user_id: Number(row?.userId ?? 0) || null,
    status: String(row?.status ?? "").trim() || null,
    decision_source: String(row?.decisionSource ?? "").trim() || null,
    failure_code: String(row?.failureCode ?? "").trim() || null,
    failure_reason: String(row?.failureReason ?? "").trim() || null,
    attempt_number: Number(row?.attemptNumber ?? 0) || null,
    submitted_at: toIsoOrNull(row?.submittedAt),
    reviewed_at: toIsoOrNull(row?.reviewedAt),
    reviewed_by_user_id: toOptionalPositiveInt(row?.reviewedByUserId),
    doc_type: String(row?.docType ?? "").trim() || null,
    doc_country: String(row?.docCountry ?? "").trim() || null,
    images: {
      selfie_image_id: selfieImageId,
      document_front_image_id: documentFrontImageId,
      document_back_image_id: documentBackImageId,
      selfie_with_document_image_id: selfieWithDocumentImageId,
      selfie_url: buildImagePlaybackUrl(req, selfieImageId),
      document_front_url: buildImagePlaybackUrl(req, documentFrontImageId),
      document_back_url: buildImagePlaybackUrl(req, documentBackImageId),
      selfie_with_document_url: buildImagePlaybackUrl(req, selfieWithDocumentImageId),
    },
    provider_response: row?.providerResponse ?? null,
    meta: row?.meta ?? null,
  };
};

const computeAgeYears = (birthdayRaw: any, nowRef: Date = new Date()) => {
  if (birthdayRaw === null || birthdayRaw === undefined || String(birthdayRaw).trim() === "") {
    return null;
  }
  const birthday = new Date(birthdayRaw);
  if (Number.isNaN(birthday.getTime())) return null;

  let age = nowRef.getUTCFullYear() - birthday.getUTCFullYear();
  const monthDiff = nowRef.getUTCMonth() - birthday.getUTCMonth();
  const dayDiff = nowRef.getUTCDate() - birthday.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
  if (!Number.isFinite(age) || age < 0) return null;
  return age;
};

const parsePositiveIntStrict = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const parseQueryBool = (value: any, fallback = false) => {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const truncateText = (value: any, max = 160) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
};

const extractUniqueMatches = (textRaw: string, pattern: RegExp): string[] => {
  const text = String(textRaw ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const value = String(match?.[0] ?? "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
};

const extractPostEntities = (textRaw: any) => {
  const text = String(textRaw ?? "");
  // Keep contract simple for front:
  // - hashtags include leading #
  // - mentions include leading @
  // - urls include protocol form
  const hashtags = extractUniqueMatches(text, /#[\p{L}\p{N}_]{2,64}/gu);
  const mentions = extractUniqueMatches(text, /@[\p{L}\p{N}_.]{2,64}/gu);
  const urls = extractUniqueMatches(text, /https?:\/\/[^\s<>"']+/gi);
  return {
    hashtags,
    mentions,
    urls,
  };
};

const parseAdminBirthdayInput = (reqBody: any): { birthday: Date | null; error: string | null } => {
  const clear =
    reqBody?.clear_birthdate === true ||
    String(reqBody?.clear_birthdate ?? "").trim().toLowerCase() === "true" ||
    String(reqBody?.clear_birthdate ?? "").trim() === "1";
  if (clear) return { birthday: null, error: null };

  const birthdayRaw =
    reqBody?.birthday ??
    reqBody?.birth_date ??
    reqBody?.date_of_birth ??
    null;

  if (birthdayRaw !== null && birthdayRaw !== undefined && String(birthdayRaw).trim() !== "") {
    const parsed = new Date(String(birthdayRaw).trim());
    if (Number.isNaN(parsed.getTime())) {
      return { birthday: null, error: "birthday must be a valid date (YYYY-MM-DD)" };
    }
    const now = new Date();
    if (parsed.getTime() > now.getTime()) {
      return { birthday: null, error: "birthday cannot be in the future" };
    }
    const age = computeAgeYears(parsed, now);
    if (age === null || age > 120) {
      return { birthday: null, error: "birthday is out of allowed range" };
    }
    return { birthday: parsed, error: null };
  }

  const ageYears =
    parsePositiveIntStrict(reqBody?.age_years) ??
    parsePositiveIntStrict(reqBody?.ageYears);
  if (ageYears !== null) {
    if (ageYears > 120) {
      return { birthday: null, error: "age_years is out of allowed range" };
    }
    const now = new Date();
    const guessed = new Date(Date.UTC(
      now.getUTCFullYear() - ageYears,
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    return { birthday: guessed, error: null };
  }

  return {
    birthday: null,
    error: "birthday (YYYY-MM-DD) or age_years is required",
  };
};

const toBool = (value: any) => value === true || value === 1 || value === "1";
const toNonNegativeInt = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
};

const parseAdminStatus = (
  value: any
): "all" | "active" | "disabled" | "deleted" | "directory" => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "disabled") return "disabled";
  if (normalized === "deleted") return "deleted";
  if (normalized === "directory") return "directory";
  return "all";
};

const parseAdminVerified = (value: any): "all" | "true" | "false" => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "true") return "true";
  if (normalized === "false") return "false";
  return "all";
};

const parseAdminRole = (value: any): "all" | "worker" | "client" => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "worker") return "worker";
  if (normalized === "client" || normalized === "customer") return "client";
  return "all";
};

const countriesCatalogPath = "_data/catalog/countries.json";
const statesCatalogPath = "_data/catalog/states.json";
const citiesCatalogPath = "_data/catalog/cities.json";

const toNumberOrNull = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const ADMIN_LOCATION_NULL_SENTINEL = -1;
const LOCATION_NULL_TOKENS = new Set(["null", "none", "unknown", "sin-estado", "sin_estado"]);

const parseAdminLocationFilter = (value: any): number | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (LOCATION_NULL_TOKENS.has(normalized) || normalized === "-1") {
    return ADMIN_LOCATION_NULL_SENTINEL;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const serializeAdminLocationFilter = (value: number | null) => {
  if (value === ADMIN_LOCATION_NULL_SENTINEL) return "null";
  return value ?? null;
};

const sumCounts = (rows: any[], predicate: (row: any) => boolean) =>
  (rows || []).reduce((acc, row) => {
    if (!predicate(row)) return acc;
    const count = Number((row as any)?.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) return acc;
    return acc + Math.trunc(count);
  }, 0);

const mapById = (rows: any[]) => {
  const map = new Map<number, any>();
  (rows || []).forEach((row: any) => {
    const id = toNumberOrNull((row as any)?.id);
    if (!id) return;
    map.set(id, row);
  });
  return map;
};

const normalizeLocationText = (value: any) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const buildCountryNameKey = (countryId: number, name: any) =>
  `${countryId}:${normalizeLocationText(name)}`;

const mapByCountryAndName = (
  rows: any[],
  countryField: string,
  nameField: string
) => {
  const map = new Map<string, any>();
  (rows || []).forEach((row: any) => {
    const countryId = toNumberOrNull((row as any)?.[countryField]);
    const name = String((row as any)?.[nameField] ?? "").trim();
    if (!countryId || !name) return;
    map.set(buildCountryNameKey(countryId, name), row);
  });
  return map;
};

type AdminLocationRefs = {
  countriesById: Map<number, any>;
  statesById: Map<number, any>;
  citiesById: Map<number, any>;
  statesByCountryAndName: Map<string, any>;
  citiesByCountryAndName: Map<string, any>;
};

type AdminLocationFilterValues = {
  countryId: number | null;
  stateId: number | null;
  cityId: number | null;
};

const resolveAdminLocation = (
  input: {
    countryId: number | null;
    stateId: number | null;
    cityId: number | null;
    cityNameRaw?: string | null;
  },
  locationRefs?: AdminLocationRefs | null
) => {
  const countryId = toNumberOrNull(input.countryId);
  let stateId = toNumberOrNull(input.stateId);
  let cityId = toNumberOrNull(input.cityId);
  const cityNameRaw = String(input.cityNameRaw ?? "").trim() || null;

  const countriesById = locationRefs?.countriesById;
  const statesById = locationRefs?.statesById;
  const citiesById = locationRefs?.citiesById;

  const countryCatalog = countryId ? countriesById?.get(countryId) : null;

  let stateCatalog = stateId ? statesById?.get(stateId) : null;
  if (
    stateCatalog &&
    countryId &&
    toNumberOrNull((stateCatalog as any)?.country_id) !== countryId
  ) {
    stateId = null;
    stateCatalog = null;
  }

  let cityCatalog = cityId ? citiesById?.get(cityId) : null;
  if (
    cityCatalog &&
    countryId &&
    toNumberOrNull((cityCatalog as any)?.country_id) !== countryId
  ) {
    cityId = null;
    cityCatalog = null;
  }

  if (cityCatalog) {
    cityId = toNumberOrNull((cityCatalog as any)?.id);
    const cityStateId = toNumberOrNull((cityCatalog as any)?.state_id);
    if (cityStateId) {
      stateId = cityStateId;
      stateCatalog = statesById?.get(cityStateId) ?? null;
      if (
        stateCatalog &&
        countryId &&
        toNumberOrNull((stateCatalog as any)?.country_id) !== countryId
      ) {
        stateId = null;
        stateCatalog = null;
      }
    }
  } else if (countryId && cityNameRaw) {
    const matchedCity = locationRefs?.citiesByCountryAndName?.get(
      buildCountryNameKey(countryId, cityNameRaw)
    );
    if (matchedCity) {
      cityCatalog = matchedCity;
      cityId = toNumberOrNull((matchedCity as any)?.id);
      const cityStateId = toNumberOrNull((matchedCity as any)?.state_id);
      if (cityStateId) {
        stateId = cityStateId;
        stateCatalog = statesById?.get(cityStateId) ?? null;
      }
    }
  }

  if (!stateCatalog && countryId && stateId) {
    const tentative = statesById?.get(stateId) ?? null;
    if (tentative && toNumberOrNull((tentative as any)?.country_id) === countryId) {
      stateCatalog = tentative;
    } else {
      stateId = null;
    }
  }

  const cityName = String((cityCatalog as any)?.name ?? "").trim() || cityNameRaw || null;

  return {
    countryId,
    countryName: String((countryCatalog as any)?.name ?? "").trim() || null,
    stateId: stateId ?? null,
    stateName: String((stateCatalog as any)?.name ?? "").trim() || null,
    cityId: cityId ?? null,
    cityName,
    countryIso2: String((countryCatalog as any)?.iso2 ?? "").trim() || null,
  };
};

const loadLocationCatalogRefs = () => {
  const countriesCatalog = readJsonFile(countriesCatalogPath);
  const statesCatalog = readJsonFile(statesCatalogPath);
  const citiesCatalog = readJsonFile(citiesCatalogPath);
  return {
    countriesById: mapById(countriesCatalog),
    statesById: mapById(statesCatalog),
    citiesById: mapById(citiesCatalog),
    statesByCountryAndName: mapByCountryAndName(statesCatalog, "country_id", "name"),
    citiesByCountryAndName: mapByCountryAndName(citiesCatalog, "country_id", "name"),
  };
};

const sanitizeAdminLocationFilters = (
  values: AdminLocationFilterValues,
  refs: AdminLocationRefs
): AdminLocationFilterValues => {
  let countryId = values.countryId;
  let stateId = values.stateId;
  let cityId = values.cityId;

  const countryIsNullFilter = countryId === ADMIN_LOCATION_NULL_SENTINEL;
  const stateIsNullFilter = stateId === ADMIN_LOCATION_NULL_SENTINEL;

  if (countryIsNullFilter) {
    if (stateId !== null && stateId !== ADMIN_LOCATION_NULL_SENTINEL) stateId = null;
    if (cityId !== null && cityId !== ADMIN_LOCATION_NULL_SENTINEL) cityId = null;
    return { countryId, stateId, cityId };
  }

  if (stateIsNullFilter) {
    if (cityId !== null && cityId !== ADMIN_LOCATION_NULL_SENTINEL) cityId = null;
    return { countryId, stateId, cityId };
  }

  const normalizedCountryId = toNumberOrNull(countryId);
  const normalizedStateId = toNumberOrNull(stateId);
  const normalizedCityId = toNumberOrNull(cityId);

  if (normalizedStateId) {
    const stateCatalog = refs.statesById.get(normalizedStateId);
    const stateCountryId = toNumberOrNull((stateCatalog as any)?.country_id);
    if (
      !stateCatalog ||
      (normalizedCountryId && stateCountryId && normalizedCountryId !== stateCountryId)
    ) {
      stateId = null;
    }
  }

  if (normalizedCityId) {
    const cityCatalog = refs.citiesById.get(normalizedCityId);
    const cityCountryId = toNumberOrNull((cityCatalog as any)?.country_id);
    const cityStateId = toNumberOrNull((cityCatalog as any)?.state_id);
    const effectiveStateId = toNumberOrNull(stateId);

    if (!cityCatalog) {
      cityId = null;
    } else if (normalizedCountryId && cityCountryId && normalizedCountryId !== cityCountryId) {
      cityId = null;
    } else if (effectiveStateId && cityStateId && effectiveStateId !== cityStateId) {
      // Evita "0 resultados" por city stale al cambiar de estado en el front.
      cityId = null;
    }
  }

  return { countryId, stateId, cityId };
};

const normalizeRoleItem = (roleRaw: any) => {
  if (!roleRaw) return null;
  return {
    id: Number(roleRaw?.id ?? 0) || null,
    role: String(roleRaw?.role ?? "").trim() || null,
    description: String(roleRaw?.description ?? "").trim() || null,
  };
};

const normalizeAdminUserRow = (
  userRaw: any,
  locationRefs?: AdminLocationRefs | null
) => {
  const user = typeof userRaw?.toJSON === "function" ? userRaw.toJSON() : userRaw ?? {};
  const roles = Array.isArray(user?.roles)
    ? user.roles.map(normalizeRoleItem).filter(Boolean)
    : [];
  const profileVerified = toBool(
    user?.profile_verified ?? user?.profileVerified ?? user?.verified_badge
  );
  const profileVerificationStatus = String(
    user?.profile_verification_status ?? user?.profileVerificationStatus ?? "unverified"
  )
    .trim()
    .toLowerCase();
  const resolvedLocation = resolveAdminLocation(
    {
      countryId: toNumberOrNull(user?.country_residence_id),
      stateId: toNumberOrNull(user?.state_residence_id),
      cityId: toNumberOrNull(user?.city_residence_id),
      cityNameRaw: String(user?.city_residence_name ?? "").trim() || null,
    },
    locationRefs
  );

  return {
    ...user,
    roles,
    image_profile: user?.image_profil ?? null,
    avatar: user?.image_profil ?? null,
    country_residence_id: resolvedLocation.countryId,
    country_residence_name: resolvedLocation.countryName,
    state_residence_id: resolvedLocation.stateId,
    state_residence_name: resolvedLocation.stateName,
    city_residence_id: resolvedLocation.cityId,
    city_residence_name: resolvedLocation.cityName,
    birthday_date: toDateOnlyOrNull(user?.birthday),
    age_years: computeAgeYears(user?.birthday),
    profile_verified: profileVerified,
    verified_badge: profileVerified,
    profile_verification_status: profileVerificationStatus,
    created_at: toIsoOrNull(user?.createdAt),
    updated_at: toIsoOrNull(user?.updatedAt),
    deleted_at: toIsoOrNull(user?.deleted_at ?? user?.deletedAt),
    profile_verified_at: toIsoOrNull(user?.profile_verified_at ?? user?.profileVerifiedAt),
    profile_verification_last_submitted_at: toIsoOrNull(
      user?.profile_verification_last_submitted_at ?? user?.profileVerificationLastSubmittedAt
    ),
    status: toBool(user?.is_deleted)
      ? "deleted"
      : toBool(user?.disabled)
      ? "disabled"
      : "active",
  };
};

const withFollowCountAliases = (
  user: any,
  counts: { followersCount: number; followingCount: number } | null | undefined
) => {
  const followersCount = toNonNegativeInt(
    counts?.followersCount ?? user?.followersCount ?? user?.followers_count
  );
  const followingCount = toNonNegativeInt(
    counts?.followingCount ??
      user?.followingCount ??
      user?.followingsCount ??
      user?.following_count ??
      user?.followings_count
  );

  return {
    ...user,
    followersCount,
    followingCount,
    followingsCount: followingCount,
    followers_count: followersCount,
    following_count: followingCount,
    followings_count: followingCount,
  };
};

const readActorUserId = (req: Request) => toOptionalPositiveInt((req as any)?.userId);
const readTargetUserId = (req: Request) => toOptionalPositiveInt((req.params as any)?.id);
const readTargetPostId = (req: Request) =>
  toOptionalPositiveInt((req.params as any)?.postId ?? (req.params as any)?.post_id);
const readTargetReelId = (req: Request) =>
  toOptionalPositiveInt((req.params as any)?.reelId ?? (req.params as any)?.reel_id);
const readTargetServiceId = (req: Request) =>
  toOptionalPositiveInt(
    (req.params as any)?.serviceId ?? (req.params as any)?.service_id
  );

const normalizeAdminChatSendBody = (bodyRaw: any) => {
  const body =
    bodyRaw && typeof bodyRaw === "object" && !Array.isArray(bodyRaw)
      ? { ...bodyRaw }
      : {};

  const messageRaw = String(body?.message ?? "").trim();
  if (!messageRaw) {
    const textRaw = String(body?.text ?? "").trim();
    if (textRaw) {
      body.message = textRaw;
    } else {
      const contentRaw = String(body?.content ?? "").trim();
      if (contentRaw) body.message = contentRaw;
    }
  }

  return body;
};

const ADMIN_SUPPORTED_MEDIA_MESSAGE_TYPES = new Set([
  "text",
  "voice",
  "image",
  "video",
]);

const ADMIN_POST_COMMENT_COUNT_LITERAL = Sequelize.literal(
  "(SELECT COUNT(1) FROM comments c WHERE c.postId = `post`.`id` AND c.is_delete = 0)"
);
const ADMIN_SERVICE_OFFERS_COUNT_LITERAL = Sequelize.literal(
  "(SELECT COUNT(1) FROM offers o WHERE o.serviceId = `service`.`id` AND o.canceled = 0 AND o.removed = 0)"
);
const ADMIN_SERVICE_ACCEPTED_WORKERS_COUNT_LITERAL = Sequelize.literal(
  "(SELECT COUNT(1) FROM offers o WHERE o.serviceId = `service`.`id` AND o.accepted = 1 AND o.canceled = 0 AND o.removed = 0)"
);

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? null;

const normalizeAdminCommentRow = (rowRaw: any) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const commentator = toPlain(row?.commentator);
  return {
    id: Number(row?.id ?? 0) || null,
    post_id: Number(row?.postId ?? row?.post_id ?? 0) || null,
    user_id: Number(row?.userId ?? row?.user_id ?? 0) || null,
    comment: String(row?.comment ?? "").trim() || null,
    media_url: String(row?.media_url ?? "").trim() || null,
    is_delete: Boolean(row?.is_delete),
    created_date: toIsoOrNull(row?.created_date ?? row?.createdAt),
    deleted_date: toIsoOrNull(row?.deleted_date),
    commentator: commentator
      ? {
          id: Number(commentator?.id ?? 0) || null,
          name: String(commentator?.name ?? "").trim() || null,
          last_name: String(commentator?.last_name ?? "").trim() || null,
          username: String(commentator?.username ?? "").trim() || null,
          image_profil: String(commentator?.image_profil ?? "").trim() || null,
          profile_verified: toBool(
            commentator?.profile_verified ??
              commentator?.profileVerified ??
              commentator?.verified_badge
          ),
        }
      : null,
  };
};

const normalizeAdminPostRow = (rowRaw: any) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const rowAny: any = rowRaw as any;
  const commentsCount = toNonNegativeInt(
    (typeof rowAny?.get === "function" ? rowAny.get("comments_count") : null) ??
      row?.comments_count ??
      0
  );
  const likesCount = toNonNegativeInt(row?.likes_count);
  const savesCount = toNonNegativeInt(row?.saves_count ?? row?.saved_count);
  const sharesCount = toNonNegativeInt(row?.shares_count);
  const postMedia = Array.isArray(row?.post_media) ? row.post_media : [];
  const normalizedPostMedia = postMedia.map((media: any) => ({
    id: Number(media?.id ?? 0) || null,
    url: String(media?.url ?? "").trim() || null,
    is_img: Boolean(media?.is_img),
    is_image: Boolean(media?.is_img),
  }));
  const primaryMedia = normalizedPostMedia.find(
    (media: any) => Boolean(media?.url)
  ) ?? null;
  const postText = String(row?.post ?? "").trim() || null;
  const entities = extractPostEntities(postText ?? "");
  const hasMedia = Boolean(primaryMedia?.url);
  const user = toPlain(row?.user);
  const comments = Array.isArray(row?.comments) ? row.comments : [];

  return {
    id: Number(row?.id ?? 0) || null,
    user_id: Number(row?.userId ?? row?.user_id ?? 0) || null,
    category_id: Number(row?.categoryId ?? row?.category_id ?? 0) || null,
    post: postText,
    text: postText,
    excerpt: truncateText(postText, 180),
    description: postText,
    short_description: truncateText(postText, 180),
    entities,
    hashtags: entities.hashtags,
    mentions: entities.mentions,
    urls: entities.urls,
    has_hashtags: entities.hashtags.length > 0,
    has_mentions: entities.mentions.length > 0,
    has_urls: entities.urls.length > 0,
    has_media: hasMedia,
    hasMedia,
    content_type: hasMedia ? "media" : "text",
    is_delete: Boolean(row?.is_delete),
    created_date: toIsoOrNull(row?.created_date ?? row?.createdAt),
    deleted_date: toIsoOrNull(row?.deleted_date),
    likes_count: likesCount,
    stars_count: likesCount,
    saves_count: savesCount,
    saved_count: savesCount,
    comments_count: commentsCount,
    shares_count: sharesCount,
    counts: {
      stars: likesCount,
      likes: likesCount,
      saves: savesCount,
      saved: savesCount,
      comments: commentsCount,
      shares: sharesCount,
      shared: sharesCount,
    },
    post_media: normalizedPostMedia,
    media: primaryMedia,
    image_url: primaryMedia?.is_img ? primaryMedia?.url ?? null : null,
    thumbnail_url: primaryMedia?.url ?? null,
    comments: comments.map(normalizeAdminCommentRow).filter(Boolean),
    user: user
      ? {
          id: Number(user?.id ?? 0) || null,
          name: String(user?.name ?? "").trim() || null,
          last_name: String(user?.last_name ?? "").trim() || null,
          username: String(user?.username ?? "").trim() || null,
          image_profil: String(user?.image_profil ?? "").trim() || null,
          profile_verified: toBool(
            user?.profile_verified ?? user?.profileVerified ?? user?.verified_badge
          ),
        }
      : null,
  };
};

const normalizeAdminReelCommentRow = (rowRaw: any) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const commentator = toPlain(row?.comment_user ?? row?.user);
  return {
    id: Number(row?.id ?? 0) || null,
    reel_id: Number(row?.reelId ?? row?.reel_id ?? 0) || null,
    user_id: Number(row?.userId ?? row?.user_id ?? 0) || null,
    comment: String(row?.comment ?? "").trim() || null,
    media_url: String(row?.media_url ?? "").trim() || null,
    is_delete: Boolean(row?.is_delete),
    created_date: toIsoOrNull(row?.createdAt ?? row?.created_date),
    deleted_date: toIsoOrNull(row?.deleted_date),
    commentator: commentator
      ? {
          id: Number(commentator?.id ?? 0) || null,
          name: String(commentator?.name ?? "").trim() || null,
          last_name: String(commentator?.last_name ?? "").trim() || null,
          username: String(commentator?.username ?? "").trim() || null,
          image_profil: String(commentator?.image_profil ?? "").trim() || null,
          profile_verified: toBool(
            commentator?.profile_verified ??
              commentator?.profileVerified ??
              commentator?.verified_badge
          ),
        }
      : null,
  };
};

const normalizeAdminReelRow = (rowRaw: any) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const user = toPlain(row?.user);
  const comments = Array.isArray(row?.reel_comments) ? row.reel_comments : [];
  const description = String(row?.description ?? "").trim() || null;
  const likesCount = toNonNegativeInt(row?.likes_count);
  const savesCount = toNonNegativeInt(row?.saves_count);
  const commentsCount = toNonNegativeInt(row?.comments_count);
  const sharesCount = toNonNegativeInt(row?.shares_count);
  const viewsCount = toNonNegativeInt(row?.views_count);
  const videoUrl = String(row?.stream_url ?? "").trim() || null;
  const thumbnailUrl = String(row?.thumbnail_url ?? "").trim() || null;
  const downloadUrl = String(row?.download_url ?? "").trim() || null;
  const videoUid = String(row?.video_uid ?? "").trim() || null;
  const createdDate = toIsoOrNull(row?.createdAt);
  const normalizedUser = user
    ? {
        id: Number(user?.id ?? 0) || null,
        name: String(user?.name ?? "").trim() || null,
        last_name: String(user?.last_name ?? "").trim() || null,
        username: String(user?.username ?? "").trim() || null,
        image_profil: String(user?.image_profil ?? "").trim() || null,
        image_profile: String(user?.image_profil ?? "").trim() || null,
        profile_verified: toBool(
          user?.profile_verified ?? user?.profileVerified ?? user?.verified_badge
        ),
      }
    : null;

  return {
    id: Number(row?.id ?? 0) || null,
    post_id: Number(row?.id ?? 0) || null,
    video_id: Number(row?.id ?? 0) || null,
    user_id: Number(row?.userId ?? row?.user_id ?? 0) || null,
    content_type: "video",
    type: "reel",
    description,
    post: description,
    text: description,
    excerpt: truncateText(description, 180),
    short_description: truncateText(description, 180),
    has_media: Boolean(videoUrl || thumbnailUrl),
    hasMedia: Boolean(videoUrl || thumbnailUrl),
    has_video: Boolean(videoUrl || videoUid),
    video_uid: videoUid,
    stream_url: videoUrl,
    video_url: videoUrl,
    url: videoUrl,
    download_url: downloadUrl,
    thumbnail_url: thumbnailUrl,
    thumbnail: thumbnailUrl,
    cover_url: thumbnailUrl,
    media: {
      url: videoUrl,
      is_img: false,
      is_image: false,
      kind: "video",
      thumbnail_url: thumbnailUrl,
      download_url: downloadUrl,
      video_uid: videoUid,
    },
    visibility: String(row?.visibility ?? "").trim() || null,
    status: String(row?.status ?? "").trim() || null,
    duration_seconds: toNonNegativeInt(row?.duration_seconds),
    allow_download: Boolean(row?.allow_download),
    is_delete: Boolean(row?.is_delete),
    created_date: createdDate,
    created_at: createdDate,
    createdAt: createdDate,
    published_at: createdDate,
    updated_date: toIsoOrNull(row?.updatedAt),
    deleted_date: toIsoOrNull(row?.deleted_date),
    likes_count: likesCount,
    stars_count: likesCount,
    saves_count: savesCount,
    saved_count: savesCount,
    comments_count: commentsCount,
    shares_count: sharesCount,
    views_count: viewsCount,
    plays_count: viewsCount,
    counts: {
      stars: likesCount,
      likes: likesCount,
      saves: savesCount,
      saved: savesCount,
      comments: commentsCount,
      shares: sharesCount,
      shared: sharesCount,
      views: viewsCount,
      plays: viewsCount,
    },
    comments: comments.map(normalizeAdminReelCommentRow).filter(Boolean),
    user: normalizedUser,
    author: normalizedUser,
    publisher: normalizedUser,
  };
};

type AdminServiceMode = "all" | "remote" | "on_site";

const parseAdminServiceMode = (value: any): AdminServiceMode => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (["remote", "freelance", "virtual"].includes(normalized)) return "remote";
  if (["on_site", "onsite", "on-site", "on site", "in_person"].includes(normalized)) {
    return "on_site";
  }
  return "all";
};

const parseAdminServiceStatusId = (value: any): number | null => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "all") return null;

  const parsedNumber = Number(normalized);
  if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
    return Math.trunc(parsedNumber);
  }

  if (["search", "searching", "initialized", "pending"].includes(normalized)) return 1;
  if (["assigned"].includes(normalized)) return 2;
  if (["in_progress", "in progress", "progress", "working"].includes(normalized)) return 3;
  if (["completed", "finalized", "finished", "history"].includes(normalized)) return 4;
  if (["canceled", "cancelled"].includes(normalized)) return 5;
  return null;
};

const adminServiceInclude = [
  {
    model: User,
    as: "client",
    attributes: [
      "id",
      "name",
      "last_name",
      "username",
      "image_profil",
      "profile_verified",
      "profile_verification_status",
      "country_residence_id",
      "state_residence_id",
      "city_residence_id",
      "city_residence_name",
    ],
    required: false,
  },
  {
    model: Category,
    as: "category",
    attributes: ["id", "name", "es_name"],
    required: false,
  },
  {
    model: StatusService,
    as: "status",
    attributes: ["id", "status", "description"],
    required: false,
  },
];

const applyAdminLocationWhere = (
  clauses: any[],
  column: string,
  filterValue: number | null
) => {
  if (filterValue === ADMIN_LOCATION_NULL_SENTINEL) {
    clauses.push(Sequelize.where(Sequelize.col(column), { [Op.is]: null }));
    return;
  }
  const normalized = toNumberOrNull(filterValue);
  if (!normalized) return;
  clauses.push(Sequelize.where(Sequelize.col(column), normalized));
};

const buildAdminMuralServicesWhere = (params: {
  includeDeleted: boolean;
  statusId: number | null;
  serviceMode: AdminServiceMode;
  categoryId: number | null;
  q: string;
  countryId: number | null;
  stateId: number | null;
  cityId: number | null;
}) => {
  const clauses: any[] = [];

  if (!params.includeDeleted) {
    clauses.push({ is_available: true });
  }

  if (params.statusId && params.statusId > 0) {
    clauses.push({ statusId: params.statusId });
  }

  if (params.serviceMode === "remote") {
    clauses.push({ on_site: false });
  } else if (params.serviceMode === "on_site") {
    clauses.push({ on_site: true });
  }

  if (params.categoryId) {
    clauses.push({ categoryId: params.categoryId });
  }

  const hasLocationFilters =
    params.countryId !== null || params.stateId !== null || params.cityId !== null;
  if (hasLocationFilters) {
    // Location filters apply only to on-site services.
    // Remote services have no service location and must not inherit client residence.
    clauses.push({ on_site: true });
    applyAdminLocationWhere(clauses, "client.country_residence_id", params.countryId);
    applyAdminLocationWhere(clauses, "client.state_residence_id", params.stateId);
    applyAdminLocationWhere(clauses, "client.city_residence_id", params.cityId);
  }

  const q = String(params.q ?? "").trim();
  if (q) {
    const qLike = `%${q}%`;
    const qLowerLike = `%${q.toLowerCase()}%`;
    const qId = toNumberOrNull(q);
    const qOrClauses: any[] = [
      { description: { [Op.like]: qLike } },
      { address: { [Op.like]: qLike } },
      Sequelize.where(Sequelize.fn("LOWER", Sequelize.col("client.username")), {
        [Op.like]: qLowerLike,
      }),
      Sequelize.where(Sequelize.fn("LOWER", Sequelize.col("client.name")), {
        [Op.like]: qLowerLike,
      }),
      Sequelize.where(Sequelize.fn("LOWER", Sequelize.col("client.last_name")), {
        [Op.like]: qLowerLike,
      }),
      Sequelize.where(Sequelize.fn("LOWER", Sequelize.col("category.name")), {
        [Op.like]: qLowerLike,
      }),
      Sequelize.where(Sequelize.fn("LOWER", Sequelize.col("category.es_name")), {
        [Op.like]: qLowerLike,
      }),
    ];
    if (qId) qOrClauses.push({ id: qId });
    clauses.push({ [Op.or]: qOrClauses });
  }

  if (!clauses.length) return {};
  return { [Op.and]: clauses };
};

const normalizeServiceStatusText = (serviceRaw: any, routingStatus: string) => {
  const fromModel = String(serviceRaw?.status?.status ?? "").trim();
  if (fromModel) return fromModel;
  const fromRaw = String(serviceRaw?.status ?? "").trim();
  if (fromRaw) return fromRaw;
  return String(routingStatus ?? "").trim() || "UNKNOWN";
};

const normalizeAdminServiceRow = (
  rowRaw: any,
  locationRefs?: AdminLocationRefs | null
) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const rowAny = rowRaw as any;

  const offersCount = toNonNegativeInt(
    (typeof rowAny?.get === "function" ? rowAny.get("offers_count") : null) ??
      row?.offers_count ??
      row?.applicants_count ??
      0
  );
  const acceptedWorkersCount = toNonNegativeInt(
    (typeof rowAny?.get === "function" ? rowAny.get("accepted_workers_count") : null) ??
      row?.accepted_workers_count ??
      row?.accepted_count ??
      0
  );
  const applicantsCount = toNonNegativeInt(
    (typeof rowAny?.get === "function" ? rowAny.get("applicants_count") : null) ??
      row?.applicants_count ??
      offersCount
  );

  const routing = buildServiceRoutingFields(row, {
    acceptedCount: acceptedWorkersCount,
  });

  const client = toPlain(row?.client);
  const category = toPlain(row?.category);
  const resolvedLocation = resolveAdminLocation(
    {
      countryId: toNumberOrNull(client?.country_residence_id),
      stateId: toNumberOrNull(client?.state_residence_id),
      cityId: toNumberOrNull(client?.city_residence_id),
      cityNameRaw: String(client?.city_residence_name ?? "").trim() || null,
    },
    locationRefs
  );

  const onSiteRaw = row?.on_site;
  const inferredRemote = parseQueryBool(row?.is_remote ?? row?.isRemote, false);
  const onSite =
    onSiteRaw === null || onSiteRaw === undefined ? !inferredRemote : Boolean(onSiteRaw);
  const isRemote =
    row?.is_remote === null || row?.is_remote === undefined
      ? !onSite
      : parseQueryBool(row?.is_remote, false);
  const serviceModeRaw = String(row?.service_mode ?? "").trim().toLowerCase();
  const serviceMode =
    serviceModeRaw === "remote" || serviceModeRaw === "on_site"
      ? serviceModeRaw
      : isRemote
      ? "remote"
      : "on_site";
  const isRemoteService = serviceMode === "remote";
  const serviceLocation = isRemoteService
    ? {
        countryId: null,
        countryName: null,
        stateId: null,
        stateName: null,
        cityId: null,
        cityName: null,
      }
    : resolvedLocation;

  const createdAt = toIsoOrNull(row?.createdAt ?? row?.service_date);
  const serviceDate = toIsoOrNull(row?.service_date ?? row?.createdAt);
  const deletedAt = toIsoOrNull(row?.deleted_at ?? row?.deletedAt);
  const isDelete = parseQueryBool(row?.is_delete ?? row?.is_deleted ?? false, false);
  const normalizedStatusId = Number(
    row?.status_id ?? row?.statusId ?? row?.status?.id ?? routing.status_id
  );
  const statusId = Number.isFinite(normalizedStatusId)
    ? Math.trunc(normalizedStatusId)
    : routing.status_id;

  const normalizedClient = client
    ? {
        id: Number(client?.id ?? 0) || null,
        user_id: Number(client?.id ?? 0) || null,
        username: String(client?.username ?? "").trim() || null,
        name: String(client?.name ?? "").trim() || null,
        last_name: String(client?.last_name ?? "").trim() || null,
        image_profil: String(client?.image_profil ?? "").trim() || null,
        image_profile: String(client?.image_profil ?? "").trim() || null,
        profile_verified: toBool(
          client?.profile_verified ?? client?.profileVerified ?? client?.verified_badge
        ),
      }
    : null;

  const categoryId = Number(row?.categoryId ?? category?.id ?? 0) || null;
  const categoryName = String(category?.name ?? "").trim() || null;
  const categoryEsName = String(category?.es_name ?? "").trim() || null;
  const clientBucket = String(
    row?.client_bucket ?? row?.clientBucket ?? routing.client_bucket
  )
    .trim()
    .toLowerCase();

  return {
    id: Number(row?.id ?? 0) || null,
    user_id: Number(row?.userId ?? row?.user_id ?? normalizedClient?.id ?? 0) || null,
    description: String(row?.description ?? "").trim() || null,
    text: String(row?.description ?? "").trim() || null,
    status_id: statusId,
    statusId,
    status: normalizeServiceStatusText(row, routing.status),
    client_bucket: clientBucket || routing.client_bucket,
    clientBucket: clientBucket || routing.client_bucket,
    rate: Number.isFinite(Number(row?.rate)) ? Number(row?.rate) : null,
    currency_code:
      String(row?.currencyCode ?? row?.currency_code ?? "").trim() || null,
    currencyCode:
      String(row?.currencyCode ?? row?.currency_code ?? "").trim() || null,
    currency_prefix:
      String(row?.currencyPrefix ?? row?.currency_prefix ?? "").trim() || null,
    currencyPrefix:
      String(row?.currencyPrefix ?? row?.currency_prefix ?? "").trim() || null,
    places: toNonNegativeInt(row?.places),
    service_date: serviceDate,
    address: isRemoteService ? null : String(row?.address ?? "").trim() || null,
    on_site: onSite,
    is_available: Boolean(row?.is_available),
    applicants_count: applicantsCount,
    offers_count: offersCount,
    accepted_workers_count: acceptedWorkersCount,
    created_at: createdAt,
    createdAt,
    is_delete: isDelete,
    is_deleted: isDelete,
    deleted_at: deletedAt,
    country_residence_id: serviceLocation.countryId,
    country_residence_name: serviceLocation.countryName,
    state_residence_id: serviceLocation.stateId,
    state_residence_name: serviceLocation.stateName,
    city_residence_id: serviceLocation.cityId,
    city_residence_name: serviceLocation.cityName,
    service_mode: serviceMode,
    is_remote: isRemote,
    category_id: categoryId,
    category_name: categoryName,
    category_es_name: categoryEsName,
    user: normalizedClient,
    author: normalizedClient,
    publisher: normalizedClient,
  };
};

const normalizeAdminServiceOfferRow = (rowRaw: any) => {
  const row = toPlain(rowRaw);
  if (!row) return null;
  const worker = toPlain(row?.offerer);
  const personal = toPlain(worker?.personal_data);

  const accepted = Boolean(row?.accepted);
  const canceled = Boolean(row?.canceled);
  const removed = Boolean(row?.removed);
  const bucket =
    accepted && !canceled && !removed
      ? "accepted"
      : !accepted && !canceled && !removed
      ? "applicants"
      : "canceled";

  const normalizedWorker = personal
    ? {
        id: Number(personal?.id ?? 0) || null,
        user_id: Number(personal?.id ?? 0) || null,
        username: String(personal?.username ?? "").trim() || null,
        name: String(personal?.name ?? "").trim() || null,
        last_name: String(personal?.last_name ?? "").trim() || null,
        image_profil: String(personal?.image_profil ?? "").trim() || null,
        image_profile: String(personal?.image_profil ?? "").trim() || null,
        image: String(personal?.image_profil ?? "").trim() || null,
        profile_verified: toBool(
          personal?.profile_verified ?? personal?.profileVerified ?? personal?.verified_badge
        ),
        is_verified: toBool(
          personal?.profile_verified ?? personal?.profileVerified ?? personal?.verified_badge
        ),
      }
    : null;

  return {
    id: Number(row?.id ?? 0) || null,
    service_id: Number(row?.serviceId ?? row?.service_id ?? 0) || null,
    worker_id: Number(row?.workerId ?? row?.worker_id ?? 0) || null,
    accepted,
    canceled,
    removed,
    bucket,
    worker: normalizedWorker,
  };
};

type AdminWorkerApplicationsStatus =
  | "all"
  | "applied"
  | "selected_in_progress"
  | "finalized"
  | "client_canceled"
  | "worker_canceled"
  | "closed_not_selected";

const parseAdminWorkerApplicationsStatus = (value: any): AdminWorkerApplicationsStatus => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (["applied", "applicants", "pending"].includes(normalized)) return "applied";
  if (
    [
      "selected_in_progress",
      "selectedinprogress",
      "selected-in-progress",
      "selected_inprogress",
      "selected",
      "in_progress",
      "in-progress",
    ].includes(normalized)
  ) {
    return "selected_in_progress";
  }
  if (["finalized", "completed", "closed", "done"].includes(normalized)) return "finalized";
  if (["client_canceled", "clientcanceled", "client-canceled", "removed"].includes(normalized)) {
    return "client_canceled";
  }
  if (["worker_canceled", "workercanceled", "worker-canceled", "canceled", "cancelled"].includes(normalized)) {
    return "worker_canceled";
  }
  if (["closed_not_selected", "closednotselected", "closed-not-selected", "not_selected"].includes(normalized)) {
    return "closed_not_selected";
  }
  return "all";
};

type AdminReportsType = "all" | "user" | "post" | "reel" | "service";
type AdminReportActionStatus = "all" | "pending" | "resolved" | "reviewed" | "dismissed";

const parseAdminReportsType = (value: any): AdminReportsType => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (["user", "users", "profile", "profiles"].includes(normalized)) return "user";
  if (["post", "posts"].includes(normalized)) return "post";
  if (["reel", "reels", "orbit", "orbits"].includes(normalized)) return "reel";
  if (["service", "services", "job", "jobs"].includes(normalized)) return "service";
  return "all";
};

const parseAdminReportActionStatus = (value: any): AdminReportActionStatus => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (["pending", "open", "new"].includes(normalized)) return "pending";
  if (["resolved", "done", "closed"].includes(normalized)) return "resolved";
  if (["reviewed", "in_review", "in-review"].includes(normalized)) return "reviewed";
  if (["dismissed", "rejected", "ignored"].includes(normalized)) return "dismissed";
  return "all";
};

const isMissingSqlStorageError = (error: any) => {
  const message = String(
    (error as any)?.original?.sqlMessage ??
      (error as any)?.original?.message ??
      (error as any)?.message ??
      ""
  ).toLowerCase();
  return (
    message.includes("doesn't exist") ||
    message.includes("does not exist") ||
    message.includes("unknown table") ||
    message.includes("no such table")
  );
};

const isMissingReportsStorageError = (error: any) => isMissingSqlStorageError(error);

type AdminPushStatus = "all" | "active" | "disabled";
type AdminPushRole = "all" | "worker" | "client";

const parseAdminPushStatus = (value: any): AdminPushStatus => {
  const normalized = String(value ?? "active")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "active") return "active";
  if (normalized === "disabled") return "disabled";
  if (normalized === "all") return "all";
  return "active";
};

const parseAdminPushRole = (value: any): AdminPushRole => {
  const role = parseAdminRole(value);
  if (role === "worker" || role === "client") return role;
  return "all";
};

const parseBodyUserIds = (value: any): number[] => {
  const asArray = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(",")
    : [];
  const normalized = asArray
    .map((item: any) => toOptionalPositiveInt(item))
    .filter((id): id is number => Boolean(id));
  return Array.from(new Set(normalized));
};

const normalizeDistinctPushTokens = (tokensRaw: any[]): string[] => {
  const tokens = (tokensRaw ?? [])
    .map((token) => String(token ?? "").trim())
    .filter((token) => token.length >= MIN_PUSH_TOKEN_LENGTH);
  return Array.from(new Set(tokens)).slice(0, MAX_PUSH_TOKENS_PER_USER);
};

type AdminPushRecipient = {
  userId: number;
  tokens: string[];
};

const buildAdminPushUsersWhere = (params: {
  status: AdminPushStatus;
  role: AdminPushRole;
  countryId: number | null;
  stateId: number | null;
  cityId: number | null;
  userIds: number[];
}) => {
  const where: any = {
    is_deleted: false,
  };

  if (params.userIds.length) {
    where.id = {
      [Op.in]: params.userIds,
    };
  }

  if (params.status === "active") {
    where.available = true;
    where.disabled = false;
  } else if (params.status === "disabled") {
    where.disabled = true;
  }

  if (params.role === "worker") {
    where[Op.and] = [
      ...(Array.isArray(where[Op.and]) ? where[Op.and] : []),
      Sequelize.literal(
        "EXISTS (SELECT 1 FROM `workers` AS `w` WHERE `w`.`userId` = `user`.`id`)"
      ),
    ];
  } else if (params.role === "client") {
    where[Op.and] = [
      ...(Array.isArray(where[Op.and]) ? where[Op.and] : []),
      Sequelize.literal(
        "NOT EXISTS (SELECT 1 FROM `workers` AS `w` WHERE `w`.`userId` = `user`.`id`)"
      ),
    ];
  }

  if (Number.isFinite(Number(params.countryId)) && Number(params.countryId) > 0) {
    where.country_residence_id = Math.trunc(Number(params.countryId));
  }
  if (Number.isFinite(Number(params.stateId)) && Number(params.stateId) > 0) {
    where.state_residence_id = Math.trunc(Number(params.stateId));
  }
  if (Number.isFinite(Number(params.cityId)) && Number(params.cityId) > 0) {
    where.city_residence_id = Math.trunc(Number(params.cityId));
  }

  return where;
};

const fetchPushSessionTokensByUserIds = async (userIds: number[]) => {
  const byUserId = new Map<number, string[]>();
  if (!userIds.length) return byUserId;

  try {
    const rows = (await sequelize.query(
      `
        SELECT user_id AS userId, device_uuid AS uuid
        FROM user_auth_sessions
        WHERE user_id IN (:userIds)
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND device_uuid IS NOT NULL
          AND device_uuid <> ''
      `,
      {
        replacements: { userIds },
        type: QueryTypes.SELECT,
      }
    )) as Array<{ userId?: any; uuid?: any }>;

    for (const row of rows ?? []) {
      const userId = toOptionalPositiveInt((row as any)?.userId);
      const uuid = String((row as any)?.uuid ?? "").trim();
      if (!userId || uuid.length < MIN_PUSH_TOKEN_LENGTH) continue;
      const current = byUserId.get(userId) ?? [];
      current.push(uuid);
      byUserId.set(userId, current);
    }
  } catch (error) {
    if (!isMissingSqlStorageError(error)) {
      console.error("fetchPushSessionTokensByUserIds error:", error);
    }
  }

  byUserId.forEach((tokens, userId) => {
    byUserId.set(userId, normalizeDistinctPushTokens(tokens));
  });
  return byUserId;
};

const resolveAdminPushRecipients = async (params: {
  userIds: number[];
  status: AdminPushStatus;
  role: AdminPushRole;
  countryId: number | null;
  stateId: number | null;
  cityId: number | null;
}) => {
  const where = buildAdminPushUsersWhere(params);
  const rows = (await User.findAll({
    where,
    attributes: ["id", "uuid", "alert"],
    raw: true,
    order: [["id", "DESC"]],
  })) as any[];

  const ids = Array.from(
    new Set(
      (rows ?? [])
        .map((row: any) => toOptionalPositiveInt((row as any)?.id))
        .filter((id): id is number => Boolean(id))
    )
  );

  const sessionTokensByUserId = await fetchPushSessionTokensByUserIds(ids);
  const recipients: AdminPushRecipient[] = [];
  for (const row of rows ?? []) {
    const userId = toOptionalPositiveInt((row as any)?.id);
    if (!userId) continue;
    const alertsEnabled = Boolean((row as any)?.alert);
    const legacyToken = alertsEnabled ? String((row as any)?.uuid ?? "").trim() : "";
    const sessionTokens = alertsEnabled ? sessionTokensByUserId.get(userId) ?? [] : [];
    const tokens = normalizeDistinctPushTokens([legacyToken, ...sessionTokens]);
    recipients.push({ userId, tokens });
  }

  return recipients;
};

type AdminChatHistoryStatus = "all" | "active" | "finalized";

const parseAdminChatHistoryStatus = (value: any): AdminChatHistoryStatus => {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (normalized === "active" || normalized === "open") return "active";
  if (
    normalized === "finalized" ||
    normalized === "closed" ||
    normalized === "history"
  ) {
    return "finalized";
  }
  return "all";
};

const resolveAdminDirectChatMeta = async (params: {
  actorUserId: number;
  targetUserId: number;
}): Promise<{ chatId: number | null; deletedBy: number | null }> => {
  const rows = (await sequelize.query(
    `
      SELECT c.id AS chatId, c.deletedBy AS deletedBy
      FROM chat_user cu1
      INNER JOIN chat_user cu2
        ON cu2.chatId = cu1.chatId
       AND cu2.userId = :targetUserId
      LEFT JOIN chat_groups cg
        ON cg.chatId = cu1.chatId
      INNER JOIN chats c
        ON c.id = cu1.chatId
      WHERE cu1.userId = :actorUserId
        AND cg.chatId IS NULL
      ORDER BY cu1.chatId DESC
      LIMIT 1
    `,
    {
      replacements: {
        actorUserId: params.actorUserId,
        targetUserId: params.targetUserId,
      },
      type: QueryTypes.SELECT,
    }
  )) as Array<{ chatId?: number | string | null; deletedBy?: number | string | null }>;

  if (!rows.length) {
    return { chatId: null, deletedBy: null };
  }

  const chatId = Number(rows[0]?.chatId ?? 0);
  const deletedBy = Number(rows[0]?.deletedBy ?? 0);
  return {
    chatId: Number.isFinite(chatId) && chatId > 0 ? Math.trunc(chatId) : null,
    deletedBy: Number.isFinite(deletedBy) ? Math.trunc(deletedBy) : null,
  };
};

const getAdminChatMessagesByChatId = async (params: {
  chatId: number;
  actorUserId: number;
  targetUserId: number;
  limit: number;
  sort: "asc" | "desc";
  beforeMessageId: number | null;
  includeFinalizedHistory: boolean;
}) => {
  const where: any = {
    chatId: params.chatId,
  };

  if (params.beforeMessageId) {
    where.id = { [Op.lt]: params.beforeMessageId };
  }

  // For active chats keep same visibility semantics as app/admin current behavior.
  // For finalized history allow full conversation retrieval.
  if (!params.includeFinalizedHistory) {
    where.deletedBy = { [Op.in]: [0, params.actorUserId] };
  }

  const rows = await Message.findAll({
    where,
    order: [
      ["date", "DESC"],
      ["id", "DESC"],
    ],
    limit: params.limit,
    include: [
      {
        model: User,
        as: "sender",
        required: false,
        attributes: [
          "id",
          "name",
          "last_name",
          "username",
          "image_profil",
          "is_deleted",
          "profile_verified",
          "profile_verification_status",
        ],
      },
      {
        model: Message,
        as: "replyTo",
        required: false,
        attributes: [
          "id",
          "text",
          "messageType",
          "mediaUrl",
          "mediaMime",
          "mediaDurationMs",
          "mediaSizeBytes",
          "waveform",
          "metadata",
          "senderId",
          "date",
        ],
      },
    ],
  });

  return params.sort === "desc" ? rows : rows.reverse();
};

const normalizeAdminChatMessage = (params: {
  messageRaw: any;
  adminUserId: number;
  targetUserId: number;
}) => {
  const serialized = serializeMessageToCanonical(params.messageRaw, {
    includeLegacy: true,
  }) as any;
  const senderId = toOptionalPositiveInt(
    serialized?.senderId ?? serialized?.sender_id
  );
  const isFromAdmin = Boolean(senderId && senderId === params.adminUserId);
  const sentAt = toIsoOrNull(
    serialized?.date ??
      serialized?.createdAt ??
      serialized?.created_at ??
      serialized?.timestamp
  );
  const text =
    String(serialized?.text ?? serialized?.message ?? serialized?.content ?? "")
      .trim() || null;
  const deliveredAt = toIsoOrNull(serialized?.deliveredAt ?? serialized?.delivered_at);
  const readAt = toIsoOrNull(serialized?.readAt ?? serialized?.read_at);
  const status =
    String(serialized?.status ?? "").trim().toLowerCase() === "read"
      ? "read"
      : String(serialized?.status ?? "").trim().toLowerCase() === "delivered"
      ? "delivered"
      : "sent";

  return {
    ...serialized,
    id: Number(serialized?.id ?? 0) || null,
    sender_id: senderId,
    senderId,
    sender_type: isFromAdmin ? "admin" : "user",
    sender_is_admin: isFromAdmin,
    direction: isFromAdmin ? "outgoing" : "incoming",
    text,
    message: text,
    content: text,
    status,
    deliveredAt,
    delivered_at: deliveredAt,
    readAt,
    read_at: readAt,
    created_at: sentAt,
    createdAt: sentAt,
    sent_at: sentAt,
    timestamp: sentAt,
    participants: {
      admin_user_id: params.adminUserId,
      user_id: params.targetUserId,
    },
  };
};

const buildAdminChatPermissions = () => ({
  can_open_counterpart_profile: false,
  canOpenCounterpartProfile: false,
  can_report_counterpart: false,
  canReportCounterpart: false,
  can_follow_counterpart: false,
  canFollowCounterpart: false,
  can_open_more: false,
  canOpenMore: false,
  show_more_actions: false,
  showMoreActions: false,
});

const buildAdminChatCounterpart = (params: {
  adminUserRaw: any;
  adminUserId: number;
}) => {
  const adminUser =
    params.adminUserRaw && typeof params.adminUserRaw.toJSON === "function"
      ? params.adminUserRaw.toJSON()
      : params.adminUserRaw ?? {};
  const firstName = String((adminUser as any)?.name ?? "").trim() || "Soporte";
  const lastName = String((adminUser as any)?.last_name ?? "").trim() || "Minhoo";
  const imageProfil = String((adminUser as any)?.image_profil ?? "").trim() || null;

  return {
    id: params.adminUserId,
    user_type: "admin",
    is_admin: true,
    isAdmin: true,
    roles: [{ id: 8088, role: "admin", description: "admin role" }],
    name: firstName,
    last_name: lastName,
    username: null,
    image_profil: imageProfil,
    can_open_profile: false,
    canOpenProfile: false,
    can_report: false,
    canReport: false,
    can_follow: false,
    canFollow: false,
    can_open_more: false,
    canOpenMore: false,
    show_more_actions: false,
    showMoreActions: false,
  };
};

const resolveWorkerIdsByUserId = async (userIdRaw: any) => {
  const userId = toOptionalPositiveInt(userIdRaw);
  if (!userId) return [] as number[];

  const rows = (await Worker.findAll({
    where: { userId },
    attributes: ["id"],
    raw: true,
  })) as any[];

  return Array.from(
    new Set(
      (rows ?? [])
        .map((row: any) => toOptionalPositiveInt(row?.id))
        .filter((value): value is number => Boolean(value))
    )
  );
};

type WorkerApplicationState = {
  application_state: Exclude<AdminWorkerApplicationsStatus, "all">;
  selected: boolean;
  in_progress: boolean;
  finalized: boolean;
  client_canceled: boolean;
  worker_canceled: boolean;
  closed_not_selected: boolean;
};

const buildWorkerApplicationState = (params: {
  accepted: boolean;
  canceled: boolean;
  removed: boolean;
  serviceStatusId: number;
  workerClosedAt: any;
}): WorkerApplicationState => {
  const accepted = Boolean(params.accepted);
  const canceled = Boolean(params.canceled);
  const removed = Boolean(params.removed);
  const serviceStatusId = Number(params.serviceStatusId ?? 0);
  const hasWorkerClosedAt = Boolean(params.workerClosedAt);
  const selectedBase = accepted && !canceled && !removed;

  const workerCanceled = !removed && canceled;
  const clientCanceled = removed || (selectedBase && serviceStatusId === 5);
  const selectedActive = selectedBase && !clientCanceled;
  const finalized = selectedActive && (hasWorkerClosedAt || serviceStatusId === 4);
  const inProgress = selectedActive && !finalized;
  const closedNotSelected =
    !selectedBase && !workerCanceled && !clientCanceled && (serviceStatusId === 4 || serviceStatusId === 5);

  let applicationState: WorkerApplicationState["application_state"] = "applied";
  if (clientCanceled) {
    applicationState = "client_canceled";
  } else if (workerCanceled) {
    applicationState = "worker_canceled";
  } else if (finalized) {
    applicationState = "finalized";
  } else if (inProgress) {
    applicationState = "selected_in_progress";
  } else if (closedNotSelected) {
    applicationState = "closed_not_selected";
  } else {
    applicationState = "applied";
  }

  return {
    application_state: applicationState,
    selected: inProgress || finalized,
    in_progress: inProgress,
    finalized,
    client_canceled: clientCanceled,
    worker_canceled: workerCanceled,
    closed_not_selected: closedNotSelected,
  };
};

const matchesWorkerApplicationScope = (
  scope: AdminWorkerApplicationsStatus,
  application: any
) => {
  if (scope === "all") return true;
  const state = String(application?.application_state ?? "").trim().toLowerCase();
  return state === scope;
};

/**
 * ✅ Lista admin de usuarios (todos, incluyendo disabled/deleted según filtro).
 * Endpoint: GET /api/v1/admin/users?page=1&limit=20&q=&status=all&verified=all
 */
export const admin_list_users = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const q = String((req.query as any)?.q ?? "").trim();
    const status = parseAdminStatus((req.query as any)?.status);
    const verified = parseAdminVerified((req.query as any)?.verified);
    const role = parseAdminRole(
      (req.query as any)?.role ??
        (req.query as any)?.user_type ??
        (req.query as any)?.userType
    );
    let countryId = parseAdminLocationFilter(
      (req.query as any)?.country_id ?? (req.query as any)?.countryId
    );
    let stateId = parseAdminLocationFilter(
      (req.query as any)?.state_id ?? (req.query as any)?.stateId
    );
    let cityId = parseAdminLocationFilter(
      (req.query as any)?.city_id ?? (req.query as any)?.cityId
    );
    const locationRefs = loadLocationCatalogRefs();
    ({ countryId, stateId, cityId } = sanitizeAdminLocationFilters(
      { countryId, stateId, cityId },
      locationRefs
    ));

    const result = await (repository as any).admin_list_users?.({
      page,
      limit,
      q,
      status,
      verified,
      role,
      countryId,
      stateId,
      cityId,
    });
    let rows = Array.isArray((result as any)?.rows) ? (result as any).rows : [];
    let users = rows.map((row: any) => normalizeAdminUserRow(row, locationRefs));
    let count = Number((result as any)?.count ?? 0) || 0;
    const totalUsersGlobal = Number((result as any)?.total_users_global ?? 0) || 0;

    let locationFallbackApplied = false;
    const requestedStateId = Number(stateId);
    const requestedCityId = Number(cityId);
    const hasPositiveStateFilter = Number.isFinite(requestedStateId) && requestedStateId > 0;
    const hasPositiveCityFilter = Number.isFinite(requestedCityId) && requestedCityId > 0;

    // Fallback de compatibilidad: si el filtro por estado/ciudad devuelve 0 por data legacy
    // (state_id/city_id nulos), reconstruimos la lista usando normalización por catálogo.
    if (count === 0 && (hasPositiveStateFilter || hasPositiveCityFilter)) {
      locationFallbackApplied = true;
      const scanLimit = 100;
      const maxScanRows = 10_000;
      let scanPage = 1;
      const collectedRows: any[] = [];

      while (true) {
        const chunk = await (repository as any).admin_list_users?.({
          page: scanPage,
          limit: scanLimit,
          q,
          status,
          verified,
          role,
          countryId,
          stateId: null,
          cityId: null,
        });

        const chunkRows = Array.isArray((chunk as any)?.rows) ? (chunk as any).rows : [];
        if (!chunkRows.length) break;

        collectedRows.push(...chunkRows);
        if (chunkRows.length < scanLimit || collectedRows.length >= maxScanRows) break;
        scanPage += 1;
      }

      const normalizedRows = collectedRows.map((row: any) =>
        normalizeAdminUserRow(row, locationRefs)
      );

      const filteredRows = normalizedRows.filter((row: any) => {
        const normalizedState = Number(row?.state_residence_id ?? 0);
        const normalizedCity = Number(row?.city_residence_id ?? 0);
        if (hasPositiveStateFilter && normalizedState !== Math.trunc(requestedStateId)) return false;
        if (hasPositiveCityFilter && normalizedCity !== Math.trunc(requestedCityId)) return false;
        return true;
      });

      count = filteredRows.length;
      const start = (page - 1) * limit;
      users = filteredRows.slice(start, start + limit);
    }

    try {
      const userIds = users
        .map((row: any) => toOptionalPositiveInt(row?.id))
        .filter((id: any): id is number => Number.isFinite(id as any));
      const countsByUserId = await followerRepository.getCountsMap(userIds);
      users = users.map((row: any) => {
        const userId = toOptionalPositiveInt(row?.id);
        return withFollowCountAliases(
          row,
          userId ? countsByUserId[userId] ?? null : null
        );
      });
    } catch (error) {
      console.error("admin_list_users follow counts enrich error:", error);
      users = users.map((row: any) => withFollowCountAliases(row, null));
    }

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.list",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        q: q || null,
        status,
        verified,
        role,
        countryId: serializeAdminLocationFilter(countryId),
        stateId: serializeAdminLocationFilter(stateId),
        cityId: serializeAdminLocationFilter(cityId),
        count,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        total_users_global: totalUsersGlobal,
        q,
        status,
        verified,
        role,
        country_id: serializeAdminLocationFilter(countryId),
        state_id: serializeAdminLocationFilter(stateId),
        city_id: serializeAdminLocationFilter(cityId),
        users,
        location_fallback_applied: locationFallbackApplied,
      },
    });
  } catch (error) {
    console.error("admin_list_users error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.list",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Detalle admin de usuario por ID.
 * Endpoint: GET /api/v1/admin/users/:id
 */
export const admin_get_user = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const user = await (repository as any).admin_get_user_by_id?.(targetUserId);
    if (!user) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
        code: 404,
      });
    }

    const locationRefs = loadLocationCatalogRefs();
    const normalizedUser = normalizeAdminUserRow(user, locationRefs);
    let normalizedUserWithCounts = normalizedUser;
    try {
      const counts = await followerRepository.getCounts(targetUserId);
      normalizedUserWithCounts = withFollowCountAliases(normalizedUser, counts);
    } catch (error) {
      console.error("admin_get_user follow counts enrich error:", error);
      normalizedUserWithCounts = withFollowCountAliases(normalizedUser, null);
    }
    const latestVerificationRequest = await ProfileVerificationRequest.findOne({
      where: { userId: targetUserId },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });
    const verificationRequest = normalizeAdminVerificationRequest(
      req,
      latestVerificationRequest
    );

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.get",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
    });

    const verificationImages = verificationRequest?.images ?? null;
    const userWithVerification = {
      ...normalizedUserWithCounts,
      profile_verification_latest_request: verificationRequest,
      verification_images: verificationImages,
      verification_selfie_image_id: verificationImages?.selfie_image_id ?? null,
      verification_document_front_image_id:
        verificationImages?.document_front_image_id ?? null,
      verification_document_back_image_id:
        verificationImages?.document_back_image_id ?? null,
      verification_selfie_with_document_image_id:
        verificationImages?.selfie_with_document_image_id ?? null,
      verification_selfie_url: verificationImages?.selfie_url ?? null,
      verification_document_front_url: verificationImages?.document_front_url ?? null,
      verification_document_back_url: verificationImages?.document_back_url ?? null,
      verification_selfie_with_document_url:
        verificationImages?.selfie_with_document_url ?? null,
    };

    return formatResponse({
      res,
      success: true,
      body: {
        user: userWithVerification,
        profile_verification: {
          latest_request: verificationRequest,
          images: verificationImages,
        },
      },
    });
  } catch (error) {
    console.error("admin_get_user error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.get",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista global de publicaciones (mural) para admin.
 * Endpoint: GET /api/v1/admin/users/mural/posts?page=1&limit=20&include_deleted=0
 */
export const admin_list_mural_posts = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const offset = (page - 1) * limit;

    const where: any = {};
    if (!includeDeleted) where.is_delete = false;

    const postsResult = await Post.findAndCountAll({
      where,
      attributes: {
        exclude: ["createdAt", "updatedAt"],
        include: [[ADMIN_POST_COMMENT_COUNT_LITERAL, "comments_count"]],
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
        {
          model: MediaPost,
          as: "post_media",
          attributes: ["id", "url", "is_img"],
          required: false,
          separate: true,
          order: [["createdAt", "ASC"]],
        },
      ],
      order: [
        ["created_date", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const posts = (postsResult.rows ?? []).map(normalizeAdminPostRow).filter(Boolean);
    const count = Number(postsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.posts.list",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
        posts,
      },
    });
  } catch (error) {
    console.error("admin_list_mural_posts error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.posts.list",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista publicaciones de un usuario para admin.
 * Endpoint: GET /api/v1/admin/users/:id/posts?page=1&limit=20&include_deleted=0
 */
export const admin_list_user_posts = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const rawTargetId = String((req.params as any)?.id ?? "").trim().toLowerCase();
    // Compatibilidad defensiva: si algún proxy/front enruta mural como :id,
    // redirigimos al listado global en vez de responder "invalid user id".
    if (rawTargetId === "mural") {
      return admin_list_mural_posts(req, res);
    }
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const offset = (page - 1) * limit;

    const where: any = {
      userId: targetUserId,
    };
    if (!includeDeleted) where.is_delete = false;

    const postsResult = await Post.findAndCountAll({
      where,
      attributes: {
        exclude: ["createdAt", "updatedAt"],
        include: [[ADMIN_POST_COMMENT_COUNT_LITERAL, "comments_count"]],
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
        {
          model: MediaPost,
          as: "post_media",
          attributes: ["id", "url", "is_img"],
          required: false,
          separate: true,
          order: [["createdAt", "ASC"]],
        },
      ],
      order: [
        ["created_date", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const posts = (postsResult.rows ?? []).map(normalizeAdminPostRow).filter(Boolean);
    const count = Number(postsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        page,
        limit,
        count,
        include_deleted: includeDeleted,
        posts,
      },
    });
  } catch (error) {
    console.error("admin_list_user_posts error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Detalle de publicación de usuario para admin (incluye comentarios).
 * Endpoint: GET /api/v1/admin/users/:id/posts/:postId
 */
export const admin_get_user_post = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const postId = readTargetPostId(req);
    if (!targetUserId || !postId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or post id",
        code: 400,
      });
    }

    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const includeDeletedComments = parseQueryBool(
      (req.query as any)?.include_deleted_comments ?? (req.query as any)?.includeDeletedComments,
      false
    );

    const where: any = {
      id: postId,
      userId: targetUserId,
    };
    if (!includeDeleted) where.is_delete = false;

    const post = await Post.findOne({
      where,
      attributes: {
        exclude: ["createdAt", "updatedAt"],
        include: [[ADMIN_POST_COMMENT_COUNT_LITERAL, "comments_count"]],
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
        {
          model: MediaPost,
          as: "post_media",
          attributes: ["id", "url", "is_img"],
          required: false,
          separate: true,
          order: [["createdAt", "ASC"]],
        },
        {
          model: Comment,
          as: "comments",
          attributes: [
            "id",
            "userId",
            "postId",
            "comment",
            "media_url",
            "is_delete",
            "created_date",
            "deleted_date",
          ],
          required: false,
          separate: true,
          where: includeDeletedComments ? undefined : { is_delete: false },
          order: [["created_date", "DESC"]],
          include: [
            {
              model: User,
              as: "commentator",
              attributes: [
                "id",
                "name",
                "last_name",
                "username",
                "image_profil",
                "profile_verified",
                "profile_verification_status",
              ],
              required: false,
            },
          ],
        },
      ],
    });

    if (!post) {
      return formatResponse({
        res,
        success: false,
        message: "post not found",
        code: 404,
      });
    }

    const normalizedPost = normalizeAdminPostRow(post);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.get",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        post_id: postId,
        include_deleted: includeDeleted,
        include_deleted_comments: includeDeletedComments,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        post_id: postId,
        post: normalizedPost,
      },
    });
  } catch (error) {
    console.error("admin_get_user_post error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.get",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista comentarios de una publicación de usuario para admin.
 * Endpoint: GET /api/v1/admin/users/:id/posts/:postId/comments
 */
export const admin_list_user_post_comments = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const postId = readTargetPostId(req);
    if (!targetUserId || !postId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or post id",
        code: 400,
      });
    }

    const includeDeletedPost = parseQueryBool(
      (req.query as any)?.include_deleted_post ?? (req.query as any)?.includeDeletedPost,
      true
    );
    const includeDeletedComments = parseQueryBool(
      (req.query as any)?.include_deleted_comments ?? (req.query as any)?.includeDeletedComments,
      false
    );

    const postWhere: any = { id: postId, userId: targetUserId };
    if (!includeDeletedPost) postWhere.is_delete = false;
    const post = await Post.findOne({
      where: postWhere,
      attributes: ["id", "is_delete", "userId"],
    });
    if (!post) {
      return formatResponse({
        res,
        success: false,
        message: "post not found",
        code: 404,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;

    const commentWhere: any = { postId };
    if (!includeDeletedComments) commentWhere.is_delete = false;

    const commentsResult = await Comment.findAndCountAll({
      where: commentWhere,
      attributes: [
        "id",
        "userId",
        "postId",
        "comment",
        "media_url",
        "is_delete",
        "created_date",
        "deleted_date",
      ],
      include: [
        {
          model: User,
          as: "commentator",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
      ],
      order: [
        ["created_date", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const comments = (commentsResult.rows ?? [])
      .map(normalizeAdminCommentRow)
      .filter(Boolean);
    const count = Number(commentsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.comments.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        post_id: postId,
        page,
        limit,
        count,
        include_deleted_comments: includeDeletedComments,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        post_id: postId,
        page,
        limit,
        count,
        include_deleted_comments: includeDeletedComments,
        comments,
      },
    });
  } catch (error) {
    console.error("admin_list_user_post_comments error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.comments.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Elimina una publicación de un usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/posts/:postId
 */
export const admin_delete_user_post = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const postId = readTargetPostId(req);
    if (!targetUserId || !postId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or post id",
        code: 400,
      });
    }

    const post = await Post.findOne({
      where: { id: postId, userId: targetUserId },
      attributes: ["id", "userId", "is_delete"],
    });
    if (!post) {
      return formatResponse({
        res,
        success: false,
        message: "post not found",
        code: 404,
      });
    }

    if (Boolean((post as any)?.is_delete)) {
      return formatResponse({
        res,
        success: true,
        body: {
          user_id: targetUserId,
          post_id: postId,
          already_deleted: true,
        },
        message: "Post already deleted",
      });
    }

    const previousPostIdParam = (req.params as any)?.id;
    (req.params as any).id = String(postId);
    const result = await deletePostAdminUseCase(req, res);
    (req.params as any).id = previousPostIdParam;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.delete",
      level: "warn",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        post_id: postId,
      },
    });

    return result;
  } catch (error) {
    console.error("admin_delete_user_post error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.posts.delete",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista global de reels (mural) para admin.
 * Endpoint: GET /api/v1/admin/users/mural/reels?page=1&limit=20&include_deleted=0
 */
export const admin_list_mural_reels = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const offset = (page - 1) * limit;

    const where: any = {};
    if (!includeDeleted) where.is_delete = false;

    const reelsResult = await Reel.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
      ],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const reels = (reelsResult.rows ?? []).map(normalizeAdminReelRow).filter(Boolean);
    const count = Number(reelsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.reels.list",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
        reels,
      },
    });
  } catch (error) {
    console.error("admin_list_mural_reels error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.reels.list",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista videos (reels) de un usuario para admin.
 * Endpoint: GET /api/v1/admin/users/:id/reels?page=1&limit=20&include_deleted=0
 */
export const admin_list_user_reels = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const rawTargetId = String((req.params as any)?.id ?? "").trim().toLowerCase();
    // Compatibilidad defensiva: si un proxy/front enruta mural como :id,
    // devolvemos el listado global en lugar de "invalid user id".
    if (rawTargetId === "mural") {
      return admin_list_mural_reels(req, res);
    }
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const offset = (page - 1) * limit;

    const where: any = { userId: targetUserId };
    if (!includeDeleted) where.is_delete = false;

    const reelsResult = await Reel.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
      ],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const reels = (reelsResult.rows ?? []).map(normalizeAdminReelRow).filter(Boolean);
    const count = Number(reelsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        include_deleted: includeDeleted,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        page,
        limit,
        count,
        include_deleted: includeDeleted,
        reels,
      },
    });
  } catch (error) {
    console.error("admin_list_user_reels error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Detalle de video (reel) de usuario para admin (incluye comentarios).
 * Endpoint: GET /api/v1/admin/users/:id/reels/:reelId
 */
export const admin_get_user_reel = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const reelId = readTargetReelId(req);
    if (!targetUserId || !reelId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or reel id",
        code: 400,
      });
    }

    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const includeDeletedComments = parseQueryBool(
      (req.query as any)?.include_deleted_comments ?? (req.query as any)?.includeDeletedComments,
      false
    );

    const where: any = {
      id: reelId,
      userId: targetUserId,
    };
    if (!includeDeleted) where.is_delete = false;

    const reel = await Reel.findOne({
      where,
      include: [
        {
          model: User,
          as: "user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
        {
          model: ReelComment,
          as: "reel_comments",
          attributes: [
            "id",
            "userId",
            "reelId",
            "comment",
            "media_url",
            "is_delete",
            "createdAt",
            "deleted_date",
          ],
          required: false,
          separate: true,
          where: includeDeletedComments ? undefined : { is_delete: false },
          order: [["createdAt", "DESC"]],
          include: [
            {
              model: User,
              as: "comment_user",
              attributes: [
                "id",
                "name",
                "last_name",
                "username",
                "image_profil",
                "profile_verified",
                "profile_verification_status",
              ],
              required: false,
            },
          ],
        },
      ],
    });

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        message: "reel not found",
        code: 404,
      });
    }

    const normalizedReel = normalizeAdminReelRow(reel);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.get",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        reel_id: reelId,
        include_deleted: includeDeleted,
        include_deleted_comments: includeDeletedComments,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        reel_id: reelId,
        reel: normalizedReel,
      },
    });
  } catch (error) {
    console.error("admin_get_user_reel error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.get",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista comentarios de un reel de usuario para admin.
 * Endpoint: GET /api/v1/admin/users/:id/reels/:reelId/comments
 */
export const admin_list_user_reel_comments = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const reelId = readTargetReelId(req);
    if (!targetUserId || !reelId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or reel id",
        code: 400,
      });
    }

    const includeDeletedReel = parseQueryBool(
      (req.query as any)?.include_deleted_reel ?? (req.query as any)?.includeDeletedReel,
      true
    );
    const includeDeletedComments = parseQueryBool(
      (req.query as any)?.include_deleted_comments ?? (req.query as any)?.includeDeletedComments,
      false
    );

    const reelWhere: any = { id: reelId, userId: targetUserId };
    if (!includeDeletedReel) reelWhere.is_delete = false;
    const reel = await Reel.findOne({
      where: reelWhere,
      attributes: ["id", "is_delete", "userId"],
    });
    if (!reel) {
      return formatResponse({
        res,
        success: false,
        message: "reel not found",
        code: 404,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;

    const commentWhere: any = { reelId };
    if (!includeDeletedComments) commentWhere.is_delete = false;

    const commentsResult = await ReelComment.findAndCountAll({
      where: commentWhere,
      attributes: [
        "id",
        "userId",
        "reelId",
        "comment",
        "media_url",
        "is_delete",
        "createdAt",
        "deleted_date",
      ],
      include: [
        {
          model: User,
          as: "comment_user",
          attributes: [
            "id",
            "name",
            "last_name",
            "username",
            "image_profil",
            "profile_verified",
            "profile_verification_status",
          ],
          required: false,
        },
      ],
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const comments = (commentsResult.rows ?? [])
      .map(normalizeAdminReelCommentRow)
      .filter(Boolean);
    const count = Number(commentsResult.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.comments.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        reel_id: reelId,
        page,
        limit,
        count,
        include_deleted_comments: includeDeletedComments,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        reel_id: reelId,
        page,
        limit,
        count,
        include_deleted_comments: includeDeletedComments,
        comments,
      },
    });
  } catch (error) {
    console.error("admin_list_user_reel_comments error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.comments.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Elimina un reel de un usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/reels/:reelId
 */
export const admin_delete_user_reel = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const reelId = readTargetReelId(req);
    if (!targetUserId || !reelId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or reel id",
        code: 400,
      });
    }

    const reel = await Reel.findOne({
      where: { id: reelId, userId: targetUserId },
      attributes: ["id", "userId", "is_delete"],
    });
    if (!reel) {
      return formatResponse({
        res,
        success: false,
        message: "reel not found",
        code: 404,
      });
    }

    if (Boolean((reel as any)?.is_delete)) {
      return formatResponse({
        res,
        success: true,
        body: {
          user_id: targetUserId,
          reel_id: reelId,
          already_deleted: true,
        },
        message: "Reel already deleted",
      });
    }

    await Reel.update(
      {
        is_delete: true,
        deleted_date: new Date(),
      },
      { where: { id: reelId } }
    );

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.delete",
      level: "warn",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        reel_id: reelId,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        reel_id: reelId,
        deleted: true,
      },
      message: "Reel deleted successfully",
    });
  } catch (error) {
    console.error("admin_delete_user_reel error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reels.delete",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista global de ofertas de trabajo (services) para mural admin.
 * Endpoint: GET /api/v1/admin/users/mural/services?page=1&limit=20&status=all&include_deleted=0
 */
export const admin_list_mural_services = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;
    const statusId = parseAdminServiceStatusId((req.query as any)?.status);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const serviceMode = parseAdminServiceMode(
      (req.query as any)?.service_mode ?? (req.query as any)?.serviceMode
    );
    const categoryId = toNumberOrNull(
      (req.query as any)?.category_id ?? (req.query as any)?.categoryId
    );
    const q = String((req.query as any)?.q ?? "").trim();

    let countryId = parseAdminLocationFilter(
      (req.query as any)?.country_id ?? (req.query as any)?.countryId
    );
    let stateId = parseAdminLocationFilter(
      (req.query as any)?.state_id ?? (req.query as any)?.stateId
    );
    let cityId = parseAdminLocationFilter(
      (req.query as any)?.city_id ?? (req.query as any)?.cityId
    );

    const locationRefs = loadLocationCatalogRefs();
    ({ countryId, stateId, cityId } = sanitizeAdminLocationFilters(
      { countryId, stateId, cityId },
      locationRefs
    ));

    const where: any = buildAdminMuralServicesWhere({
      includeDeleted,
      statusId,
      serviceMode,
      categoryId,
      q,
      countryId,
      stateId,
      cityId,
    });

    const servicesResult = await Service.findAndCountAll({
      where,
      attributes: {
        include: [
          [ADMIN_SERVICE_OFFERS_COUNT_LITERAL, "offers_count"],
          [ADMIN_SERVICE_OFFERS_COUNT_LITERAL, "applicants_count"],
          [ADMIN_SERVICE_ACCEPTED_WORKERS_COUNT_LITERAL, "accepted_workers_count"],
        ],
      },
      include: adminServiceInclude as any,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const services = (servicesResult.rows ?? [])
      .map((row: any) => normalizeAdminServiceRow(row, locationRefs))
      .filter(Boolean);
    const count = Number((servicesResult as any)?.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.services.list",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        status_id: statusId,
        include_deleted: includeDeleted,
        service_mode: serviceMode,
        category_id: categoryId ?? null,
        q: q || null,
        country_id: serializeAdminLocationFilter(countryId),
        state_id: serializeAdminLocationFilter(stateId),
        city_id: serializeAdminLocationFilter(cityId),
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        status: (req.query as any)?.status ?? "all",
        include_deleted: includeDeleted,
        service_mode: serviceMode,
        category_id: categoryId ?? null,
        q,
        country_id: serializeAdminLocationFilter(countryId),
        state_id: serializeAdminLocationFilter(stateId),
        city_id: serializeAdminLocationFilter(cityId),
        services,
      },
    });
  } catch (error) {
    console.error("admin_list_mural_services error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.services.list",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Resumen de filtros del mural de services (country/state/city/category).
 * Endpoint: GET /api/v1/admin/users/mural/services/location/summary
 */
export const admin_mural_services_location_summary = async (
  req: Request,
  res: Response
) => {
  try {
    const actorUserId = readActorUserId(req);
    const statusId = parseAdminServiceStatusId((req.query as any)?.status);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const serviceMode = parseAdminServiceMode(
      (req.query as any)?.service_mode ?? (req.query as any)?.serviceMode
    );
    const categoryId = toNumberOrNull(
      (req.query as any)?.category_id ?? (req.query as any)?.categoryId
    );
    const q = String((req.query as any)?.q ?? "").trim();

    let countryId = parseAdminLocationFilter(
      (req.query as any)?.country_id ?? (req.query as any)?.countryId
    );
    let stateId = parseAdminLocationFilter(
      (req.query as any)?.state_id ?? (req.query as any)?.stateId
    );
    let cityId = parseAdminLocationFilter(
      (req.query as any)?.city_id ?? (req.query as any)?.cityId
    );

    const locationRefs = loadLocationCatalogRefs();
    ({ countryId, stateId, cityId } = sanitizeAdminLocationFilters(
      { countryId, stateId, cityId },
      locationRefs
    ));

    const where: any = buildAdminMuralServicesWhere({
      includeDeleted,
      statusId,
      serviceMode,
      categoryId,
      q,
      countryId,
      stateId,
      cityId,
    });

    const rows = await Service.findAll({
      where,
      include: adminServiceInclude as any,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });

    const services = (rows ?? [])
      .map((row: any) => normalizeAdminServiceRow(row, locationRefs))
      .filter(Boolean);

    const countriesAgg = new Map<string, any>();
    const statesAgg = new Map<string, any>();
    const citiesAgg = new Map<string, any>();
    const categoriesAgg = new Map<string, any>();

    const addToAgg = (map: Map<string, any>, key: string, seed: any) => {
      const current = map.get(key);
      if (current) {
        current.count = Number(current.count ?? 0) + 1;
        return;
      }
      map.set(key, { ...seed, count: 1 });
    };

    services.forEach((service: any) => {
      const countryIdNorm = toNumberOrNull(service?.country_residence_id);
      const stateIdNorm = toNumberOrNull(service?.state_residence_id);
      const cityIdNorm = toNumberOrNull(service?.city_residence_id);
      const countryNameNorm = String(service?.country_residence_name ?? "").trim() || null;
      const stateNameNorm = String(service?.state_residence_name ?? "").trim() || null;
      const cityNameNorm = String(service?.city_residence_name ?? "").trim() || null;
      const categoryIdNorm = toNumberOrNull(service?.category_id);
      const categoryNameNorm = String(service?.category_name ?? "").trim() || null;
      const categoryEsNameNorm = String(service?.category_es_name ?? "").trim() || null;

      if (countryIdNorm) {
        addToAgg(
          countriesAgg,
          `c:${countryIdNorm}`,
          {
            country_id: countryIdNorm,
            id: countryIdNorm,
            country_name: countryNameNorm,
            name: countryNameNorm,
          }
        );
      }

      if (stateIdNorm) {
        addToAgg(
          statesAgg,
          `s:${countryIdNorm ?? "null"}:${stateIdNorm}`,
          {
            country_id: countryIdNorm,
            state_id: stateIdNorm,
            id: stateIdNorm,
            state_name: stateNameNorm,
            name: stateNameNorm,
          }
        );
      }

      if (cityIdNorm) {
        addToAgg(
          citiesAgg,
          `ct:${countryIdNorm ?? "null"}:${stateIdNorm ?? "null"}:${cityIdNorm}:${normalizeLocationText(
            cityNameNorm ?? ""
          )}`,
          {
            country_id: countryIdNorm,
            state_id: stateIdNorm,
            city_id: cityIdNorm,
            id: cityIdNorm,
            city_name: cityNameNorm,
            name: cityNameNorm,
          }
        );
      }

      addToAgg(
        categoriesAgg,
        `cat:${categoryIdNorm ?? "null"}`,
        {
          category_id: categoryIdNorm,
          id: categoryIdNorm,
          category_name: categoryNameNorm ?? (categoryIdNorm ? null : "null"),
          name: categoryNameNorm ?? (categoryIdNorm ? null : "null"),
          category_es_name: categoryEsNameNorm ?? null,
          es_name: categoryEsNameNorm ?? null,
        }
      );
    });

    const countries = Array.from(countriesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );
    const states = Array.from(statesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );
    const cities = Array.from(citiesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );
    const categories = Array.from(categoriesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );

    const remoteServices = services.reduce(
      (acc: number, service: any) => (service?.service_mode === "remote" ? acc + 1 : acc),
      0
    );
    const unknownCountryServices = services.reduce(
      (acc: number, service: any) =>
        toNumberOrNull(service?.country_residence_id) ? acc : acc + 1,
      0
    );
    const unknownStateServices = services.reduce(
      (acc: number, service: any) =>
        toNumberOrNull(service?.state_residence_id) ? acc : acc + 1,
      0
    );
    const unknownCityServices = services.reduce(
      (acc: number, service: any) =>
        toNumberOrNull(service?.city_residence_id) ? acc : acc + 1,
      0
    );

    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.services.location_summary",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        status_id: statusId,
        include_deleted: includeDeleted,
        service_mode: serviceMode,
        category_id: categoryId ?? null,
        q: q || null,
        country_id: serializeAdminLocationFilter(countryId),
        state_id: serializeAdminLocationFilter(stateId),
        city_id: serializeAdminLocationFilter(cityId),
        total_services: services.length,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        filters: {
          status: (req.query as any)?.status ?? "all",
          include_deleted: includeDeleted,
          service_mode: serviceMode,
          category_id: categoryId ?? null,
          q,
          country_id: serializeAdminLocationFilter(countryId),
          state_id: serializeAdminLocationFilter(stateId),
          city_id: serializeAdminLocationFilter(cityId),
        },
        totals: {
          services: services.length,
          remote_services: remoteServices,
        },
        unknown_country_services: unknownCountryServices,
        unknown_state_services: unknownStateServices,
        unknown_city_services: unknownCityServices,
        countries,
        states,
        cities,
        categories,
      },
    });
  } catch (error) {
    console.error("admin_mural_services_location_summary error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.mural.services.location_summary",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista services de un usuario para admin.
 * Endpoint: GET /api/v1/admin/users/:id/services?page=1&limit=20&status=all&include_deleted=0
 */
export const admin_list_user_services = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const rawTargetId = String((req.params as any)?.id ?? "").trim().toLowerCase();
    // Compatibilidad defensiva: si un proxy/front enruta mural como :id,
    // devolvemos listado global en lugar de "invalid user id".
    if (rawTargetId === "mural") {
      return admin_list_mural_services(req, res);
    }
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;
    const statusId = parseAdminServiceStatusId((req.query as any)?.status);
    const includeDeleted = parseQueryBool(
      (req.query as any)?.include_deleted ?? (req.query as any)?.includeDeleted,
      false
    );
    const serviceMode = parseAdminServiceMode(
      (req.query as any)?.service_mode ?? (req.query as any)?.serviceMode
    );
    const categoryId = toNumberOrNull(
      (req.query as any)?.category_id ?? (req.query as any)?.categoryId
    );
    const q = String((req.query as any)?.q ?? "").trim();

    const where: any = buildAdminMuralServicesWhere({
      includeDeleted,
      statusId,
      serviceMode,
      categoryId,
      q,
      countryId: null,
      stateId: null,
      cityId: null,
    });

    where.userId = targetUserId;

    const servicesResult = await Service.findAndCountAll({
      where,
      attributes: {
        include: [
          [ADMIN_SERVICE_OFFERS_COUNT_LITERAL, "offers_count"],
          [ADMIN_SERVICE_OFFERS_COUNT_LITERAL, "applicants_count"],
          [ADMIN_SERVICE_ACCEPTED_WORKERS_COUNT_LITERAL, "accepted_workers_count"],
        ],
      },
      include: adminServiceInclude as any,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit,
      offset,
      distinct: true,
    });

    const services = (servicesResult.rows ?? [])
      .map((row: any) => normalizeAdminServiceRow(row, null))
      .filter(Boolean);
    const count = Number((servicesResult as any)?.count ?? 0) || 0;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        status_id: statusId,
        include_deleted: includeDeleted,
        service_mode: serviceMode,
        category_id: categoryId ?? null,
        q: q || null,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        page,
        limit,
        count,
        status: (req.query as any)?.status ?? "all",
        include_deleted: includeDeleted,
        service_mode: serviceMode,
        category_id: categoryId ?? null,
        q,
        services,
      },
    });
  } catch (error) {
    console.error("admin_list_user_services error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista postulaciones de un usuario trabajador para admin.
 * Endpoint: GET /api/v1/admin/users/:id/worker-applications?page=1&limit=50&status=all
 */
export const admin_list_user_worker_applications = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 50;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const scope = parseAdminWorkerApplicationsStatus((req.query as any)?.status);
    const offset = (page - 1) * limit;

    const workerIds = await resolveWorkerIdsByUserId(targetUserId);
    if (!workerIds.length) {
      return formatResponse({
        res,
        success: true,
        body: {
          user_id: targetUserId,
          page,
          limit,
          status: scope,
          count: 0,
          counts: {
            total: 0,
            applied: 0,
            selectedInProgress: 0,
            selected_in_progress: 0,
            finalized: 0,
            clientCanceled: 0,
            client_canceled: 0,
            workerCanceled: 0,
            worker_canceled: 0,
            closedNotSelected: 0,
            closed_not_selected: 0,
          },
          applications: [],
        },
      });
    }

    const offerRows = await Offer.findAll({
      where: {
        workerId: workerIds.length === 1 ? workerIds[0] : { [Op.in]: workerIds },
      },
      attributes: [
        "id",
        "serviceId",
        "workerId",
        "accepted",
        "canceled",
        "removed",
        "offer",
        "offer_date",
        "workerClosedAt",
        "createdAt",
      ],
      include: [
        {
          model: Service,
          as: "service",
          required: false,
          attributes: [
            "id",
            "description",
            "statusId",
            "rate",
            "currencyCode",
            "currencyPrefix",
            "createdAt",
            "is_available",
          ],
          include: [
            {
              model: User,
              as: "client",
              required: false,
              attributes: [
                "id",
                "name",
                "last_name",
                "username",
                "image_profil",
              ],
            },
          ],
        },
      ],
      order: [
        ["offer_date", "DESC"],
        ["id", "DESC"],
      ],
    });

    const applicationsAll = (offerRows ?? [])
      .map((rowRaw: any) => {
        const row = toPlain(rowRaw);
        if (!row) return null;

        const service = toPlain((row as any)?.service);
        const client = toPlain((service as any)?.client);
        const serviceStatusId = Number((service as any)?.statusId ?? 0) || 0;
        const state = buildWorkerApplicationState({
          accepted: Boolean((row as any)?.accepted),
          canceled: Boolean((row as any)?.canceled),
          removed: Boolean((row as any)?.removed),
          serviceStatusId,
          workerClosedAt: (row as any)?.workerClosedAt,
        });

        const firstName = String((client as any)?.name ?? "").trim() || null;
        const lastName = String((client as any)?.last_name ?? "").trim() || null;
        const username = String((client as any)?.username ?? "").trim() || null;
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || firstName || username;
        const imageProfil = String((client as any)?.image_profil ?? "").trim() || null;

        const servicePayload = {
          id: Number((service as any)?.id ?? 0) || null,
          description: String((service as any)?.description ?? "").trim() || null,
          status_id: serviceStatusId || null,
          statusId: serviceStatusId || null,
          rate: Number.isFinite(Number((service as any)?.rate))
            ? Number((service as any)?.rate)
            : null,
          currency_prefix:
            String((service as any)?.currencyPrefix ?? "").trim() || null,
          currencyPrefix:
            String((service as any)?.currencyPrefix ?? "").trim() || null,
          currency_code:
            String((service as any)?.currencyCode ?? "").trim() || null,
          currencyCode:
            String((service as any)?.currencyCode ?? "").trim() || null,
        };

        const clientPayload = {
          id: Number((client as any)?.id ?? 0) || null,
          user_id: Number((client as any)?.id ?? 0) || null,
          name: fullName || null,
          first_name: firstName,
          last_name: lastName,
          username,
          image_profil: imageProfil,
          image: imageProfil,
        };

        const createdAt = toIsoOrNull((row as any)?.offer_date ?? (row as any)?.createdAt);

        return {
          id: Number((row as any)?.id ?? 0) || null,
          service_id: Number((row as any)?.serviceId ?? 0) || null,
          worker_id: Number((row as any)?.workerId ?? 0) || null,
          application_state: state.application_state,
          selected: state.selected,
          in_progress: state.in_progress,
          inProgress: state.in_progress,
          finalized: state.finalized,
          client_canceled: state.client_canceled,
          clientCanceled: state.client_canceled,
          worker_canceled: state.worker_canceled,
          workerCanceled: state.worker_canceled,
          closed_not_selected: state.closed_not_selected,
          closedNotSelected: state.closed_not_selected,
          accepted: Boolean((row as any)?.accepted),
          canceled: Boolean((row as any)?.canceled),
          removed: Boolean((row as any)?.removed),
          created_at: createdAt,
          createdAt,
          service: servicePayload,
          client: clientPayload,
        };
      })
      .filter(Boolean) as any[];

    const countsBase = {
      total: applicationsAll.length,
      applied: applicationsAll.filter((row: any) => row.application_state === "applied").length,
      selectedInProgress: applicationsAll.filter(
        (row: any) => row.application_state === "selected_in_progress"
      ).length,
      finalized: applicationsAll.filter((row: any) => row.application_state === "finalized")
        .length,
      clientCanceled: applicationsAll.filter(
        (row: any) => row.application_state === "client_canceled"
      ).length,
      workerCanceled: applicationsAll.filter(
        (row: any) => row.application_state === "worker_canceled"
      ).length,
      closedNotSelected: applicationsAll.filter(
        (row: any) => row.application_state === "closed_not_selected"
      ).length,
    };

    const counts = {
      ...countsBase,
      selected_in_progress: countsBase.selectedInProgress,
      client_canceled: countsBase.clientCanceled,
      worker_canceled: countsBase.workerCanceled,
      closed_not_selected: countsBase.closedNotSelected,
    };

    const scopedApplications = applicationsAll.filter((row: any) =>
      matchesWorkerApplicationScope(scope, row)
    );
    const scopedCount = scopedApplications.length;
    const applications = scopedApplications.slice(offset, offset + limit);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.worker_applications.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        status: scope,
        total_rows: applicationsAll.length,
        scoped_count: scopedCount,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        page,
        limit,
        status: scope,
        count: scopedCount,
        counts,
        applications,
      },
    });
  } catch (error) {
    console.error("admin_list_user_worker_applications error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.worker_applications.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista reportes de usuarios/contenido para admin.
 * Endpoint: GET /api/v1/admin/users/reports?reported_user_id=&page=1&limit=100&type=all&action_status=all
 */
export const admin_list_user_reports = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 50;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;
    const type = parseAdminReportsType((req.query as any)?.type);
    const actionStatus = parseAdminReportActionStatus(
      (req.query as any)?.action_status ?? (req.query as any)?.actionStatus
    );
    const reportedUserId = toOptionalPositiveInt(
      (req.query as any)?.reported_user_id ?? (req.query as any)?.reportedUserId
    );

    // Estado de acción aún no persistido en tablas de reportes:
    // todo reporte actual cae como pendiente.
    if (actionStatus !== "all" && actionStatus !== "pending") {
      return formatResponse({
        res,
        success: true,
        body: {
          page,
          limit,
          count: 0,
          type,
          action_status: actionStatus,
          reported_user_id: reportedUserId ?? null,
          reports: [],
        },
      });
    }

    const reportsUnionSql = `
      SELECT
        ur.id AS report_id,
        CONVERT('user' USING utf8mb4) COLLATE utf8mb4_general_ci AS report_type,
        CONVERT(ur.reason USING utf8mb4) COLLATE utf8mb4_general_ci AS report_reason,
        CONVERT(ur.details USING utf8mb4) COLLATE utf8mb4_general_ci AS report_details,
        ur.createdAt AS reported_at,
        ur.reporterId AS reporter_id,
        ur.reportedUserId AS reported_user_id,
        ur.reportedUserId AS target_id,
        CONVERT(COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', ru.name, ru.last_name)), ''),
          NULLIF(TRIM(ru.username), ''),
          CONCAT('User #', ur.reportedUserId)
        ) USING utf8mb4) COLLATE utf8mb4_general_ci AS target_title,
        CASE
          WHEN COALESCE(ru.is_deleted, 0) = 1
            OR COALESCE(ru.disabled, 0) = 1
            OR COALESCE(ru.available, 1) = 0
          THEN 1
          ELSE 0
        END AS target_deleted
      FROM user_reports ur
      LEFT JOIN users ru ON ru.id = ur.reportedUserId

      UNION ALL

      SELECT
        pr.id AS report_id,
        CONVERT('post' USING utf8mb4) COLLATE utf8mb4_general_ci AS report_type,
        CONVERT(pr.reason USING utf8mb4) COLLATE utf8mb4_general_ci AS report_reason,
        CONVERT(pr.details USING utf8mb4) COLLATE utf8mb4_general_ci AS report_details,
        pr.createdAt AS reported_at,
        pr.reporterId AS reporter_id,
        p.userId AS reported_user_id,
        p.id AS target_id,
        CONVERT(COALESCE(
          NULLIF(TRIM(p.post), ''),
          CONCAT('Post #', p.id)
        ) USING utf8mb4) COLLATE utf8mb4_general_ci AS target_title,
        CASE WHEN COALESCE(p.is_delete, 0) = 1 THEN 1 ELSE 0 END AS target_deleted
      FROM post_reports pr
      LEFT JOIN posts p ON p.id = pr.postId

      UNION ALL

      SELECT
        rr.id AS report_id,
        CONVERT('reel' USING utf8mb4) COLLATE utf8mb4_general_ci AS report_type,
        CONVERT(rr.reason USING utf8mb4) COLLATE utf8mb4_general_ci AS report_reason,
        CONVERT(rr.details USING utf8mb4) COLLATE utf8mb4_general_ci AS report_details,
        rr.createdAt AS reported_at,
        rr.reporterId AS reporter_id,
        rl.userId AS reported_user_id,
        rl.id AS target_id,
        CONVERT(COALESCE(
          NULLIF(TRIM(rl.description), ''),
          CONCAT('Reel #', rl.id)
        ) USING utf8mb4) COLLATE utf8mb4_general_ci AS target_title,
        CASE WHEN COALESCE(rl.is_delete, 0) = 1 THEN 1 ELSE 0 END AS target_deleted
      FROM reel_reports rr
      LEFT JOIN reels rl ON rl.id = rr.reelId

      UNION ALL

      SELECT
        sr.id AS report_id,
        CONVERT('service' USING utf8mb4) COLLATE utf8mb4_general_ci AS report_type,
        CONVERT(sr.reason USING utf8mb4) COLLATE utf8mb4_general_ci AS report_reason,
        CONVERT(sr.details USING utf8mb4) COLLATE utf8mb4_general_ci AS report_details,
        sr.createdAt AS reported_at,
        sr.reporterId AS reporter_id,
        s.userId AS reported_user_id,
        s.id AS target_id,
        CONVERT(COALESCE(
          NULLIF(TRIM(s.description), ''),
          CONCAT('Service #', s.id)
        ) USING utf8mb4) COLLATE utf8mb4_general_ci AS target_title,
        CASE WHEN COALESCE(s.is_available, 1) = 0 THEN 1 ELSE 0 END AS target_deleted
      FROM service_reports sr
      LEFT JOIN services s ON s.id = sr.serviceId
    `;

    const filteredWhereSql = `
      WHERE
        (:typeScope = 'all' OR r.report_type = :typeScope)
        AND (:reportedUserId IS NULL OR r.reported_user_id = :reportedUserId)
    `;

    const replacements = {
      typeScope: type,
      reportedUserId: reportedUserId ?? null,
      limit,
      offset,
    };

    const countSql = `
      SELECT COUNT(1) AS count
      FROM (${reportsUnionSql}) r
      ${filteredWhereSql}
    `;

    const dataSql = `
      SELECT
        r.report_id,
        r.report_type,
        r.report_reason,
        r.report_details,
        r.reported_at,
        0 AS action_taken,
        'pending' AS action_status,
        reporter.id AS reporter_pk,
        reporter.username AS reporter_username,
        reporter.name AS reporter_name,
        reporter.last_name AS reporter_last_name,
        reporter.image_profil AS reporter_image_profil,
        reporter.profile_verified AS reporter_profile_verified,
        reported.id AS reported_pk,
        reported.username AS reported_username,
        reported.name AS reported_name,
        reported.last_name AS reported_last_name,
        reported.image_profil AS reported_image_profil,
        reported.profile_verified AS reported_profile_verified,
        r.target_id,
        r.target_title,
        r.target_deleted
      FROM (${reportsUnionSql}) r
      LEFT JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN users reported ON reported.id = r.reported_user_id
      ${filteredWhereSql}
      ORDER BY r.reported_at DESC, r.report_id DESC
      LIMIT :limit OFFSET :offset
    `;

    const [countRowRaw] = (await sequelize.query(countSql, {
      replacements,
      type: QueryTypes.SELECT,
      raw: true,
    })) as any[];

    const rows = (await sequelize.query(dataSql, {
      replacements,
      type: QueryTypes.SELECT,
      raw: true,
    })) as any[];

    const count = Number((countRowRaw as any)?.count ?? 0) || 0;

    const reports = (rows ?? []).map((row: any) => {
      const reporterId = Number((row as any)?.reporter_pk ?? 0) || null;
      const reportedPk = Number((row as any)?.reported_pk ?? 0) || null;
      return {
        report_id: Number((row as any)?.report_id ?? 0) || null,
        report_type: String((row as any)?.report_type ?? "").trim() || null,
        report_reason: String((row as any)?.report_reason ?? "").trim() || "something_else",
        report_details: String((row as any)?.report_details ?? "").trim() || null,
        reported_at: toIsoOrNull((row as any)?.reported_at),
        action_taken: Boolean((row as any)?.action_taken),
        action_status: String((row as any)?.action_status ?? "pending").trim() || "pending",
        reporter: {
          id: reporterId,
          username: String((row as any)?.reporter_username ?? "").trim() || null,
          name: String((row as any)?.reporter_name ?? "").trim() || null,
          last_name: String((row as any)?.reporter_last_name ?? "").trim() || null,
          image_profil: String((row as any)?.reporter_image_profil ?? "").trim() || null,
          profile_verified: toBool((row as any)?.reporter_profile_verified),
        },
        reported_user: {
          id: reportedPk,
          username: String((row as any)?.reported_username ?? "").trim() || null,
          name: String((row as any)?.reported_name ?? "").trim() || null,
          last_name: String((row as any)?.reported_last_name ?? "").trim() || null,
          image_profil: String((row as any)?.reported_image_profil ?? "").trim() || null,
          profile_verified: toBool((row as any)?.reported_profile_verified),
        },
        target: {
          id: Number((row as any)?.target_id ?? 0) || null,
          target_title: String((row as any)?.target_title ?? "").trim() || null,
          target_deleted: Boolean((row as any)?.target_deleted),
        },
      };
    });

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reports.list",
      level: "info",
      actorUserId,
      targetUserId: reportedUserId ?? undefined,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        count,
        type,
        action_status: actionStatus,
        reported_user_id: reportedUserId ?? null,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        type,
        action_status: actionStatus,
        reported_user_id: reportedUserId ?? null,
        reports,
      },
    });
  } catch (error) {
    if (isMissingReportsStorageError(error)) {
      writeSecurityAuditFromRequest(req, {
        event: "admin.user.reports.list",
        level: "warn",
        actorUserId: readActorUserId(req),
        targetUserId: toOptionalPositiveInt(
          (req.query as any)?.reported_user_id ?? (req.query as any)?.reportedUserId
        ),
        success: true,
        reason: "reports_storage_missing",
      });
      return formatResponse({
        res,
        success: true,
        body: {
          page: toOptionalPositiveInt((req.query as any)?.page) ?? 1,
          limit: Math.min(Math.max(toOptionalPositiveInt((req.query as any)?.limit) ?? 50, 1), 100),
          count: 0,
          reports: [],
        },
      });
    }

    console.error("admin_list_user_reports error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.reports.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: toOptionalPositiveInt(
        (req.query as any)?.reported_user_id ?? (req.query as any)?.reportedUserId
      ),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Push individual desde admin.
 * Endpoint: POST /api/v1/admin/users/:id/push
 */
export const admin_push_user = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const title = String((req.body as any)?.title ?? "").trim();
    const messageText = String((req.body as any)?.message ?? "").trim();
    const dryRun = parseQueryBool((req.body as any)?.dry_run ?? (req.body as any)?.dryRun, false);
    const deeplink = String((req.body as any)?.deeplink ?? "").trim() || null;
    if (!title || !messageText) {
      return formatResponse({
        res,
        success: false,
        message: "title and message are required",
        code: 400,
      });
    }

    const recipients = await resolveAdminPushRecipients({
      userIds: [targetUserId],
      status: "all",
      role: "all",
      countryId: null,
      stateId: null,
      cityId: null,
    });

    if (!recipients.length) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
        code: 404,
      });
    }

    const recipient = recipients[0];
    const tokensCount = recipient?.tokens?.length ?? 0;
    const pushType: TypeNotification = "admin";
    let enqueued = 0;
    if (!dryRun && tokensCount > 0) {
      await enqueuePushJob({
        userId: targetUserId,
        notificationId: `admin-push-${Date.now()}-${targetUserId}`,
        tokens: recipient.tokens,
        title,
        body: messageText,
        type: pushType,
        extraData: {
          route: "admin_push",
          ...(deeplink ? { deeplink } : {}),
          ...(actorUserId ? { actorUserId } : {}),
        },
      });
      enqueued = 1;
    }

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.push.single",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        dry_run: dryRun,
        title_length: title.length,
        message_length: messageText.length,
        tokens_count: tokensCount,
        enqueued_jobs: enqueued,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        dry_run: dryRun,
        deeplink,
        tokens_count: tokensCount,
        enqueued_jobs: enqueued,
      },
      message: dryRun
        ? "dry run completed"
        : tokensCount > 0
        ? "push queued"
        : "user has no valid push tokens",
    });
  } catch (error) {
    console.error("admin_push_user error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.push.single",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Push masivo desde admin.
 * Endpoint: POST /api/v1/admin/users/push
 */
export const admin_push_users = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const title = String((req.body as any)?.title ?? "").trim();
    const messageText = String((req.body as any)?.message ?? "").trim();
    const dryRun = parseQueryBool((req.body as any)?.dry_run ?? (req.body as any)?.dryRun, false);
    const deeplink = String((req.body as any)?.deeplink ?? "").trim() || null;
    if (!title || !messageText) {
      return formatResponse({
        res,
        success: false,
        message: "title and message are required",
        code: 400,
      });
    }

    const bodyAny: any = req.body ?? {};
    const selectedUserIds = parseBodyUserIds(bodyAny?.user_ids ?? bodyAny?.userIds);
    const status = parseAdminPushStatus(bodyAny?.status);
    const role = parseAdminPushRole(bodyAny?.role);
    const countryId = toOptionalPositiveInt(bodyAny?.country_id ?? bodyAny?.countryId);
    const stateId = toOptionalPositiveInt(bodyAny?.state_id ?? bodyAny?.stateId);
    const cityId = toOptionalPositiveInt(bodyAny?.city_id ?? bodyAny?.cityId);

    const recipients = await resolveAdminPushRecipients({
      userIds: selectedUserIds,
      status: selectedUserIds.length ? "all" : status,
      role: selectedUserIds.length ? "all" : role,
      countryId: selectedUserIds.length ? null : countryId,
      stateId: selectedUserIds.length ? null : stateId,
      cityId: selectedUserIds.length ? null : cityId,
    });

    const withTokens = recipients.filter((row) => row.tokens.length > 0);
    const withoutTokens = recipients.length - withTokens.length;
    const totalTokens = withTokens.reduce(
      (acc, row) => acc + (Array.isArray(row.tokens) ? row.tokens.length : 0),
      0
    );

    const pushType: TypeNotification = "admin";
    let enqueuedJobs = 0;
    if (!dryRun) {
      for (const recipient of withTokens) {
        await enqueuePushJob({
          userId: recipient.userId,
          notificationId: `admin-push-${Date.now()}-${recipient.userId}`,
          tokens: recipient.tokens,
          title,
          body: messageText,
          type: pushType,
          extraData: {
            route: "admin_push",
            ...(deeplink ? { deeplink } : {}),
            ...(actorUserId ? { actorUserId } : {}),
          },
        });
        enqueuedJobs += 1;
      }
    }

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.push.bulk",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        dry_run: dryRun,
        title_length: title.length,
        message_length: messageText.length,
        selected_user_ids_count: selectedUserIds.length,
        filters: selectedUserIds.length
          ? null
          : {
              status,
              role,
              country_id: countryId ?? null,
              state_id: stateId ?? null,
              city_id: cityId ?? null,
            },
        matched_users: recipients.length,
        with_tokens: withTokens.length,
        without_tokens: withoutTokens,
        total_tokens: totalTokens,
        enqueued_jobs: enqueuedJobs,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        dry_run: dryRun,
        deeplink,
        selected_user_ids: selectedUserIds,
        filters: selectedUserIds.length
          ? null
          : {
              status,
              role,
              country_id: countryId ?? null,
              state_id: stateId ?? null,
              city_id: cityId ?? null,
            },
        users_count: recipients.length,
        users_with_tokens_count: withTokens.length,
        users_without_tokens_count: withoutTokens,
        tokens_count: totalTokens,
        enqueued_jobs: enqueuedJobs,
      },
      message: dryRun ? "dry run completed" : "push queued",
    });
  } catch (error) {
    console.error("admin_push_users error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.push.bulk",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista historial de chats admin (activos/finalizados).
 * Endpoint: GET /api/v1/admin/users/chat/history?page=1&limit=20&status=all|active|finalized&q=
 */
export const admin_list_chat_history = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);
    const actorUserId = readActorUserId(req);
    if (!actorUserId) {
      return formatResponse({
        res,
        success: false,
        message: "admin user id is missing",
        code: 401,
      });
    }

    const page = toOptionalPositiveInt((req.query as any)?.page) ?? 1;
    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = (page - 1) * limit;
    const status = parseAdminChatHistoryStatus((req.query as any)?.status);
    const q = String((req.query as any)?.q ?? "").trim();
    const targetUserId = toOptionalPositiveInt(
      (req.query as any)?.user_id ?? (req.query as any)?.userId
    );

    const statusFilterSql =
      status === "finalized"
        ? "AND c.deletedBy = -1"
        : status === "active"
        ? "AND c.deletedBy <> -1"
        : "";
    const qFilterSql = q
      ? `
        AND (
          u.username LIKE :qLike
          OR CONCAT_WS(' ', u.name, u.last_name) LIKE :qLike
        )
      `
      : "";
    const targetFilterSql = targetUserId ? "AND u.id = :targetUserId" : "";

    const replacements: Record<string, any> = {
      actorUserId,
      limit,
      offset,
      ...(q ? { qLike: `%${q}%` } : {}),
      ...(targetUserId ? { targetUserId } : {}),
    };

    const countRows = (await sequelize.query(
      `
        SELECT COUNT(DISTINCT c.id) AS count
        FROM chat_user cu1
        INNER JOIN chat_user cu2
          ON cu2.chatId = cu1.chatId
         AND cu2.userId <> :actorUserId
        LEFT JOIN chat_groups cg
          ON cg.chatId = cu1.chatId
        INNER JOIN chats c
          ON c.id = cu1.chatId
        INNER JOIN users u
          ON u.id = cu2.userId
        WHERE cu1.userId = :actorUserId
          AND cg.chatId IS NULL
          AND COALESCE(u.is_deleted, 0) = 0
          ${statusFilterSql}
          ${targetFilterSql}
          ${qFilterSql}
      `,
      { replacements, type: QueryTypes.SELECT }
    )) as Array<{ count?: number | string | null }>;
    const count = Number(countRows?.[0]?.count ?? 0) || 0;

    const rows = (await sequelize.query(
      `
        SELECT
          c.id AS chat_id,
          c.deletedBy AS deleted_by,
          u.id AS user_id,
          u.name AS user_name,
          u.last_name AS user_last_name,
          u.username AS user_username,
          u.image_profil AS user_image_profil,
          u.profile_verified AS user_profile_verified,
          u.profile_verification_status AS user_profile_verification_status,
          m.id AS last_message_id,
          m.senderId AS last_sender_id,
          m.text AS last_message_text,
          m.messageType AS last_message_type,
          m.mediaUrl AS last_media_url,
          m.date AS last_message_date,
          m.status AS last_message_status
        FROM chat_user cu1
        INNER JOIN chat_user cu2
          ON cu2.chatId = cu1.chatId
         AND cu2.userId <> :actorUserId
        LEFT JOIN chat_groups cg
          ON cg.chatId = cu1.chatId
        INNER JOIN chats c
          ON c.id = cu1.chatId
        INNER JOIN users u
          ON u.id = cu2.userId
        LEFT JOIN messages m
          ON m.id = (
            SELECT mm.id
            FROM messages mm
            WHERE mm.chatId = c.id
            ORDER BY mm.date DESC, mm.id DESC
            LIMIT 1
          )
        WHERE cu1.userId = :actorUserId
          AND cg.chatId IS NULL
          AND COALESCE(u.is_deleted, 0) = 0
          ${statusFilterSql}
          ${targetFilterSql}
          ${qFilterSql}
        ORDER BY COALESCE(m.date, c.updatedAt, c.createdAt) DESC, c.id DESC
        LIMIT :limit OFFSET :offset
      `,
      { replacements, type: QueryTypes.SELECT }
    )) as any[];

    const items = (rows ?? []).map((row: any) => {
      const chatId = Number((row as any)?.chat_id ?? 0) || null;
      const deletedBy = Number((row as any)?.deleted_by ?? 0);
      const isFinalized = deletedBy === -1;
      const userId = Number((row as any)?.user_id ?? 0) || null;
      const name = String((row as any)?.user_name ?? "").trim() || null;
      const lastName = String((row as any)?.user_last_name ?? "").trim() || "";

      const counterpart = {
        id: userId,
        user_type: "user",
        is_admin: false,
        isAdmin: false,
        name,
        last_name: lastName,
        username: String((row as any)?.user_username ?? "").trim() || null,
        image_profil: String((row as any)?.user_image_profil ?? "").trim() || null,
        profile_verified: toBool((row as any)?.user_profile_verified),
        verified_badge: toBool((row as any)?.user_profile_verified),
        profile_verification_status:
          String((row as any)?.user_profile_verification_status ?? "").trim().toLowerCase() ||
          "unverified",
      };

      const lastMessageId = Number((row as any)?.last_message_id ?? 0) || null;
      const lastSenderId = Number((row as any)?.last_sender_id ?? 0) || null;
      const lastMessageType =
        String((row as any)?.last_message_type ?? "").trim().toLowerCase() || "text";
      const lastMessageText = String((row as any)?.last_message_text ?? "").trim() || null;
      const lastMediaUrl = String((row as any)?.last_media_url ?? "").trim() || null;
      const lastMessageDate = toIsoOrNull((row as any)?.last_message_date);
      const lastMessageStatus =
        String((row as any)?.last_message_status ?? "").trim().toLowerCase() || null;
      const senderType = lastSenderId && lastSenderId === actorUserId ? "admin" : "user";

      return {
        chat_id: chatId,
        conversation_id: chatId,
        conversation_type: "support_admin",
        deleted_by: Number.isFinite(deletedBy) ? deletedBy : null,
        finalized: isFinalized,
        is_finalized: isFinalized,
        user_id: userId,
        counterpart,
        can_follow: false,
        canFollow: false,
        can_report: false,
        canReport: false,
        can_open_profile: false,
        canOpenProfile: false,
        can_open_more: false,
        canOpenMore: false,
        show_more_actions: false,
        showMoreActions: false,
        last_message: {
          id: lastMessageId,
          sender_id: lastSenderId,
          sender_type: senderType,
          text: lastMessageText,
          message_type: lastMessageType,
          media_url: lastMediaUrl,
          date: lastMessageDate,
          status: lastMessageStatus,
        },
      };
    });

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.history.list",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        page,
        limit,
        status,
        q: q || null,
        target_user_id: targetUserId ?? null,
        count,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        page,
        limit,
        count,
        status,
        q,
        target_user_id: targetUserId ?? null,
        items,
      },
    });
  } catch (error) {
    console.error("admin_list_chat_history error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.history.list",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista mensajes del chat admin con un usuario.
 * Endpoint: GET /api/v1/admin/users/:id/chat/messages?limit=50&sort=desc&before_message_id=&include_finalized=1
 */
export const admin_list_user_chat_messages = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!actorUserId) {
      return formatResponse({
        res,
        success: false,
        message: "admin user id is missing",
        code: 401,
      });
    }
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const limitRaw = toOptionalPositiveInt((req.query as any)?.limit) ?? 50;
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const sortRaw = String((req.query as any)?.sort ?? "desc")
      .trim()
      .toLowerCase();
    const sort: "asc" | "desc" = sortRaw === "asc" ? "asc" : "desc";
    const beforeMessageId = toOptionalPositiveInt(
      (req.query as any)?.before_message_id ?? (req.query as any)?.beforeMessageId
    );
    const includeFinalizedRaw =
      (req.query as any)?.include_finalized ??
      (req.query as any)?.includeFinalized ??
      (req.query as any)?.finalized_history;
    const includeFinalizedHistory =
      toBool(includeFinalizedRaw) ||
      String(includeFinalizedRaw ?? "")
        .trim()
        .toLowerCase() === "true";

    let rows: any[] = [];
    let chatId: number | null = null;
    let chatDeletedBy: number | null = null;
    let isFinalizedChat = false;

    if (includeFinalizedHistory) {
      const chatMeta = await resolveAdminDirectChatMeta({
        actorUserId,
        targetUserId,
      });
      chatId = chatMeta.chatId;
      chatDeletedBy = chatMeta.deletedBy;
      isFinalizedChat = chatDeletedBy === -1;

      if (chatId) {
        rows = await getAdminChatMessagesByChatId({
          chatId,
          actorUserId,
          targetUserId,
          limit,
          sort,
          beforeMessageId: beforeMessageId ?? null,
          includeFinalizedHistory: true,
        });
      }
    } else {
      rows = await chatRepository.getChatByUser(actorUserId, targetUserId, {
        limit,
        sort,
        beforeMessageId: beforeMessageId ?? null,
      });
      chatId = await chatRepository.getDirectChatIdByUsers(actorUserId, targetUserId);
      if (chatId) {
        const chatMeta = await resolveAdminDirectChatMeta({
          actorUserId,
          targetUserId,
        });
        chatDeletedBy = chatMeta.deletedBy;
        isFinalizedChat = chatDeletedBy === -1;
      }
    }

    const actorUser = await repository.getUserById(actorUserId);
    const counterpart = buildAdminChatCounterpart({
      adminUserRaw: actorUser,
      adminUserId: actorUserId,
    });
    const permissions = buildAdminChatPermissions();

    const messages = (rows ?? [])
      .map((row: any) =>
        normalizeAdminChatMessage({
          messageRaw: row,
          adminUserId: actorUserId,
          targetUserId,
        })
      )
      .filter((row: any) => Boolean(row?.id));

    const pendingToRead = messages.filter((message: any) => {
      const messageId = toOptionalPositiveInt(message?.id);
      if (!messageId) return false;
      const isFromAdmin = Boolean(message?.sender_is_admin) || String(message?.sender_type) === "admin";
      if (isFromAdmin) return false;
      const status = String(message?.status ?? "").trim().toLowerCase();
      return status === "sent" || status === "delivered";
    });

    const shouldMarkAsRead = Boolean(chatId) && !isFinalizedChat;
    if (shouldMarkAsRead && pendingToRead.length > 0) {
      const pendingIds = pendingToRead
        .map((message: any) => toOptionalPositiveInt(message?.id))
        .filter((id): id is number => Boolean(id));

      if (pendingIds.length > 0) {
        const { readAt } = await chatRepository.markMessagesAsReadBulk(pendingIds);
        await chatRepository.resetUnreadCountForChatUser(Number(chatId), Number(actorUserId));

        const statusAtIso = (readAt ?? new Date()).toISOString();
        const readSet = new Set<number>(pendingIds);
        messages.forEach((message: any) => {
          const messageId = toOptionalPositiveInt(message?.id);
          if (!messageId || !readSet.has(messageId)) return;
          message.status = "read";
          message.deliveredAt = statusAtIso;
          message.delivered_at = statusAtIso;
          message.readAt = statusAtIso;
          message.read_at = statusAtIso;
        });

        pendingIds.forEach((messageId) => {
          emitChatStatusRealtime(
            Number(chatId),
            {
              chatId: Number(chatId),
              chat_id: Number(chatId),
              messageId,
              message_id: messageId,
              id: messageId,
              status: "read",
              deliveredAt: statusAtIso,
              delivered_at: statusAtIso,
              readAt: statusAtIso,
              read_at: statusAtIso,
            },
            [actorUserId, targetUserId]
          );
        });

        emitChatsRefreshRealtime(actorUserId);
        emitChatsRefreshRealtime(targetUserId);
        invalidateChatSummaryCacheByUser(actorUserId);
        invalidateChatSummaryCacheByUser(targetUserId);
      }
    }

    const nextBeforeMessageId =
      messages.length >= limit
        ? toOptionalPositiveInt(messages[messages.length - 1]?.id)
        : null;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.messages.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        chat_id: chatId ?? null,
        deleted_by: chatDeletedBy,
        is_finalized: isFinalizedChat,
        include_finalized: includeFinalizedHistory,
        limit,
        sort,
        before_message_id: beforeMessageId ?? null,
        count: messages.length,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        conversation_id: chatId ?? null,
        conversation_type: "support_admin",
        user_id: targetUserId,
        chat_id: chatId ?? null,
        deleted_by: chatDeletedBy,
        finalized: isFinalizedChat,
        is_finalized: isFinalizedChat,
        include_finalized: includeFinalizedHistory,
        counterpart,
        permissions,
        can_follow: false,
        canFollow: false,
        can_report: false,
        canReport: false,
        can_open_profile: false,
        canOpenProfile: false,
        can_open_more: false,
        canOpenMore: false,
        show_more_actions: false,
        showMoreActions: false,
        participants: {
          admin_user_id: actorUserId,
          user_id: targetUserId,
        },
        count: messages.length,
        messages,
        data: messages,
        paging: {
          limit,
          sort,
          before_message_id: beforeMessageId ?? null,
          next_before_message_id: nextBeforeMessageId,
        },
      },
    });
  } catch (error) {
    console.error("admin_list_user_chat_messages error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.messages.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Envía mensaje de admin a usuario en chat directo.
 * Endpoint: POST /api/v1/admin/users/:id/chat/messages
 */
export const admin_send_user_chat_message = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!actorUserId) {
      return formatResponse({
        res,
        success: false,
        message: "admin user id is missing",
        code: 401,
      });
    }
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const normalizedBody = normalizeAdminChatSendBody(req.body);
    const payloadResult = await buildMessagePayload(normalizedBody);
    if (!payloadResult.ok) {
      return formatResponse({
        res,
        success: false,
        message: payloadResult.error,
        code: 400,
      });
    }
    const messagePayload = payloadResult.payload;

    if (!ADMIN_SUPPORTED_MEDIA_MESSAGE_TYPES.has(messagePayload.messageType)) {
      return formatResponse({
        res,
        success: false,
        message: "admin chat only supports text, voice, image and video",
        code: 400,
      });
    }

    const resolvedClientMessageId = resolveClientMessageIdFromRequest(req);
    if (!resolvedClientMessageId.ok) {
      return formatResponse({
        res,
        success: false,
        code: resolvedClientMessageId.code,
        message: resolvedClientMessageId.message,
      });
    }
    if (resolvedClientMessageId.clientMessageId) {
      messagePayload.clientMessageId = resolvedClientMessageId.clientMessageId;
    }

    const blocked = await chatRepository.validateBlock(actorUserId, targetUserId);
    if (blocked) {
      return formatResponse({
        res,
        success: false,
        message: "cannot send message to this user",
        code: 403,
      });
    }

    const created = await chatRepository.initNewChat(
      actorUserId,
      targetUserId,
      messagePayload
    );

    if (!created || !created.chatId || !created.messageId) {
      return formatResponse({
        res,
        success: false,
        message: "message could not be sent",
        code: 409,
      });
    }

    const chatId = Number((created as any)?.chatId ?? 0) || null;
    const messageId = Number((created as any)?.messageId ?? 0) || null;
    const fullMessage = messageId
      ? await chatRepository.getSenderByMessageId(messageId, actorUserId)
      : null;
    if (!fullMessage) {
      return formatResponse({
        res,
        success: false,
        message: "message was sent but payload could not be loaded",
        code: 409,
      });
    }

    const normalizedMessage = normalizeAdminChatMessage({
      messageRaw: fullMessage,
      adminUserId: actorUserId,
      targetUserId,
    });
    const actorUser = await repository.getUserById(actorUserId);
    const counterpart = buildAdminChatCounterpart({
      adminUserRaw: actorUser,
      adminUserId: actorUserId,
    });
    const permissions = buildAdminChatPermissions();

    if (chatId) {
      emitChatMessageRealtime(chatId, normalizedMessage, [actorUserId, targetUserId]);
      emitChatsRefreshRealtime(actorUserId);
      emitChatsRefreshRealtime(targetUserId);
      invalidateChatSummaryCacheByUser(actorUserId);
      invalidateChatSummaryCacheByUser(targetUserId);
    }

    const previewRaw = String(payloadResult.notificationPreview ?? "").trim();
    const snippet = previewRaw.length > 60 ? `${previewRaw.slice(0, 60)}...` : previewRaw;
    sendNotification({
      userId: targetUserId,
      interactorId: actorUserId,
      chatId: chatId ?? undefined,
      messageId: messageId ?? undefined,
      type: "message",
      message: snippet || "You have a new message",
      senderName: "Admin",
      notificationScope: "direct",
      peerUserId: actorUserId,
    });

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.messages.send",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        chat_id: chatId ?? null,
        message_id: messageId ?? null,
        message_type: messagePayload.messageType,
        text_length: String(messagePayload.text ?? "").trim().length,
        has_media: Boolean(messagePayload.mediaUrl),
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        conversation_id: chatId ?? null,
        conversation_type: "support_admin",
        user_id: targetUserId,
        chat_id: chatId ?? null,
        counterpart,
        permissions,
        can_follow: false,
        canFollow: false,
        can_report: false,
        canReport: false,
        can_open_profile: false,
        canOpenProfile: false,
        can_open_more: false,
        canOpenMore: false,
        show_more_actions: false,
        showMoreActions: false,
        message: normalizedMessage,
      },
      message: "message sent",
    });
  } catch (error) {
    console.error("admin_send_user_chat_message error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.messages.send",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Finaliza chat admin con usuario (oculta conversación para ambos).
 * Endpoint: PATCH /api/v1/admin/users/:id/chat/finalize
 */
export const admin_finalize_user_chat = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!actorUserId) {
      return formatResponse({
        res,
        success: false,
        message: "admin user id is missing",
        code: 401,
      });
    }
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const chatId = await chatRepository.getDirectChatIdByUsers(actorUserId, targetUserId);
    if (!chatId) {
      return formatResponse({
        res,
        success: true,
        body: {
          user_id: targetUserId,
          chat_id: null,
          finalized: false,
          already_finalized: true,
        },
        message: "chat already finalized",
      });
    }

    await sequelize.query(
      `
        UPDATE chats
        SET deletedBy = -1
        WHERE id = :chatId
      `,
      {
        replacements: { chatId },
        type: QueryTypes.UPDATE,
      }
    );

    emitChatsRefreshRealtime(actorUserId);
    emitChatsRefreshRealtime(targetUserId);
    invalidateChatSummaryCacheByUser(actorUserId);
    invalidateChatSummaryCacheByUser(targetUserId);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.finalize",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        chat_id: chatId,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        chat_id: chatId,
        finalized: true,
      },
      message: "chat finalized",
    });
  } catch (error) {
    console.error("admin_finalize_user_chat error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.chat.finalize",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Lista postulantes de un service para admin.
 * Endpoint: GET /api/v1/admin/users/:id/services/:serviceId/offers
 */
export const admin_list_user_service_offers = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const serviceId = readTargetServiceId(req);
    if (!targetUserId || !serviceId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or service id",
        code: 400,
      });
    }

    const service = await Service.findOne({
      where: { id: serviceId, userId: targetUserId },
      attributes: ["id", "userId"],
    });
    if (!service) {
      return formatResponse({
        res,
        success: false,
        message: "service not found",
        code: 404,
      });
    }

    const offersRows = await Offer.findAll({
      where: { serviceId },
      attributes: [
        "id",
        "serviceId",
        "workerId",
        "accepted",
        "canceled",
        "removed",
        "offer",
        "offer_date",
        "createdAt",
      ],
      include: [
        {
          model: Worker,
          as: "offerer",
          attributes: ["id", "userId"],
          required: false,
          include: [
            {
              model: User,
              as: "personal_data",
              attributes: [
                "id",
                "username",
                "name",
                "last_name",
                "image_profil",
                "profile_verified",
                "profile_verification_status",
              ],
              required: false,
            },
          ],
        },
      ],
      order: [
        ["offer_date", "DESC"],
        ["id", "DESC"],
      ],
    });

    const offers = (offersRows ?? [])
      .map((row: any) => normalizeAdminServiceOfferRow(row))
      .filter(Boolean);

    const applicantsCount = offers.reduce(
      (acc: number, offer: any) => (offer?.bucket === "applicants" ? acc + 1 : acc),
      0
    );
    const acceptedCount = offers.reduce(
      (acc: number, offer: any) => (offer?.bucket === "accepted" ? acc + 1 : acc),
      0
    );
    const canceledCount = offers.reduce(
      (acc: number, offer: any) => (offer?.bucket === "canceled" ? acc + 1 : acc),
      0
    );

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.offers.list",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        service_id: serviceId,
        total: offers.length,
        applicants: applicantsCount,
        accepted: acceptedCount,
        canceled: canceledCount,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        service_id: serviceId,
        counts: {
          total: offers.length,
          applicants: applicantsCount,
          applicants_count: applicantsCount,
          accepted: acceptedCount,
          accepted_count: acceptedCount,
          canceled: canceledCount,
          canceled_count: canceledCount,
        },
        offers,
      },
    });
  } catch (error) {
    console.error("admin_list_user_service_offers error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.offers.list",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Eliminar service de un usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/services/:serviceId
 */
export const admin_delete_user_service = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    const serviceId = readTargetServiceId(req);
    if (!targetUserId || !serviceId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id or service id",
        code: 400,
      });
    }

    const service = await Service.findOne({
      where: { id: serviceId, userId: targetUserId },
    });
    if (!service) {
      return formatResponse({
        res,
        success: false,
        message: "service not found",
        code: 404,
      });
    }

    const alreadyDeleted =
      Boolean((service as any)?.is_delete) ||
      Boolean((service as any)?.is_deleted) ||
      Boolean((service as any)?.deleted_at ?? (service as any)?.deletedAt) ||
      Boolean((service as any)?.is_available === false);

    if (!alreadyDeleted) {
      await service.update({
        is_available: false,
        statusId: 5,
        closedAt: new Date(),
        manualClosedAt: null,
      } as any);
    }

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.delete",
      level: "warn",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        service_id: serviceId,
        already_deleted: alreadyDeleted,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        service_id: serviceId,
        deleted: !alreadyDeleted,
        already_deleted: alreadyDeleted,
      },
      message: alreadyDeleted ? "Service already deleted" : "Service deleted successfully",
    });
  } catch (error) {
    console.error("admin_delete_user_service error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.services.delete",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Resumen geográfico de usuarios (país/estado/ciudad) para dashboard admin.
 * Endpoint: GET /api/v1/admin/users/location/summary?status=all&verified=all&country_id=&state_id=&city_id=
 */
export const admin_location_summary = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const status = parseAdminStatus((req.query as any)?.status);
    const verified = parseAdminVerified((req.query as any)?.verified);
    const role = parseAdminRole(
      (req.query as any)?.role ??
        (req.query as any)?.user_type ??
        (req.query as any)?.userType
    );
    let countryId = parseAdminLocationFilter(
      (req.query as any)?.country_id ?? (req.query as any)?.countryId
    );
    let stateId = parseAdminLocationFilter(
      (req.query as any)?.state_id ?? (req.query as any)?.stateId
    );
    let cityId = parseAdminLocationFilter(
      (req.query as any)?.city_id ?? (req.query as any)?.cityId
    );
    const locationRefs = loadLocationCatalogRefs();
    ({ countryId, stateId, cityId } = sanitizeAdminLocationFilters(
      { countryId, stateId, cityId },
      locationRefs
    ));

    const result = await (repository as any).admin_location_summary?.({
      status,
      verified,
      role,
      countryId,
      stateId,
      cityId,
    });
    let summaryFallbackApplied = false;
    let totalUsers = Number(result?.total_users ?? 0) || 0;
    let cityRows = Array.isArray(result?.cities) ? result.cities : [];

    const requestedStateId = Number(stateId);
    const requestedCityId = Number(cityId);
    const hasPositiveStateFilter = Number.isFinite(requestedStateId) && requestedStateId > 0;
    const hasPositiveCityFilter = Number.isFinite(requestedCityId) && requestedCityId > 0;

    // Fallback de compatibilidad para data legacy:
    // Si el summary filtrado por state/city retorna 0 por IDs nulos históricos,
    // reconstruimos el summary desde usuarios normalizados del mismo país/rol/status.
    if (totalUsers === 0 && (hasPositiveStateFilter || hasPositiveCityFilter)) {
      summaryFallbackApplied = true;
      const scanLimit = 100;
      const maxScanRows = 10_000;
      let scanPage = 1;
      const collectedRows: any[] = [];

      while (true) {
        const chunk = await (repository as any).admin_list_users?.({
          page: scanPage,
          limit: scanLimit,
          q: "",
          status,
          verified,
          role,
          countryId,
          stateId: null,
          cityId: null,
        });
        const chunkRows = Array.isArray((chunk as any)?.rows) ? (chunk as any).rows : [];
        if (!chunkRows.length) break;

        collectedRows.push(...chunkRows);
        if (chunkRows.length < scanLimit || collectedRows.length >= maxScanRows) break;
        scanPage += 1;
      }

      const normalizedRows = collectedRows.map((row: any) =>
        normalizeAdminUserRow(row, locationRefs)
      );

      const filteredRows = normalizedRows.filter((row: any) => {
        const normalizedState = Number(row?.state_residence_id ?? 0);
        const normalizedCity = Number(row?.city_residence_id ?? 0);
        if (hasPositiveStateFilter && normalizedState !== Math.trunc(requestedStateId)) return false;
        if (hasPositiveCityFilter && normalizedCity !== Math.trunc(requestedCityId)) return false;
        return true;
      });

      totalUsers = filteredRows.length;
      cityRows = filteredRows.map((row: any) => ({
        country_id: row?.country_residence_id ?? null,
        state_id: row?.state_residence_id ?? null,
        city_id: row?.city_residence_id ?? null,
        city_residence_name: row?.city_residence_name ?? null,
        count: 1,
      }));
    }

    const countriesAgg = new Map<string, any>();
    const statesAgg = new Map<string, any>();
    const citiesAgg = new Map<string, any>();

    const addToAgg = (map: Map<string, any>, key: string, seed: any, count: number) => {
      const row = map.get(key);
      if (row) {
        row.count = Number(row.count ?? 0) + count;
        return;
      }
      map.set(key, { ...seed, count });
    };

    cityRows.forEach((row: any) => {
      const count = Number(row?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) return;

      const resolved = resolveAdminLocation(
        {
          countryId: toNumberOrNull(row?.country_id),
          stateId: toNumberOrNull(row?.state_id),
          cityId: toNumberOrNull(row?.city_id),
          cityNameRaw: String(row?.city_residence_name ?? "").trim() || null,
        },
        locationRefs
      );

      const countryIdNorm = resolved.countryId;
      const stateIdNorm = resolved.stateId;
      const cityIdNorm = resolved.cityId;
      const countryNameNorm = resolved.countryName ?? (countryIdNorm ? null : "null");
      const stateNameNorm = resolved.stateName ?? (stateIdNorm ? null : "null");
      const cityNameNorm = resolved.cityName ?? (cityIdNorm ? null : "null");
      const countryIso2Norm = resolved.countryIso2 ?? null;

      addToAgg(
        countriesAgg,
        `c:${countryIdNorm ?? "null"}`,
        {
          country_id: countryIdNorm,
          country_name: countryNameNorm,
          country_iso2: countryIso2Norm,
        },
        count
      );

      addToAgg(
        statesAgg,
        `s:${countryIdNorm ?? "null"}:${stateIdNorm ?? "null"}`,
        {
          country_id: countryIdNorm,
          country_name: countryNameNorm,
          state_id: stateIdNorm,
          state_name: stateNameNorm,
        },
        count
      );

      addToAgg(
        citiesAgg,
        `ct:${countryIdNorm ?? "null"}:${stateIdNorm ?? "null"}:${cityIdNorm ?? "null"}:${normalizeLocationText(
          cityNameNorm
        )}`,
        {
          country_id: countryIdNorm,
          country_name: countryNameNorm,
          state_id: stateIdNorm,
          state_name: stateNameNorm,
          city_id: cityIdNorm,
          city_name: cityNameNorm,
        },
        count
      );
    });

    const countries = Array.from(countriesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );
    const states = Array.from(statesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );
    const cities = Array.from(citiesAgg.values()).sort(
      (a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)
    );

    const unknownCountryUsers = sumCounts(countries, (row) => !toNumberOrNull(row?.country_id));
    const unknownStateUsers = sumCounts(states, (row) => !toNumberOrNull(row?.state_id));
    const unknownCityUsers = sumCounts(cities, (row) => !toNumberOrNull(row?.city_id));

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.location_summary",
      level: "info",
      actorUserId,
      success: true,
      reason: "ok",
      meta: {
        status,
        verified,
        role,
        countryId: serializeAdminLocationFilter(countryId),
        stateId: serializeAdminLocationFilter(stateId),
        cityId: serializeAdminLocationFilter(cityId),
        totalUsers,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        filters: {
          status,
          verified,
          role,
          country_id: serializeAdminLocationFilter(countryId),
          state_id: serializeAdminLocationFilter(stateId),
          city_id: serializeAdminLocationFilter(cityId),
        },
        totals: {
          users: totalUsers,
          unknown_country_users: unknownCountryUsers,
          unknown_state_users: unknownStateUsers,
          unknown_city_users: unknownCityUsers,
        },
        summary_fallback_applied: summaryFallbackApplied,
        countries,
        states,
        cities,
      },
    });
  } catch (error) {
    console.error("admin_location_summary error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.location_summary",
      level: "error",
      actorUserId: readActorUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Actualiza fecha de nacimiento manualmente (admin).
 * Endpoint: PATCH /api/v1/admin/users/:id/birthdate
 */
export const admin_update_birthdate = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    const parsed = parseAdminBirthdayInput(req.body ?? {});
    if (parsed.error) {
      return formatResponse({
        res,
        success: false,
        message: parsed.error,
        code: 400,
      });
    }

    const result = await (repository as any).admin_set_birthday?.(targetUserId, parsed.birthday);
    if (Boolean(result?.notFound)) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
        code: 404,
      });
    }

    const detail = await (repository as any).admin_get_user_by_id?.(targetUserId);
    const normalizedUser = detail ? normalizeAdminUserRow(detail) : null;

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.birthdate.update",
      level: "info",
      actorUserId,
      targetUserId,
      success: true,
      reason: "ok",
      meta: {
        birthday_date: normalizedUser?.birthday_date ?? null,
        age_years: normalizedUser?.age_years ?? null,
      },
    });

    return formatResponse({
      res,
      success: true,
      body: {
        user: normalizedUser,
      },
    });
  } catch (error) {
    console.error("admin_update_birthdate error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.birthdate.update",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * 🗑️ Elimina una cuenta de usuario (soft delete).
 * Endpoint: DELETE /api/v1/admin/users/:id/delete
 */
export const admin_delete_account = async (req: Request, res: Response) => {
  try {
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);
    if (!targetUserId) {
      return formatResponse({
        res,
        success: false,
        message: "invalid user id",
        code: 400,
      });
    }

    if (actorUserId && targetUserId === actorUserId) {
      return formatResponse({
        res,
        success: false,
        message: "admin cannot delete own account",
        code: 400,
      });
    }

    const result = await (repository as any).admin_soft_delete?.(targetUserId);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.delete",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        notFound,
        deleted: Boolean((result as any)?.deleted),
        alreadyDeleted: Boolean((result as any)?.alreadyDeleted),
      },
    });

    if (notFound) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
        code: 404,
      });
    }

    const alreadyDeleted = Boolean((result as any)?.alreadyDeleted);
    return formatResponse({
      res,
      success: true,
      body: {
        user_id: targetUserId,
        deleted: !alreadyDeleted,
        already_deleted: alreadyDeleted,
        status: "deleted",
      },
      message: alreadyDeleted ? "User already deleted" : "User deleted successfully",
    });
  } catch (error) {
    console.error("admin_delete_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.delete",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * 🔒 Desactiva una cuenta a nivel empresa (no podrá usar el app).
 */
export const admin_disable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_set_disabled?.(id, true);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.disable",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        requestedDisabled: true,
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: true },
    });
  } catch (error) {
    console.error("admin_disable_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.disable",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta previamente desactivada.
 */
export const admin_enable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_set_disabled?.(id, false);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.enable",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        requestedDisabled: false,
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: false },
    });
  } catch (error) {
    console.error("admin_enable_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.enable",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta eliminada (soft delete).
 */
export const admin_restore_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_restore_deleted?.(id);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.restore",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, restored: true },
    });
  } catch (error) {
    console.error("admin_restore_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.restore",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};
