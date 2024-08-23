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
  try {
    // Si el contenido es JSON, omite la subida de archivos
    if (req.is("application/json")) {
      await processSignUp(req, res, null);
    } else {
      // Configuración de subida de archivos
      const upload = uploadFile({
        route: "/uploads/images/user/profile",
        file: "image_profile",
        maxFiles: 1, // Cambiar según la cantidad máxima de archivos que quieres permitir
        is_img: true,
      });

      upload(req, res, async function (err) {
        if (err) {
          return formatResponse({
            res,
            success: false,
            code: 500, //
            message: "Error uploading file",
          });
        }

        const files = req.files as any;
        await processSignUp(req, res, files);
      });
    }
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: "An unexpected error occurred",
    });
  }
};

// Función para procesar el registro de usuario
const processSignUp = async (req: Request, res: Response, files: any) => {
  let trash = "";

  const { email, password, confirm_password, uuid } = req.body;

  if (password !== confirm_password) {
    return formatResponse({
      res,
      success: false,
      code: 401,
      message: "Password and password confirmation do not match",
      islogin: true,
    });
  }

  const hashPassword = generatePassword(password as string);
  req.body.password = hashPassword;
  req.body.roles = [1];

  const validateEmail = await repository.findByEmail(email);

  if (validateEmail) {
    if (files && files.image_profile) {
      try {
        if (req.body.delete !== "profile.png") {
          trash = PROFILE_IMAGE_FOLDER + req.body.delete;
          fs.unlink(trash, (err: any) => {
            if (err) console.error(err);
          });
        }
        fs.unlink(files.image_profile[0].path, (err: any) => {
          if (err) console.error(err);
        });
      } catch (error: any) {
        console.error(error);
      }
    }
    return formatResponse({
      res,
      success: false,
      code: 401,
      message: "The user already exists",
      islogin: true,
    });
  }

  try {
    if (files && files.image_profile) {
      req.body.image_profile = files.image_profile[0].path.replace(
        "src\\public\\",
        "\\"
      );
    }

    const userTemp: any = await repository.add(req.body);

    const roles = userTemp?.roles.map((role: any) => role.id) || [];

    const user = await repository.saveToken({
      userId: userTemp?.get("id"),
      uuid,
      roles,
    });

    return formatResponse({ res, success: true, body: { user } });
  } catch (error: any) {
    if (files?.image_profile) {
      const filePath = files.image_profile[0].path;
      fs.unlink(filePath, (err: any) => {
        if (err) console.error(err);
      });
    }
    return formatResponse({
      res,
      success: false,
      message: error.message || "An error occurred during user registration",
    });
  }
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
