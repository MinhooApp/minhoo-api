import fs from "fs";
import path from "path";
import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { emitProfileUpdatedRealtime } from "../_shared/profile_realtime";
import multer from "multer";
import Worker from "../../../_models/worker/worker";
import {
  resolveCloudflareDirectAvatarUrl,
  uploadImageBufferToCloudflare,
} from "../../_utils/cloudflare_images";
import logger from "../../../libs/logger/logger";

export const activeAlerts = async (req: Request, res: Response) => {
  try {
    const userTemp = await repository.get(req.userId);
    if (userTemp == null) {
      return formatResponse({
        res: res,
        success: false,
        message: "user not found",
      });
    }
    const user = await repository.activeAlerts(req.userId);
    return formatResponse({ res: res, success: true, body: { user } });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

const normalizeUsername = (raw: any) => {
  const trimmed = String(raw ?? "").trim();
  return trimmed.toLowerCase();
};

const isValidUsername = (username: string) => {
  if (username.length < 1 || username.length > 30) return false;
  return /^[a-z0-9._]+$/.test(username);
};

const isCooldownActive = (lastUpdated: Date | null) => {
  if (!lastUpdated) return false;
  const now = Date.now();
  const last = new Date(lastUpdated).getTime();
  const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  return diffDays < 180;
};

const toText = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};


export const update_username = async (req: Request, res: Response) => {
  try {
    const username = normalizeUsername((req.body as any)?.username);

    if (!username || !isValidUsername(username)) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "Invalid username",
      });
    }

    const user = await repository.getUserById(req.userId);
    if (!user) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    if (user.username === username) {
      return formatResponse({
        res,
        success: true,
        body: { username },
      });
    }

    if (isCooldownActive(user.username_updated_at)) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "username can only be changed every 180 days",
      });
    }

    const existing = await repository.findByUsernameLower(username, req.userId);
    if (existing) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "username not available",
      });
    }

    const updated = await repository.updateUsername(req.userId, username);
    const refreshedUser = await repository.get(req.userId);
    await emitProfileUpdatedRealtime({
      user: refreshedUser,
      userId: req.userId,
      includeRelatedUsers: true,
      emitChatsRefresh: true,
    });
    return formatResponse({
      res,
      success: true,
      body: { username: updated?.username },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

const PROFILE_DEFAULT =
  "https://imagedelivery.net/byMb3jxLYxr0Esz1Tf7NcQ/ff67a5c9-2984-45be-9502-925d46939100/public";
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

const uploadProfileAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: AVATAR_MAX_BYTES },
}).fields([
  { name: "image_profile", maxCount: 1 },
  { name: "image_profil", maxCount: 1 },
]);

const resolveProfileAbsolutePath = (storedPath: string | null | undefined) => {
  if (!storedPath) return null;
  const normalized = storedPath.replace(/\\/g, "/");
  if (!normalized.includes("/uploads/")) return null;
  const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const roots = [
    path.join(process.cwd(), "src", "public"),
    path.join(process.cwd(), "dist", "public"),
  ];
  for (const root of roots) {
    const abs = path.join(root, relative);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
};

export const delete_profile_image = async (req: Request, res: Response) => {
  try {
    const user = await repository.getUserById(req.userId);
    if (!user) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    const currentPath = user.image_profil as string | null | undefined;
    if (currentPath && currentPath !== PROFILE_DEFAULT) {
      const abs = resolveProfileAbsolutePath(currentPath);
      if (abs) fs.unlink(abs, () => {});
    }

    await repository.update(req.userId, { image_profil: PROFILE_DEFAULT });
    const updated = await repository.get(req.userId);
    await emitProfileUpdatedRealtime({
      user: updated,
      userId: req.userId,
      includeRelatedUsers: true,
      emitChatsRefresh: true,
    });

    return formatResponse({
      res,
      success: true,
      body: { user: updated },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

const normalizeIdArray = (value: any) => {
  if (value === undefined || value === null) return null;

  let rawItems: any[] = [];
  if (Array.isArray(value)) {
    rawItems = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return null;
        rawItems = parsed;
      } catch {
        return null;
      }
    } else if (trimmed.includes(",")) {
      rawItems = trimmed.split(",").map((v) => v.trim());
    } else {
      rawItems = [trimmed];
    }
  } else if (typeof value === "number") {
    rawItems = [value];
  } else {
    return null;
  }

  const ids = rawItems
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (ids.length !== rawItems.length) return null;

  return Array.from(new Set(ids));
};

const normalizeStringArray = (value: any) => {
  if (!Array.isArray(value)) return null;
  return value.map((v) => String(v)).filter((v) => v.length > 0);
};

const normalizePreferredLanguage = (value: any): "es" | "en" | null | undefined => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized.startsWith("es") ||
    normalized.includes("spanish") ||
    normalized.includes("espanol") ||
    normalized.includes("español")
  ) {
    return "es";
  }

  if (
    normalized.startsWith("en") ||
    normalized.includes("english") ||
    normalized.includes("ingles") ||
    normalized.includes("inglés")
  ) {
    return "en";
  }

  return null;
};

const isNullishLocationValue = (value: any) => {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "none"
  );
};

