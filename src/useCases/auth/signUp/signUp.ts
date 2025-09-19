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
  bcryptjs,
} from "../_module/module";
const PUBLIC_FOLDER = path.join(__dirname, "../../../../src/public");
const PROFILE_IMAGE_FOLDER = path.join(
  PUBLIC_FOLDER,
  "uploads/images/user/profile/"
);

// signUp.ts
const now: any = new Date(new Date().toUTCString());

/**
 * I normalize the uploaded file into a path that your DB can store.
 * Works for: Multer diskStorage (destination/filename/path) and multer-s3 (location).
 */
function resolveUploadedImage(
  file: any,
  req: Request,
  staticBase = "/uploads"
) {
  // Prefer explicit URL from S3-like providers
  if (file?.location) {
    // Example: multer-s3 puts the final public URL in location
    return { url: file.location, relative: null };
  }

  // Multer disk: typical fields are destination, filename, path
  // Build a POSIX-like public path your app serves, e.g. /uploads/images/user/profile/xxx.jpg
  const filename = file?.filename ?? file?.originalname ?? null;
  const destination = file?.destination ?? "";
  const pathFromDisk = file?.path ?? "";

  // Try to map disk path into a public URL under staticBase
  // Example: if destination = "<project>/public/uploads/images/user/profile"
  // and you serve `public` as static, then remove everything before `/uploads`.
  let relativeFromDisk = null;
  if (typeof pathFromDisk === "string" && pathFromDisk.includes(staticBase)) {
    // pathFromDisk might be "C:\app\public\uploads\images\user\profile\file.jpg"
    relativeFromDisk = pathFromDisk.substring(pathFromDisk.indexOf(staticBase));
  } else if (destination && filename) {
    // Fallback: try to reconstruct using route folder and filename
    // You use route: "/uploads/images/user/profile"
    const normDest = destination.replace(/\\/g, "/");
    const idx = normDest.indexOf(staticBase);
    if (idx >= 0) {
      const base = normDest.substring(idx);
      relativeFromDisk = `${base.replace(/\/+$/, "")}/${filename}`;
    }
  }

  // Ensure forward slashes for URLs
  if (relativeFromDisk) {
    relativeFromDisk = relativeFromDisk.replace(/\\/g, "/");
    const fullUrl = `${req.protocol}://${req.get("host")}${relativeFromDisk}`;
    return { url: fullUrl, relative: relativeFromDisk };
  }

  // Last resort: return filename only (not ideal for DB)
  return { url: null, relative: filename };
}

