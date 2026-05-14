import {
  Request,
  Response,
  formatResponse,
  repository,
  uRepository,
  authRepository,
} from "../_module/module";
import Category from "../../../_models/category/category";
import multer from "multer";
import {
  normalizeRemoteHttpUrl,
  uploadImageBufferToCloudflare,
} from "../../_utils/cloudflare_images";
import * as chatRepository from "../../../repository/chat/chat_repository";
import {
  emitChatsRefreshRealtime,
  emitUserUpdatedRealtime,
} from "../../../libs/helper/realtime_dispatch";

const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_DEFAULT =
  "https://imagedelivery.net/byMb3jxLYxr0Esz1Tf7NcQ/ff67a5c9-2984-45be-9502-925d46939100/public";

const uploadEither = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: AVATAR_MAX_BYTES },
}).fields([
  { name: "image_profile", maxCount: 1 },
  { name: "image_profil", maxCount: 1 },
]);

const parseCategoryIds = (value: any): number[] | null => {
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
        if (Array.isArray(parsed)) {
          rawItems = parsed;
        } else {
          return null;
        }
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

const parseOptionalPositiveInt = (value: any): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const parseOptionalString = (value: any): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = String(value).trim();
  return parsed ? parsed : undefined;
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
    "location.origin_country",
    "location.originCountry",
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
  const countryOriginId = parseOptionalPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryOriginId)
  );
  const countryOriginCode = parseOptionalString(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryOriginCode)
  );
  const countryResidenceId = parseOptionalPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.countryResidenceId)
  );
  const stateResidenceId = parseOptionalPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.stateResidenceId)
  );
  const stateResidenceCode = parseOptionalString(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.stateResidenceCode)
  );
  const cityResidenceId = parseOptionalPositiveInt(
    pickFirstLocationValue(body, LOCATION_FIELD_ALIASES.cityResidenceId)
  );
  const cityResidenceName = parseOptionalString(
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

const extractLanguageRawFromBody = (body: any) =>
  body?.language ??
  body?.preferred_language ??
  body?.preferredLanguage ??
  body?.app_language ??
  body?.appLanguage ??
  body?.locale ??
  body?.lang;

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toText = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};

const shouldRotateAuthOnWorkerCreate = () =>
  String(process.env.AUTH_ROTATE_ON_WORKER_CREATE ?? "0")
    .trim()
    .toLowerCase() === "1";

const buildUserUpdatedRealtimePayload = (user: any, fallbackUserId: number) => {
  const safeUser = user ?? {};
  const resolvedUserId =
    toPositiveInt((safeUser as any)?.id) ?? toPositiveInt(fallbackUserId) ?? 0;
  const avatarUrl =
    toText((safeUser as any)?.image_profil) ??
    toText((safeUser as any)?.avatarUrl) ??
    toText((safeUser as any)?.avatar_url);

  return {
    type: "user_updated" as const,
    userId: resolvedUserId,
    name: toText((safeUser as any)?.name),
    lastName: toText((safeUser as any)?.last_name),
    last_name: toText((safeUser as any)?.last_name),
    username: toText((safeUser as any)?.username),
    avatarUrl,
    avatar_url: avatarUrl,
    image_profil: avatarUrl,
    updatedAt: new Date().toISOString(),
  };
};

const emitProfileUpdatedRealtime = async (user: any, actorUserId: any) => {
  const userId = toPositiveInt(actorUserId);
  if (!userId) return;

  try {
    const relatedUserIds = await chatRepository.getRelatedUserIdsByUser(userId, {
      includeSelf: true,
    });
    const targetUserIds =
      Array.isArray(relatedUserIds) && relatedUserIds.length > 0
        ? relatedUserIds
        : [userId];
    const payload = buildUserUpdatedRealtimePayload(user, userId);

    emitUserUpdatedRealtime(payload, targetUserIds);
    for (const targetUserId of targetUserIds) {
      emitChatsRefreshRealtime(targetUserId);
    }
  } catch (error) {
    console.error("[profile-realtime] failed to emit user update", error);
  }
};

