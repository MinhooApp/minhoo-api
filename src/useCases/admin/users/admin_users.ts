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
import Post from "../../../_models/post/post";
import MediaPost from "../../../_models/post/media_post";
import Comment from "../../../_models/comment/comment";
import User from "../../../_models/user/user";
import Reel from "../../../_models/reel/reel";
import ReelComment from "../../../_models/reel/reel_comment";
import Service from "../../../_models/service/service";
import Offer from "../../../_models/offer/offer";
import Worker from "../../../_models/worker/worker";
import Category from "../../../_models/category/category";
import StatusService from "../../../_models/status/statusService";
import { buildServiceRoutingFields } from "../../../libs/service_client_bucket";
import { Sequelize, Op } from "sequelize";
import { deletePostAdmin as deletePostAdminUseCase } from "../../post/delete/delete";

const toOptionalPositiveInt = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

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

    const where = buildAdminMuralServicesWhere({
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

    const where = buildAdminMuralServicesWhere({
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