type ParsedLocationField<T> = {
  provided: boolean;
  value: T | null | undefined;
};

const parseLocationPositiveInt = (value: any): ParsedLocationField<number> => {
  if (value === undefined) return { provided: false, value: undefined };
  if (isNullishLocationValue(value)) return { provided: true, value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { provided: true, value: undefined };
  }
  return { provided: true, value: Math.trunc(parsed) };
};

const parseLocationString = (value: any): ParsedLocationField<string> => {
  if (value === undefined) return { provided: false, value: undefined };
  if (isNullishLocationValue(value)) return { provided: true, value: null };
  const parsed = String(value).trim();
  if (!parsed) return { provided: true, value: null };
  return { provided: true, value: parsed };
};

const readPath = (source: any, path: string): any => {
  if (!source || typeof source !== "object") return undefined;
  if (!path.includes(".")) return (source as any)?.[path];
  const segments = path.split(".");
  let cursor: any = source;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
};

const pickFirstLocationValue = (body: any, candidates: readonly string[]): any => {
  for (const candidate of candidates) {
    const value = readPath(body, candidate);
    if (value !== undefined) return value;
  }
  return undefined;
};

const LOCATION_FIELD_ALIASES = {
  countryOriginId: [
    "country_origin_id",
    "countryOriginId",
    "origin_country_id",
    "originCountryId",
    "country_of_origin_id",
    "countryOfOriginId",
    "country_origin",
    "countryOrigin",
    "location.country_origin_id",
    "location.countryOriginId",
    "location.origin_country_id",
    "location.originCountryId",
    "location.country_of_origin_id",
    "location.countryOfOriginId",
    "origin.country_id",
    "origin.countryId",
    "origin.country.id",
  ],
  countryOriginCode: [
    "country_origin_code",
    "countryOriginCode",
    "origin_country_code",
    "originCountryCode",
    "country_of_origin_code",
    "countryOfOriginCode",
    "country_origin_iso",
    "countryOriginIso",
    "location.country_origin_code",
    "location.countryOriginCode",
    "location.origin_country_code",
    "location.originCountryCode",
    "origin.country_code",
    "origin.countryCode",
    "origin.country.code",
    "origin.country.iso_code",
  ],
  countryResidenceId: [
    "country_residence_id",
    "countryResidenceId",
    "residence_country_id",
    "residenceCountryId",
    "country_id",
    "countryId",
    "country_residence",
    "countryResidence",
    "location.country_residence_id",
    "location.countryResidenceId",
    "location.residence_country_id",
    "location.residenceCountryId",
    "location.country_id",
    "location.countryId",
    "residence.country_id",
    "residence.countryId",
    "residence.country.id",
    "residence.country",
  ],
  stateResidenceId: [
    "state_residence_id",
    "stateResidenceId",
    "residence_state_id",
    "residenceStateId",
    "state_id",
    "stateId",
    "state_residence",
    "stateResidence",
    "location.state_residence_id",
    "location.stateResidenceId",
    "location.residence_state_id",
    "location.residenceStateId",
    "location.state_id",
    "location.stateId",
    "residence.state_id",
    "residence.stateId",
    "residence.state.id",
    "residence.state",
  ],
  stateResidenceCode: [
    "state_residence_code",
    "stateResidenceCode",
    "residence_state_code",
    "residenceStateCode",
    "state_code",
    "stateCode",
    "location.state_residence_code",
    "location.stateResidenceCode",
    "location.state_code",
    "location.stateCode",
    "residence.state_code",
    "residence.stateCode",
    "residence.state.code",
  ],
  cityResidenceId: [
    "city_residence_id",
    "cityResidenceId",
    "residence_city_id",
    "residenceCityId",
    "city_id",
    "cityId",
    "city_residence",
    "cityResidence",
    "location.city_residence_id",
    "location.cityResidenceId",
    "location.residence_city_id",
    "location.residenceCityId",
    "location.city_id",
    "location.cityId",
    "residence.city_id",
    "residence.cityId",
    "residence.city.id",
    "residence.city",
  ],
  cityResidenceName: [
    "city_residence_name",
    "cityResidenceName",
    "residence_city_name",
    "residenceCityName",
    "city_name",
    "cityName",
    "city",
    "location.city_residence_name",
    "location.cityResidenceName",
    "location.city_name",
    "location.cityName",
    "location.city",
    "residence.city_name",
    "residence.cityName",
    "residence.city.name",
    "address.city",
    "address.city_name",
  ],
} as const;

