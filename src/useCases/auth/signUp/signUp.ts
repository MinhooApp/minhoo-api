import {
  formatResponse,
  repository,
  path,
  uRepository,
  generatePassword,
  Request,
  Response,
  uploadFile,
  fs,
  sendEmail,
} from "../_module/module";
const PUBLIC_FOLDER = path.join(__dirname, "../../../../src/public");
const PROFILE_IMAGE_FOLDER = path.join(
  PUBLIC_FOLDER,
  "uploads/images/user/profile/"
);
const now: any = new Date(new Date().toUTCString());

export const signUpWithImage = async (req: Request, res: Response) => {
  var upload = uploadFile({
    route: "/uploads/images/user/profile",
    file: "image_profile",
    maxFiles: 1, // Cambiar según la cantidad máxima de archivos que quieres permitir
    is_img: true,
  });

  upload(req, res, async function (err) {
    var files: any = [];
    files = req.files;
    var trash = "";

    const roles: any = [];
    const { email, password, uuid } = req.body;
    const hashPassword = generatePassword(password as string);
    req.body.password = hashPassword;
    req.body.roles = [1];
    const validateEmail = await repository.findByEmail(email);

    if (validateEmail) {
      try {
        if (
          files &&
          files.image_profile != null &&
          files.image_profile.length > 0
        ) {
          if (req.body.delete != "profile.png") {
            trash = PROFILE_IMAGE_FOLDER + req.body.delete;
            fs.unlink(trash, (err: any) => {
              if (err) {
                console.error(err);
              }
            });
          }
        }
        //Elimina el archivo despues de cargarlo, porque el usuario existe
        fs.unlink(files.image_profile[0].path, (err: any) => {
          if (err) {
            console.error(err);
          }
        });
      } catch (error) {
        console.error(err);
      }
      // sendEmail
      return formatResponse({
        res: res,
        success: false,
        code: 401,
        message: "The user already exists",
        islogin: true,
      });
    }

    try {
      //Si existe el archivo, lo agrego al body
      if (files && files.image_profile) {
        req.body.image_profil = files.image_profile[0].path.replace(
          "src\\public\\",
          "\\"
        );
      }

      // const categories: [] = req.body.categories.split(',');
      // req.body.categories = categories;
      const userTemp: any = await repository.add(req.body);

      userTemp?.roles.forEach((u: any) => {
        roles.push(u.id);
      });
      //userTemp?.get("id"), roles, 0
      const user = await repository.saveToken({
        userId: userTemp?.get("id"),
        uuid,
        roles: roles,
      });
      return formatResponse({ res: res, success: true, body: { user } });
    } catch (error: any) {
      if (files.image_profil) {
        const filePath = files.image_profil[0].path;
        fs.unlink(filePath, (err: any) => {
          if (err) {
            console.error(err);
          }
        });
      }
      return formatResponse({
        res: res,
        success: false,
        message: error.errors[0].message,
      });
    }
  });
};
export const signUp = async (req: Request, res: Response) => {
  const roles: any = [];
  const { email, password, uuid } = req.body;
  const hashPassword = generatePassword(password as string);
  req.body.password = hashPassword;
  req.body.roles = [1];
  const validateEmail = await repository.findByEmail(email);

  if (validateEmail) {
    return formatResponse({
      res: res,
      success: false,
      code: 401,
      message: "The user already exists",
      islogin: true,
    });
  }

  try {
    const userTemp = await repository.add(req.body);
    userTemp?.roles.forEach((u: any) => {
      roles.push(u.id);
    });
    //userTemp?.get("id"), roles, 0
    const user = await repository.saveToken({
      userId: userTemp?.get("id"),
      uuid,
      roles,
    });
    return formatResponse({ res: res, success: true, body: { user } });
  } catch (error) {}
};

export const validateEmail = async (req: Request, res: Response) => {
  const { email } = req.body;

  try {
    const validateEmail = await repository.findByEmail(email);

    if (validateEmail) {
      return formatResponse({
        res: res,
        success: false,
        code: 401,
        message: "The email already exists",
      });
    } else {
      const send = true; //: any = await sendEmail("cto@minhoo.app", "./src/public/html/email/emailCode.html", 8088);
      if (send == true) {
        const body = {
          code: 8088,
          email: email,
          created: now,
        };
        const code = await repository.registerCode(body);
        return formatResponse({
          res: res,
          success: true,
          code: 200,
          body: body,
        });
      } else {
        return formatResponse({ res: res, success: false, message: "" });
      }
    }
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const verifyEmailCode = async (req: Request, res: Response) => {
  const { email, code } = req.body;
  try {
    const response = await repository.verifyEmailCode(email, code);
    if (response) {
      const storedDate: any = new Date(response.created);
      // Calcula la diferencia en milisegundos entre las dos fechas
      const differenceInMs = now - storedDate;
      // Convierte la diferencia de milisegundos a días
      const differenceInDays = Math.floor(
        differenceInMs / (1000 * 60 * 60 * 24)
      );
      if (differenceInDays > 1) {
        return formatResponse({
          res: res,
          success: false,
          message: "Expired code",
        });
      }
      return formatResponse({ res: res, success: true, message: "welcome!!" });
      // signUpWithImage(req, res);
    } else {
      return formatResponse({
        res: res,
        success: false,
        message: "Incorrect code",
      });
    }
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