export const update = async (req: Request, res: Response) => {
  // 1) Parseo ÚNICO (acepta image_profile o image_profil)
  uploadEither(req, res, async (err: any) => {
    if (err) {
      console.error(err);
      return formatResponse({
        res,
        success: false,
        message: err?.message ?? err,
      });
    }

    const filesAny: any = (req as any).files || {};
    const arrProfile: any[] = filesAny.image_profile ?? [];
    const arrProfil: any[] = filesAny.image_profil ?? [];
    const singleFile = (req as any).file; // por si en algún otro lado llamas .single()

    // No permitir ambos campos ni más de 1 archivo total
    const total =
      (singleFile ? 1 : 0) +
      (arrProfile?.length || 0) +
      (arrProfil?.length || 0);
    if ((arrProfile.length > 0 && arrProfil.length > 0) || total > 1) {
      return formatResponse({
        res,
        success: false,
        message:
          "Solo se permite 1 archivo con el campo image_profile O image_profil.",
      });
    }

    // 2) Toma el archivo (si viene)
    const fileObj = singleFile ?? arrProfile[0] ?? arrProfil[0];
    const rawAvatarUrl =
      (req.body as any)?.avatar_url ??
      (req.body as any)?.image_profil ??
      (req.body as any)?.image_profile;
    const normalizedAvatarUrl = normalizeRemoteHttpUrl(rawAvatarUrl);
    const hasAvatarUrlField =
      rawAvatarUrl !== undefined && String(rawAvatarUrl ?? "").trim() !== "";

    if (hasAvatarUrlField && !normalizedAvatarUrl) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "avatar_url must be a valid http(s) URL",
      });
    }

    try {
      const worker = await repository.worker((req as any).userId);
      let avatarUrl = normalizedAvatarUrl || undefined;

      if (fileObj?.buffer) {
        const uploadedAvatar = await uploadImageBufferToCloudflare({
          buffer: fileObj.buffer,
          filename: fileObj.originalname,
          mimeType: fileObj.mimetype,
          metadata: {
            app: "minhoo",
            context: "avatar",
            userId: String((req as any).userId ?? ""),
          },
        });
        avatarUrl = uploadedAvatar.url;
      }

      const hasSkills =
        Object.prototype.hasOwnProperty.call(req.body, "skills") ||
        Object.prototype.hasOwnProperty.call(req.body, "job_category_ids");
      const skillsRaw = Object.prototype.hasOwnProperty.call(req.body, "skills")
        ? (req.body as any)?.skills
        : (req.body as any)?.job_category_ids;
      const skills = hasSkills ? parseCategoryIds(skillsRaw) : null;
      if (hasSkills && skills === null) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "skills must be a numeric id or an array of numeric ids",
        });
      }

      // ---- Body User ----
      const bodyUser: any = {
        name: req.body.name,
        last_name: req.body.last_name,
        dialing_code: "+" + (req.body.dialing_code || "").replace("+", ""),
        iso_code: req.body.iso_code,
        phone: req.body.phone,
        // Mantén image_profil como en tu BD
        image_profil:
          req.body.delete_image === true || req.body.delete_image === "true"
            ? PROFILE_DEFAULT
            : avatarUrl,
      };
      if (Object.prototype.hasOwnProperty.call(req.body, "about")) {
        bodyUser.about = toText((req.body as any)?.about);
      }

      const languageRaw = extractLanguageRawFromBody(req.body);
      const normalizedPreferredLanguage = normalizePreferredLanguage(languageRaw);
      if (languageRaw !== undefined && normalizedPreferredLanguage === null) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "language must be 'es' or 'en'",
        });
      }
      if (normalizedPreferredLanguage) bodyUser.language = normalizedPreferredLanguage;

      if (hasSkills) {
        bodyUser.job_category_ids = skills;
        if ((skills ?? []).length > 0) {
          const categories = await Category.findAll({
            where: { id: skills },
            attributes: ["id", "name"],
          });
          bodyUser.job_categories_labels = categories.map((c: any) => c.name);
        } else {
          bodyUser.job_categories_labels = [];
        }
      }

      const location = extractNormalizedLocationFromBody(req.body);
      if (location.countryOriginId !== undefined) {
        bodyUser.country_origin_id = location.countryOriginId;
      }
      if (location.countryOriginCode !== undefined) {
        bodyUser.country_origin_code = location.countryOriginCode;
      }
      if (location.countryResidenceId !== undefined) {
        bodyUser.country_residence_id = location.countryResidenceId;
      }
      if (location.stateResidenceId !== undefined) {
        bodyUser.state_residence_id = location.stateResidenceId;
      }
      if (location.stateResidenceCode !== undefined) {
        bodyUser.state_residence_code = location.stateResidenceCode;
      }
      if (location.cityResidenceId !== undefined) {
        bodyUser.city_residence_id = location.cityResidenceId;
      }
      if (location.cityResidenceName !== undefined) {
        bodyUser.city_residence_name = location.cityResidenceName;
      }

      // ---- Body Worker ----
      const bodyWorker: any = {
        planId: worker?.planId,
        about: req.body.about,
        categories: hasSkills ? skills : undefined,
        userId: (req as any).userId,
      };

      await uRepository.update((req as any).userId, bodyUser);
      const userTemp = await uRepository.get((req as any).userId);

      if (worker) {
        await repository.update(worker.id, bodyWorker);
      } else {
        bodyWorker.planId = 1;
        const workerTemp = await repository.add(bodyWorker);
        if (shouldRotateAuthOnWorkerCreate()) {
          const roles = (userTemp?.roles ?? []).map((r: any) => r.id);
          const workerId = Number(workerTemp?.get?.("id") ?? 0) || null;
          await authRepository.saveToken({
            userId: userTemp?.get("id"),
            uuid: userTemp?.get("uuid"),
            workerId,
            roles,
          });
        }
      }

      const user = await uRepository.get((req as any).userId);
      await emitProfileUpdatedRealtime(user, (req as any).userId);
      return formatResponse({ res, success: true, body: { user } });
    } catch (error: any) {
      console.error(error);
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? error,
      });
    }
  });
};