const extractNormalizedLocationFromBody = (body: any) => {
  const countryOriginId = parseLocationPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryOriginId)
  );
  const countryOriginCode = parseLocationString(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryOriginCode)
  );
  const countryResidenceId = parseLocationPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryResidenceId)
  );
  const stateResidenceId = parseLocationPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.stateResidenceId)
  );
  const stateResidenceCode = parseLocationString(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.stateResidenceCode)
  );
  const cityResidenceId = parseLocationPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.cityResidenceId)
  );
  const cityResidenceName = parseLocationString(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.cityResidenceName)
  );

  return {
    countryOriginId,
    countryOriginCode,
    countryResidenceId,
    stateResidenceId,
    stateResidenceCode,
    cityResidenceId,
    cityResidenceName,
  };
};

export const update_profile = async (req: Request, res: Response) => {
  const applyUpdate = async () => {
    try {
      const body: any = {};
      const filesAny: any = (req as any).files || {};
      const singleFile: any = (req as any).file || null;
      const arrProfile: any[] = filesAny.image_profile ?? [];
      const arrProfil: any[] = filesAny.image_profil ?? [];
      const totalFiles =
        (singleFile ? 1 : 0) +
        (arrProfile?.length || 0) +
        (arrProfil?.length || 0);
      if ((arrProfile.length > 0 && arrProfil.length > 0) || totalFiles > 1) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message:
            "Solo se permite 1 archivo con el campo image_profile O image_profil.",
        });
      }

      const fileObj = singleFile ?? arrProfile[0] ?? arrProfil[0] ?? null;
      const rawAvatarUrl =
        (req.body as any)?.avatar_url ??
        (req.body as any)?.image_profil ??
        (req.body as any)?.image_profile;
      const normalizedAvatarUrl = await resolveCloudflareDirectAvatarUrl(
        rawAvatarUrl
      );
      const hasAvatarUrlField =
        rawAvatarUrl !== undefined && String(rawAvatarUrl ?? "").trim() !== "";
      if (hasAvatarUrlField && !normalizedAvatarUrl) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message:
            "avatar_url must be a Cloudflare Images direct URL (imagedelivery.net), Cloudflare image_id, or /api/v1/media/image/play?id=<cloudflare_image_id>",
        });
      }

      let avatarUrl = normalizedAvatarUrl || undefined;
      if (fileObj?.buffer) {
        const uploadedAvatar = await uploadImageBufferToCloudflare({
          buffer: fileObj.buffer,
          filename: fileObj.originalname,
          mimeType: fileObj.mimetype,
          metadata: {
            app: "minhoo",
            context: "avatar",
            userId: String(req.userId ?? ""),
          },
        });
        avatarUrl = uploadedAvatar.url;
      }

      const shouldDeleteImage =
        (req.body as any)?.delete_image === true ||
        String((req.body as any)?.delete_image ?? "").trim().toLowerCase() ===
          "true" ||
        String((req.body as any)?.delete_image ?? "").trim() === "1";
      if (shouldDeleteImage) {
        body.image_profil = PROFILE_DEFAULT;
      } else if (avatarUrl !== undefined) {
        body.image_profil = avatarUrl;
      }

      const jobCategoryIds = normalizeIdArray((req.body as any)?.job_category_ids);
      if (jobCategoryIds) body.job_category_ids = jobCategoryIds;
      const jobCategoryLabels = normalizeStringArray(
        (req.body as any)?.job_categories_labels
      );
      if (jobCategoryLabels) body.job_categories_labels = jobCategoryLabels;

      const languageIds = normalizeIdArray((req.body as any)?.language_ids);
      if (languageIds) {
        if (languageIds.length > 3) {
          return formatResponse({
            res,
            success: false,
            code: 400,
            message: "language_ids max 3",
          });
        }
        body.language_ids = languageIds;
      }
      const languageCodes = normalizeStringArray((req.body as any)?.language_codes);
      if (languageCodes) body.language_codes = languageCodes;
      const languageNames = normalizeStringArray((req.body as any)?.language_names);
      if (languageNames) body.language_names = languageNames;

      const languageRaw =
        (req.body as any)?.language ??
        (req.body as any)?.preferred_language ??
        (req.body as any)?.preferredLanguage ??
        (req.body as any)?.app_language ??
        (req.body as any)?.appLanguage ??
        (req.body as any)?.locale ??
        (req.body as any)?.lang;
      const normalizedPreferredLanguage = normalizePreferredLanguage(languageRaw);
      if (languageRaw !== undefined && normalizedPreferredLanguage === null) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "language must be 'es' or 'en'",
        });
      }
      if (normalizedPreferredLanguage) body.language = normalizedPreferredLanguage;

      const location = extractNormalizedLocationFromBody(req.body);
      if (location.countryOriginId.provided && location.countryOriginId.value !== undefined) {
        body.country_origin_id = location.countryOriginId.value;
      }
      if (location.countryOriginCode.provided && location.countryOriginCode.value !== undefined) {
        body.country_origin_code = location.countryOriginCode.value;
      }
      if (
        location.countryResidenceId.provided &&
        location.countryResidenceId.value !== undefined
      ) {
        body.country_residence_id = location.countryResidenceId.value;
      }
      if (location.stateResidenceId.provided && location.stateResidenceId.value !== undefined) {
        body.state_residence_id = location.stateResidenceId.value;
      }
      if (
        location.stateResidenceCode.provided &&
        location.stateResidenceCode.value !== undefined
      ) {
        body.state_residence_code = location.stateResidenceCode.value;
      }
      if (location.cityResidenceId.provided && location.cityResidenceId.value !== undefined) {
        body.city_residence_id = location.cityResidenceId.value;
      }
      if (location.cityResidenceName.provided && location.cityResidenceName.value !== undefined) {
        body.city_residence_name = location.cityResidenceName.value;
      }

      await repository.update(req.userId, body);
      const user = await repository.get(req.userId);
      await emitProfileUpdatedRealtime({
        user,
        userId: req.userId,
        includeRelatedUsers: true,
        emitChatsRefresh: true,
      });

      return formatResponse({
        res,
        success: true,
        body: { user },
      });
    } catch (error) {
      logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
      return formatResponse({ res: res, success: false, message: error });
    }
  };

  const isMultipart = !!req.is("multipart/form-data");
  if (!isMultipart) return applyUpdate();

  return uploadProfileAvatar(req, res, (err: any) => {
    if (err) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: err?.message ?? "Error uploading file",
      });
    }
    return applyUpdate();
  });
};

