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

      if (fileObj?.path) {
        filePath = (fileObj.path as string).replace("src\\public\\", "\\");
        if (req.body.delete && req.body.delete !== "profile.png") {
          trash = PROFILE_IMAGE_FOLDER + req.body.delete;
          fs.unlink(trash, (e: any) => e && console.error(e));
        }
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
