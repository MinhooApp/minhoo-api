import fs from "fs";
import path from "path";
import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
  sendNotification,
} from "../_module/module";

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
    return formatResponse({
      res,
      success: true,
      body: { username: updated?.username },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

const PROFILE_DEFAULT = "\\uploads\\images\\user\\profile\\profile.png";

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

    return formatResponse({
      res,
      success: true,
      body: { user: updated },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

const normalizeIdArray = (value: any) => {
  if (!Array.isArray(value)) return null;
  const ids = value.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  return ids;
};

const normalizeStringArray = (value: any) => {
  if (!Array.isArray(value)) return null;
  return value.map((v) => String(v)).filter((v) => v.length > 0);
};

export const update_profile = async (req: Request, res: Response) => {
  try {
    const body: any = {};

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

    const countryOriginId = Number((req.body as any)?.country_origin_id);
    if (Number.isFinite(countryOriginId)) body.country_origin_id = countryOriginId;
    const countryOriginCode = String((req.body as any)?.country_origin_code ?? "");
    if (countryOriginCode) body.country_origin_code = countryOriginCode;

    const countryResidenceId = Number((req.body as any)?.country_residence_id);
    if (Number.isFinite(countryResidenceId))
      body.country_residence_id = countryResidenceId;
    const stateResidenceId = Number((req.body as any)?.state_residence_id);
    if (Number.isFinite(stateResidenceId)) body.state_residence_id = stateResidenceId;
    const stateResidenceCode = String((req.body as any)?.state_residence_code ?? "");
    if (stateResidenceCode) body.state_residence_code = stateResidenceCode;

    const cityResidenceId = Number((req.body as any)?.city_residence_id);
    if (Number.isFinite(cityResidenceId)) body.city_residence_id = cityResidenceId;
    const cityResidenceName = String((req.body as any)?.city_residence_name ?? "");
    if (cityResidenceName) body.city_residence_name = cityResidenceName;

    await repository.update(req.userId, body);
    const user = await repository.get(req.userId);

    return formatResponse({
      res,
      success: true,
      body: { user },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
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

    if (showEmail !== undefined) body.show_email = showEmail;
    if (showPhone !== undefined) body.show_phone = showPhone;
    if (showLanguages !== undefined) body.show_languages = showLanguages;
    if (showLocation !== undefined) body.show_location = showLocation;

    await repository.update(req.userId, body);
    const user = await repository.get(req.userId);

    return formatResponse({
      res,
      success: true,
      body: { user },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