export const signUp = async (req: Request, res: Response) => {
  try {
    const isMultipart = !!req.is("multipart/form-data");

    if (!isMultipart) {
      await processSignUp(req, res, null);
      return;
    }

    // Your helper is configured to receive "image_profil" as the field name
    const upload = uploadFile({
      route: "/uploads/images/user/profile",
      file: "image_profil",
      maxFiles: 1,
      is_img: true,
    });

    upload(req, res, async (err: any) => {
      if (err) {
        return formatResponse({
          res,
          success: false,
          code: 500,
          message: err?.message || "Error uploading file",
        });
      }

      // Remove empty text fields if they arrive as empty strings
      if ((req.body as any)?.image_profil === "")
        delete (req.body as any).image_profil;
      if ((req.body as any)?.image_profile === "")
        delete (req.body as any).image_profile;

      // Normalize the file object from different shapes
      const filesAny: any = (req as any).files || {};
      const fileSingle: any = (req as any).file || null;
      const fileObj =
        fileSingle ??
        filesAny?.image_profil?.[0] ??
        filesAny?.image_profile?.[0] ??
        null;

      // If a file exists, resolve a storable path/URL and assign it to the body
      if (fileObj) {
        const resolved = resolveUploadedImage(fileObj, req, "/uploads");

        // I set the canonical field your backend expects
        // Option 1: store a full URL (good if you read it from clients directly)
        (req.body as any).image_profil = resolved.url ?? resolved.relative;

        // Optionally keep a mirror for "image_profile" for backwards compatibility
        (req.body as any).image_profile = (req.body as any).image_profil;
      }

      await processSignUp(req, res, fileObj ? fileObj : null);
    });
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
    if (files && files.image_profil) {
      try {
        if (req.body.delete !== "profile.png") {
          trash = PROFILE_IMAGE_FOLDER + req.body.delete;
          fs.unlink(trash, (err: any) => {
            if (err) console.error(err);
          });
        }
        fs.unlink(files.image_profil[0].path, (err: any) => {
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
    if (files && files.image_profil) {
      req.body.image_profil = files.image_profil[0].path.replace(
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

    const emailParams = {
      subject: "Welcome to Minhoo!",
      email: email,
      htmlPath: "./src/public/html/email/welcome_to_minhoo.html",
      replacements: [{ name: `${user!.name} ${user!.last_name}` }],
      from: "Minhoo App",
    };
    sendEmail(emailParams);

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
      const send = true; //: any =
      const cod = generateTempPassword();
      if (send == true) {
        const body = {
          code: cod,
          email: email,
          created: now,
        };
        await repository.registerCode(body); //register code

        const emailParams = {
          subject: "Email verification",
          email: email,
          htmlPath: "./src/public/html/email/emailCode.html",
          replacements: [{ code: cod }],
          from: "Minhoo App",
        };
        sendEmail(emailParams);
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

export const requestRestorePassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  const now = new Date(new Date().toUTCString());
  const code = generateTempPassword();
  const body = {
    temp_code: code,
    created_temp_code: now,
  };

  try {
    const user = await repository.findByEmail(email);
    if (user !== null && user !== undefined) {
      await uRepository.update(user.id, body);

      const emailParams = {
        subject: "reset password",
        email: email,
        htmlPath: "./src/public/html/email/reset_your_password.html",
        replacements: [{ code: code, name: user!.name }],
        from: "Minhoo App",
      };

      sendEmail(emailParams);
    }

    return formatResponse({
      res: res,
      success: true,
      body: { created_temp_code: now },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: "error" });
  }
};

export const validateRestorePassword = async (req: Request, res: Response) => {
  const { email, code } = req.body;
  const now = new Date(new Date().toUTCString());

  try {
    const user = await repository.findByEmailAndCode(email, code);
    if (user) {
      return formatResponse({
        res: res,
        success: true,
        body: "code validated",
      });
    } else {
      return formatResponse({
        res: res,
        success: false,
        islogin: true,
        message: "code not validated",
      });
    }
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const restorePassword = async (req: Request, res: Response) => {
  const { email, password, confirm_password } = req.body;
  const hashPassword = generatePassword(password as string);
  req.body.password = hashPassword;
  if (confirm_password != password) {
    return formatResponse({
      res: res,
      success: false,
      islogin: true,
      message: "password and confirm password not match",
    });
  }
  try {
    const userTemp = await repository.findByEmail(email);
    const user = await uRepository.update(userTemp?.id, req.body);

    const emailParams = {
      subject: "reset password",
      email: email,
      htmlPath: "./src/public/html/email/successful_password_change_email.html",
      replacements: [{ name: userTemp!.name }],
      from: "Minhoo App",
    };

    sendEmail(emailParams);
    return formatResponse({
      res: res,
      success: true,
      body: "Password restored successfully",
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const validatePhone = async (req: Request, res: Response) => {
  const { phone } = req.body;

  if (!phone) {
    return formatResponse({
      res,
      success: false,
      message: "Phone is required",
    });
  }

  try {
    const user = await uRepository.findNewPhone(phone);

    if (user) {
      return formatResponse({
        res,
        success: true,
        body: { already_exists: true },
      });
    } else {
      return formatResponse({
        res,
        success: true,
        body: { already_exists: false },
      });
    }
  } catch (error) {
    console.error("Error in validatePhone:", error);
    return formatResponse({
      res,
      success: false,
      message: "Internal server error",
    });
  }
};

function generateTempPassword(): string {
  // Genera un número aleatorio entre 100000 y 999999
  const randomPassword = Math.floor(100000 + Math.random() * 900000);
  return randomPassword.toString(); // Convierte el número a cadena
}