const toBool = (value: any): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
};

export const visibleProfile = async (req: Request, res: Response) => {
  const debugEnabled =
    String(process.env.WORKER_VISIBLE_AUDIT_LOG ?? "1").trim().toLowerCase() !== "0";
  const rawVisibleCandidates: Array<{ key: string; raw: any }> = [
    { key: "visible", raw: (req.body as any)?.visible },
    { key: "is_visible", raw: (req.body as any)?.is_visible },
    { key: "isVisible", raw: (req.body as any)?.isVisible },
    { key: "visible_profile", raw: (req.body as any)?.visible_profile },
    { key: "visibleProfile", raw: (req.body as any)?.visibleProfile },
    { key: "show_profile", raw: (req.body as any)?.show_profile },
    { key: "showProfile", raw: (req.body as any)?.showProfile },
    { key: "active", raw: (req.body as any)?.active },
    { key: "is_active", raw: (req.body as any)?.is_active },
    { key: "isActive", raw: (req.body as any)?.isActive },
    { key: "activate", raw: (req.body as any)?.activate },
    { key: "available", raw: (req.body as any)?.available },
    { key: "worker_visible", raw: (req.body as any)?.worker_visible },
    { key: "directory_visible", raw: (req.body as any)?.directory_visible },
    { key: "show_in_directory", raw: (req.body as any)?.show_in_directory },
  ];
  const rawAlertCandidates: Array<{ key: string; raw: any }> = [
    { key: "alert", raw: (req.body as any)?.alert },
    { key: "worker_alert", raw: (req.body as any)?.worker_alert },
    { key: "directory_alert", raw: (req.body as any)?.directory_alert },
  ];
  const visibleCandidates = rawVisibleCandidates
    .filter((entry) => entry.raw !== undefined)
    .map((entry) => ({ key: entry.key, parsed: toBool(entry.raw) }));
  const alertCandidates = rawAlertCandidates
    .filter((entry) => entry.raw !== undefined)
    .map((entry) => ({ key: entry.key, parsed: toBool(entry.raw) }));
  const body: any = {};
  const explicitDeactivate = toBool(
    (req.body as any)?.deactivate ??
      (req.body as any)?.disable_directory ??
      (req.body as any)?.disableDirectory ??
      (req.body as any)?.hide_profile ??
      (req.body as any)?.hideProfile
  );
  if (debugEnabled) {
    const debugSnapshot = {
      userId: Number((req as any)?.userId ?? 0) || null,
      keys: Object.keys((req.body as any) || {}),
      visible_candidates: rawVisibleCandidates
        .filter((entry) => entry.raw !== undefined)
        .map((entry) => ({ key: entry.key, raw: entry.raw })),
      alert_candidates: rawAlertCandidates
        .filter((entry) => entry.raw !== undefined)
        .map((entry) => ({ key: entry.key, raw: entry.raw })),
      explicit_deactivate: explicitDeactivate,
    };
    console.log(`[worker/visible][incoming] ${JSON.stringify(debugSnapshot)}`);
  }

  const invalidVisible = visibleCandidates.find((entry) => entry.parsed === undefined);
  if (invalidVisible) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `${invalidVisible.key} must be a boolean`,
    });
  }
  const invalidAlert = alertCandidates.find((entry) => entry.parsed === undefined);
  if (invalidAlert) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `${invalidAlert.key} must be a boolean`,
    });
  }

  const explicitVisible = visibleCandidates.find((entry) =>
    ["visible", "is_visible", "isVisible"].includes(entry.key)
  );
  const activationHintTrue = visibleCandidates.find(
    (entry) => entry.parsed === true && entry.key !== "visible" && entry.key !== "is_visible" && entry.key !== "isVisible"
  );
  const activationIntentProvided = visibleCandidates.some(
    (entry) =>
      !["visible", "is_visible", "isVisible", "available"].includes(entry.key)
  );
  const anyVisibleFalse = visibleCandidates.some((entry) => entry.parsed === false);

  const explicitVisibleKeys = new Set(["visible", "is_visible", "isVisible"]);
  const hasOnlyExplicitVisibleSignals =
    visibleCandidates.length > 0 &&
    visibleCandidates.every((entry) => explicitVisibleKeys.has(entry.key));

  let resolvedVisible: boolean | undefined = undefined;
  if (activationHintTrue) {
    // If any activation-intent alias is true, prioritize enabling visibility.
    resolvedVisible = true;
  } else if (explicitVisible) {
    resolvedVisible = Boolean(explicitVisible.parsed);
  } else if (visibleCandidates.length > 0) {
    // No explicit `visible`, but we received compatible aliases.
    resolvedVisible = anyVisibleFalse ? false : true;
  }

  const resolvedAlert =
    alertCandidates.length > 0
      ? Boolean(alertCandidates[alertCandidates.length - 1].parsed)
      : undefined;

  if (
    resolvedVisible === false &&
    resolvedAlert === true &&
    hasOnlyExplicitVisibleSignals
  ) {
    // Compatibility guard: some legacy clients send `visible=false` by default
    // while toggling only alert in the UI activation flow.
    resolvedVisible = true;
  }
  if (resolvedVisible === false && activationIntentProvided) {
    // Compatibility guard: activation-intent aliases should never end as false
    // due to inverted client booleans.
    resolvedVisible = true;
  }
  if (explicitDeactivate === true) {
    resolvedVisible = false;
  } else if (resolvedVisible === false && visibleCandidates.length > 0) {
    // Last safety-net for legacy clients that invert the toggle payload.
    // Any call to /worker/visible without explicit deactivation is treated as activation.
    resolvedVisible = true;
  }

  if (resolvedVisible !== undefined) {
    body.visible = resolvedVisible;
  } else if (resolvedAlert !== undefined) {
    // Legacy compatibility: allow activation flow with alert-only payload.
    body.visible = resolvedAlert;
  }
  if (resolvedAlert !== undefined) body.alert = resolvedAlert;
  if (!Object.keys(body).length) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "visible or alert is required",
    });
  }

  try {
    const languageRaw = extractLanguageRawFromBody(req.body);
    const normalizedPreferredLanguage = normalizePreferredLanguage(languageRaw);
    if (languageRaw !== undefined && normalizedPreferredLanguage === null) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "language must be 'es' or 'en'",
      });
    }

    var worker = await repository.visibleProfile(req.userId, body);
    if (debugEnabled) {
      const debugApplied = {
        userId: Number((req as any)?.userId ?? 0) || null,
        applied_body: body,
        worker_id: Number((worker as any)?.id ?? 0) || null,
        worker_visible:
          typeof (worker as any)?.get === "function"
            ? (worker as any).get("visible")
            : (worker as any)?.visible,
        worker_alert:
          typeof (worker as any)?.get === "function"
            ? (worker as any).get("alert")
            : (worker as any)?.alert,
      };
      console.log(`[worker/visible][applied] ${JSON.stringify(debugApplied)}`);
    }

    if (normalizedPreferredLanguage) {
      await uRepository.update(req.userId, { language: normalizedPreferredLanguage });
    }

    return formatResponse({ res: res, success: true, body: { worker } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const deleteImageProfile = async (req: Request, res: Response) => {
  try {
    await repository.deleteImageProfil(req.userId);
    const user = await uRepository.get(req.userId);
    await emitProfileUpdatedRealtime(user, req.userId);
    return formatResponse({ res: res, success: true, body: {} });
  } catch (error) {
    console.log(error);
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

export const updateProfile = async (req: Request, res: Response) => {
  uploadEither(req, res, async (err: any) => {
    if (err) {
      console.error(err);
      return formatResponse({
        res,
        success: false,
        message: err?.message ?? err,
      });
    }

    const filesAny: any = (req as any).files || {};
    const arrProfile: any[] = filesAny.image_profile ?? [];
    const arrProfil: any[] = filesAny.image_profil ?? [];
    const singleFile = (req as any).file;

    const total =
      (singleFile ? 1 : 0) +
      (arrProfile?.length || 0) +
      (arrProfil?.length || 0);
    if ((arrProfile.length > 0 && arrProfil.length > 0) || total > 1) {
      return formatResponse({
        res,
        success: false,
        message: "Solo se permite 1 archivo con el campo image_profile O image_profil.",
      });
    }

    const fileObj = singleFile ?? arrProfile[0] ?? arrProfil[0];
    const rawAvatarUrl =
      (req.body as any)?.avatar_url ??
      (req.body as any)?.image_profil ??
      (req.body as any)?.image_profile;
    const normalizedAvatarUrl = normalizeRemoteHttpUrl(rawAvatarUrl);
    const hasAvatarUrlField =
      rawAvatarUrl !== undefined && String(rawAvatarUrl ?? "").trim() !== "";

    if (hasAvatarUrlField && !normalizedAvatarUrl) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "avatar_url must be a valid http(s) URL",
      });
    }

    try {
      const user = await uRepository.getUserById((req as any).userId);
      if (!user) {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "user not found",
        });
      }

      const usernameRaw = (req.body as any)?.username;
      if (usernameRaw !== undefined && usernameRaw !== null) {
        const username = normalizeUsername(usernameRaw);
        if (!isValidUsername(username)) {
          return formatResponse({
            res,
            success: false,
            code: 400,
            message: "Invalid username",
          });
        }
        if (user.username !== username && isCooldownActive(user.username_updated_at)) {
          return formatResponse({
            res,
            success: false,
            code: 409,
            message: "username can only be changed every 180 days",
          });
        }
        const existing = await uRepository.findByUsernameLower(
          username,
          (req as any).userId
        );
        if (existing) {
          return formatResponse({
            res,
            success: false,
            code: 409,
            message: "username not available",
          });
        }
        if (user.username !== username) {
          await uRepository.updateUsername((req as any).userId, username);
        }
      }

      let avatarBody = normalizedAvatarUrl || undefined;

      if (fileObj?.buffer) {
        const uploadedAvatar = await uploadImageBufferToCloudflare({
          buffer: fileObj.buffer,
          filename: fileObj.originalname,
          mimeType: fileObj.mimetype,
          metadata: {
            app: "minhoo",
            context: "avatar",
            userId: String((req as any).userId ?? ""),
          },
        });
        avatarBody = uploadedAvatar.url;
      }

      const bodyUser: any = {
        name: (req.body as any)?.first_name ?? (req.body as any)?.name,
        last_name: (req.body as any)?.last_name,
        dialing_code:
          (req.body as any)?.dialing_code !== undefined
            ? "+" + String((req.body as any)?.dialing_code || "").replace("+", "")
            : undefined,
        iso_code:
          (req.body as any)?.iso_code ?? (req.body as any)?.country_code,
        phone: (req.body as any)?.phone,
        image_profil: avatarBody,
      };
      if (Object.prototype.hasOwnProperty.call(req.body, "about")) {
        bodyUser.about = toText((req.body as any)?.about);
      }

      const languageRaw = extractLanguageRawFromBody(req.body);
      const normalizedPreferredLanguage = normalizePreferredLanguage(languageRaw);
      if (languageRaw !== undefined && normalizedPreferredLanguage === null) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "language must be 'es' or 'en'",
        });
      }
      if (normalizedPreferredLanguage) bodyUser.language = normalizedPreferredLanguage;

      const hasSkills =
        Object.prototype.hasOwnProperty.call(req.body, "skills") ||
        Object.prototype.hasOwnProperty.call(req.body, "job_category_ids");
      const skillsRaw = Object.prototype.hasOwnProperty.call(req.body, "skills")
        ? (req.body as any)?.skills
        : (req.body as any)?.job_category_ids;
      const skills = hasSkills ? parseCategoryIds(skillsRaw) : null;
      if (hasSkills && skills === null) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message:
            "skills/job_category_ids must be a numeric id or an array of numeric ids",
        });
      }

      if (hasSkills) {
        bodyUser.job_category_ids = skills;
        if ((skills ?? []).length > 0) {
          const categories = await Category.findAll({
            where: { id: skills },
            attributes: ["id", "name"],
          });
          bodyUser.job_categories_labels = categories.map((c: any) => c.name);
        } else {
          bodyUser.job_categories_labels = [];
        }
      }

      const location = extractNormalizedLocationFromBody(req.body);
      if (location.countryOriginId !== undefined) {
        bodyUser.country_origin_id = location.countryOriginId;
      }
      if (location.countryOriginCode !== undefined) {
        bodyUser.country_origin_code = location.countryOriginCode;
      }
      if (location.countryResidenceId !== undefined) {
        bodyUser.country_residence_id = location.countryResidenceId;
      }
      if (location.stateResidenceId !== undefined) {
        bodyUser.state_residence_id = location.stateResidenceId;
      }
      if (location.stateResidenceCode !== undefined) {
        bodyUser.state_residence_code = location.stateResidenceCode;
      }
      if (location.cityResidenceId !== undefined) {
        bodyUser.city_residence_id = location.cityResidenceId;
      }
      if (location.cityResidenceName !== undefined) {
        bodyUser.city_residence_name = location.cityResidenceName;
      }

      await uRepository.update((req as any).userId, bodyUser);

      let worker = await repository.worker((req as any).userId);
      if (!worker) {
        const createBody: any = {
          userId: (req as any).userId,
          planId: 1,
        };
        worker = await repository.add(createBody);
      }

      if (hasSkills || (req.body as any)?.about !== undefined) {
        await repository.update(worker.id, {
          planId: worker.planId,
          about: (req.body as any)?.about ?? worker.about,
          categories: hasSkills ? skills : undefined,
          userId: (req as any).userId,
        });
      }

      const userUpdated = await uRepository.get((req as any).userId);
      const workerUpdated = await repository.worker((req as any).userId);
      await emitProfileUpdatedRealtime(userUpdated, (req as any).userId);

      return formatResponse({
        res,
        success: true,
        body: { user: userUpdated, worker: workerUpdated },
      });
    } catch (error: any) {
      console.error(error);
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? error,
      });
    }
  });
};