const toBool = (v: any) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return undefined;
};

export const update_visibility = async (req: Request, res: Response) => {
  try {
    const body: any = {};
    const showEmail = toBool((req.body as any)?.show_email);
    const showPhone = toBool((req.body as any)?.show_phone);
    const showLanguages = toBool((req.body as any)?.show_languages);
    const showLocation = toBool((req.body as any)?.show_location);
    const visibleDirectory = toBool(
      (req.body as any)?.visible ??
        (req.body as any)?.worker_visible ??
        (req.body as any)?.directory_visible ??
        (req.body as any)?.show_in_directory
    );
    const workerAlert = toBool(
      (req.body as any)?.alert ??
        (req.body as any)?.worker_alert ??
        (req.body as any)?.directory_alert
    );

    if (showEmail !== undefined) body.show_email = showEmail;
    if (showPhone !== undefined) body.show_phone = showPhone;
    if (showLanguages !== undefined) body.show_languages = showLanguages;
    if (showLocation !== undefined) body.show_location = showLocation;

    const languageRaw =
      (req.body as any)?.language ??
      (req.body as any)?.preferred_language ??
      (req.body as any)?.preferredLanguage ??
      (req.body as any)?.app_language ??
      (req.body as any)?.appLanguage ??
      (req.body as any)?.locale ??
      (req.body as any)?.lang;
    const normalizedPreferredLanguage = normalizePreferredLanguage(languageRaw);
    if (languageRaw !== undefined && normalizedPreferredLanguage === null) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "language must be 'es' or 'en'",
      });
    }
    if (normalizedPreferredLanguage) body.language = normalizedPreferredLanguage;

    await repository.update(req.userId, body);
    if (visibleDirectory !== undefined || workerAlert !== undefined) {
      const workerBody: any = {};
      if (visibleDirectory !== undefined) workerBody.visible = visibleDirectory;
      if (workerAlert !== undefined) workerBody.alert = workerAlert;
      await Worker.update(workerBody, {
        where: {
          userId: req.userId,
          available: true,
        },
      });
    }
    const user = await repository.get(req.userId);
    const worker = await Worker.findOne({
      where: {
        userId: req.userId,
        available: true,
      },
      order: [["id", "DESC"]],
      attributes: ["id", "visible", "alert", "available", "updatedAt"],
    });
    return formatResponse({
      res,
      success: true,
      body: { user, worker },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};
