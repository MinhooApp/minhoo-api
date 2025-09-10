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
const PUBLIC_FOLDER = path.join(__dirname, "../../../../src/public");
const PROFILE_IMAGE_FOLDER = path.join(
  PUBLIC_FOLDER,
  "uploads/images/user/profile/"
);
export const update = async (req: Request, res: Response) => {
  var upload = uploadFile({
    route: "/uploads/images/user/profile",
    file: "image_profil",
    maxFiles: 1, // Cambiar según la cantidad máxima de archivos que quieres permitir
    is_img: true,
  });

  upload(req, res, async function (err) {
    var files: any = [];
    const mediaUrls: any = [];
    files = req.files;
    var trash = "";
    var filePath = "";
    try {
      const worker = await repository.worker(req.userId);
      if (
        files &&
        files.image_profile != null &&
        files.image_profile.length > 0
      ) {
        filePath = files.image_profile[0].path.replace("src\\public\\", "\\");
        mediaUrls.push(filePath);
        if (req.body.delete != "profile.png") {
          trash = PROFILE_IMAGE_FOLDER + req.body.delete;
          fs.unlink(trash, (err: any) => {
            if (err) {
              console.error(err);
            }
          });
        }
      }
      /////Body to update user data/////////////
      const bodyUser = {
        name: req.body.name,
        last_name: req.body.last_name,
        dialing_code: "+" + req.body.dialing_code.replace("+", ""),
        iso_code: req.body.iso_code,
        phone: req.body.phone,
        image_profil:
          req.body.delete_image === true || req.body.delete_image === "true"
            ? "\\uploads\\images\\user\\profile\\profile.png"
            : filePath && filePath !== ""
            ? filePath
            : undefined,
      };

      /////Body to update worker data/////////////
      var bodyWorker = {
        planId: worker?.planId,
        about: req.body.about,
        categories: req.body.skills,
        userId: req.userId,
      };

      //update user//
      await uRepository.update(req.userId, bodyUser);
      const userTemp = await uRepository.get(req.userId);

      //update worker
      if (worker != null) {
        await repository.update(worker.id, bodyWorker);
      } else {
        bodyWorker.planId = 1;
        var roles = [];
        const workertTemp = await repository.add(bodyWorker);
        for (var i = 0; userTemp?.roles.lenght < i; i++) {
          roles.push(userTemp?.roles[i].d);
        }

        await authRepository.saveToken({
          userId: userTemp?.get("id"),
          uuid: userTemp?.get("uuid"),
          workerId: workertTemp?.get("id"),
          roles: roles,
        });
      }
      const user = await uRepository.get(req.userId);

      return formatResponse({
        res: res,
        success: true,
        body: { user: user },
      });
    } catch (error) {
      if (files.length > 0) {
        console.log("ELIMINANDO");
        // Eliminar los archivos si hay algún error
        for (let i = 0; i < files.length; i++) {
          const filePath = files[i].path;
          fs.unlink(filePath, (err: any) => {
            if (err) {
              console.error(err);
            }
          });
        }
      }
      console.log(error);
      return formatResponse({ res: res, success: false, message: error });
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
