import {
  Request,
  Response,
  formatResponse,
  repository,
  uRepository,
  fs,
  uploadFile,
  path,
  authRepository,
} from "../_module/module";
import Category from "../../../_models/category/category";
import multer from "multer";
const PUBLIC_FOLDER = path.join(__dirname, "../../../../src/public");
const PROFILE_IMAGE_FOLDER = path.join(
  PUBLIC_FOLDER,
  "uploads/images/user/profile/"
);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROFILE_IMAGE_FOLDER),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const uploadEither = multer({
  storage,
  limits: { files: 1, fileSize: 8 * 1024 * 1024 }, // ajusta si quieres
}).fields([
  { name: "image_profile", maxCount: 1 },
  { name: "image_profil", maxCount: 1 },
]);

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
    let filePath = "";
    let trash = "";

    try {
      const worker = await repository.worker((req as any).userId);

      if (fileObj?.filename) {
        filePath = path.join(
          "\\uploads\\images\\user\\profile",
          fileObj.filename
        );
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
            ? "\\uploads\\images\\user\\profile\\profile.png"
            : filePath || undefined,
      };

      // ---- Body Worker ----
      const bodyWorker: any = {
        planId: worker?.planId,
        about: req.body.about,
        categories: req.body.skills,
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
      // Limpieza si falló
      const toDelete: any[] = [
        ...((filesAny.image_profile as any[]) ?? []),
        ...((filesAny.image_profil as any[]) ?? []),
      ];
      if ((req as any).file) toDelete.push((req as any).file);
      for (const f of toDelete) if (f?.path) fs.unlink(f.path, () => {});
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
    let filePath = "";

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

      if (fileObj?.filename) {
        filePath = path.join("\\uploads\\images\\user\\profile", fileObj.filename);
      }

      const avatarUrl = String((req.body as any)?.avatar_url ?? "");
      const avatarBody = filePath || (avatarUrl ? avatarUrl : undefined);

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

      const skillsRaw = (req.body as any)?.skills ?? (req.body as any)?.job_category_ids;
      const skills = Array.isArray(skillsRaw)
        ? skillsRaw.map((v: any) => Number(v)).filter((v: any) => Number.isFinite(v))
        : null;

      if (skills && skills.length > 0) {
        const categories = await Category.findAll({
          where: { id: skills },
          attributes: ["id", "name"],
        });
        const labels = categories.map((c: any) => c.name);
        bodyUser.job_category_ids = skills;
        bodyUser.job_categories_labels = labels;
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

      if (skills && skills.length > 0) {
        await repository.update(worker.id, {
          planId: worker.planId,
          about: (req.body as any)?.about ?? worker.about,
          categories: skills,
          userId: (req as any).userId,
        });
      } else if ((req.body as any)?.about !== undefined) {
        await repository.update(worker.id, {
          planId: worker.planId,
          about: (req.body as any)?.about,
          categories: [],
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
      const toDelete: any[] = [
        ...((filesAny.image_profile as any[]) ?? []),
        ...((filesAny.image_profil as any[]) ?? []),
      ];
      if ((req as any).file) toDelete.push((req as any).file);
      for (const f of toDelete) if (f?.path) fs.unlink(f.path, () => {});
      console.error(error);
      return formatResponse({
        res,
        success: false,
        message: error?.message ?? error,
      });
    }
  });
};
