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

      const countryOriginId = parseOptionalPositiveInt(
        (req.body as any)?.country_origin_id ?? (req.body as any)?.countryOriginId
      );
      if (countryOriginId !== undefined) bodyUser.country_origin_id = countryOriginId;

      const countryOriginCode = parseOptionalString(
        (req.body as any)?.country_origin_code ?? (req.body as any)?.countryOriginCode
      );
      if (countryOriginCode !== undefined)
        bodyUser.country_origin_code = countryOriginCode;

      const countryResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.country_residence_id ?? (req.body as any)?.countryResidenceId
      );
      if (countryResidenceId !== undefined)
        bodyUser.country_residence_id = countryResidenceId;

      const stateResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.state_residence_id ?? (req.body as any)?.stateResidenceId
      );
      if (stateResidenceId !== undefined) bodyUser.state_residence_id = stateResidenceId;

      const stateResidenceCode = parseOptionalString(
        (req.body as any)?.state_residence_code ?? (req.body as any)?.stateResidenceCode
      );
      if (stateResidenceCode !== undefined)
        bodyUser.state_residence_code = stateResidenceCode;

      const cityResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.city_residence_id ?? (req.body as any)?.cityResidenceId
      );
      if (cityResidenceId !== undefined) bodyUser.city_residence_id = cityResidenceId;

      const cityResidenceName = parseOptionalString(
        (req.body as any)?.city_residence_name ?? (req.body as any)?.cityResidenceName
      );
      if (cityResidenceName !== undefined)
        bodyUser.city_residence_name = cityResidenceName;

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
        const roles = (userTemp?.roles ?? []).map((r: any) => r.id);
        await authRepository.saveToken({
          userId: userTemp?.get("id"),
          uuid: userTemp?.get("uuid"),
          workerId: workerTemp?.get("id"),
          roles,
        });
      }

      const user = await uRepository.get((req as any).userId);
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

export const visibleProfile = async (req: Request, res: Response) => {
  const { visible, alert } = req.body;
  var body = {
    visible: visible,
    alert: alert,
  };
  try {
    var worker = await repository.visibleProfile(req.userId, body);

    return formatResponse({ res: res, success: true, body: { worker } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const deleteImageProfile = async (req: Request, res: Response) => {
  try {
    await repository.deleteImageProfil(req.userId);
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

      const countryOriginId = parseOptionalPositiveInt(
        (req.body as any)?.country_origin_id ?? (req.body as any)?.countryOriginId
      );
      if (countryOriginId !== undefined) bodyUser.country_origin_id = countryOriginId;

      const countryOriginCode = parseOptionalString(
        (req.body as any)?.country_origin_code ?? (req.body as any)?.countryOriginCode
      );
      if (countryOriginCode !== undefined)
        bodyUser.country_origin_code = countryOriginCode;

      const countryResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.country_residence_id ?? (req.body as any)?.countryResidenceId
      );
      if (countryResidenceId !== undefined)
        bodyUser.country_residence_id = countryResidenceId;

      const stateResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.state_residence_id ?? (req.body as any)?.stateResidenceId
      );
      if (stateResidenceId !== undefined) bodyUser.state_residence_id = stateResidenceId;

      const stateResidenceCode = parseOptionalString(
        (req.body as any)?.state_residence_code ?? (req.body as any)?.stateResidenceCode
      );
      if (stateResidenceCode !== undefined)
        bodyUser.state_residence_code = stateResidenceCode;

      const cityResidenceId = parseOptionalPositiveInt(
        (req.body as any)?.city_residence_id ?? (req.body as any)?.cityResidenceId
      );
      if (cityResidenceId !== undefined) bodyUser.city_residence_id = cityResidenceId;

      const cityResidenceName = parseOptionalString(
        (req.body as any)?.city_residence_name ?? (req.body as any)?.cityResidenceName
      );
      if (cityResidenceName !== undefined)
        bodyUser.city_residence_name = cityResidenceName;

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
