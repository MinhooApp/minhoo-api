import {
  formatResponse,
  repository,
  uRepository,
  generatePassword,
  Request,
  Response,
  sendEmail,
  bcryptjs,
  multer,
} from "../_module/module";
import {
  normalizeRemoteHttpUrl,
  uploadImageBufferToCloudflare,
} from "../../_utils/cloudflare_images";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";

const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const uploadSignUpAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: AVATAR_MAX_BYTES },
}).fields([
  { name: "image_profil", maxCount: 1 },
  { name: "image_profile", maxCount: 1 },
]);

// signUp.ts
const now: any = new Date(new Date().toUTCString());

const resetSignUpContactAndLocation = (body: any) => {
  // Evita persistir placeholders enviados por el cliente al crear cuenta.
  const fieldsToNull = [
    "dialing_code",
    "iso_code",
    "phone",
    "language",
    "language_ids",
    "language_codes",
    "language_names",
    "countryId",
    "cityId",
    "country_origin_id",
    "country_origin_code",
    "country_residence_id",
    "state_residence_id",
    "state_residence_code",
    "city_residence_id",
    "city_residence_name",
    "last_longitude",
    "last_latitude",
  ];

  for (const key of fieldsToNull) {
    body[key] = null;
  }
};

const pickFirstPresent = (...candidates: any[]) => {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (String(candidate).trim().length === 0) continue;
    return candidate;
  }
  return undefined;
};

const resolveValidationEmailLocale = (
  req: Request,
  fallback: AppLocale = "en",
  useAcceptLanguage = true
): AppLocale => {
  const body: any = req.body ?? {};
  const query: any = req.query ?? {};

  const preferredLanguage = pickFirstPresent(
    // Prioridad 1: señales explícitas de app en headers.
    req.header("x-app-language"),
    req.header("x-app-lang"),
    req.header("x-app-locale"),
    req.header("x-app-language-id"),
    req.header("x-preferred-language"),
    req.header("x-language"),
    req.header("x-locale"),
    req.header("x-lang"),
    req.header("x-ui-language"),
    req.header("x-ui-locale"),
    req.header("content-language"),
    // Prioridad 2: campos explícitos de app/locale en body y query.
    body?.app_language,
    body?.appLanguage,
    body?.app_language_id,
    body?.appLanguageId,
    body?.app_language_code,
    body?.appLanguageCode,
    body?.app_lang,
    body?.appLang,
    body?.app_locale,
    body?.appLocale,
    body?.app_locale_code,
    body?.appLocaleCode,
    body?.ui_language,
    body?.uiLanguage,
    body?.ui_locale,
    body?.uiLocale,
    body?.locale,
    body?.locale_code,
    body?.localeCode,
    body?.lang,
    body?.lang_code,
    body?.langCode,
    body?.language_id,
    body?.languageId,
    body?.preferred_language_id,
    body?.preferredLanguageId,
    body?.preferred_language,
    body?.preferredLanguage,
    query?.app_language,
    query?.appLanguage,
    query?.app_language_id,
    query?.appLanguageId,
    query?.app_language_code,
    query?.appLanguageCode,
    query?.app_lang,
    query?.appLang,
    query?.app_locale,
    query?.appLocale,
    query?.app_locale_code,
    query?.appLocaleCode,
    query?.ui_language,
    query?.uiLanguage,
    query?.ui_locale,
    query?.uiLocale,
    query?.locale,
    query?.locale_code,
    query?.localeCode,
    query?.lang,
    query?.lang_code,
    query?.langCode,
    query?.language_id,
    query?.languageId,
    query?.preferred_language_id,
    query?.preferredLanguageId,
    query?.preferred_language,
    query?.preferredLanguage,
    // Prioridad 3: campos genéricos (posibles defaults viejos del cliente).
    body?.language,
    body?.idioma,
    body?.lenguaje,
    query?.language,
    query?.idioma,
    query?.lenguaje,
    body?.device_language,
    body?.deviceLanguage,
    body?.device_language_id,
    body?.deviceLanguageId,
    body?.device_lang,
    body?.deviceLang,
    body?.device_locale,
    body?.deviceLocale,
    body?.device_locale_code,
    body?.deviceLocaleCode,
    body?.system_language,
    body?.systemLanguage,
    body?.system_lang,
    body?.systemLang,
    query?.device_language,
    query?.deviceLanguage,
    query?.device_lang,
    query?.deviceLang,
    query?.device_locale,
    query?.deviceLocale,
    query?.device_locale_code,
    query?.deviceLocaleCode,
    query?.system_language,
    query?.systemLanguage,
    query?.system_lang,
    query?.systemLang,
    body?.accept_language,
    body?.acceptLanguage,
    query?.accept_language,
    query?.acceptLanguage
  );

  return resolveLocale({
    preferredLanguage,
    acceptLanguage: useAcceptLanguage ? req.header("accept-language") : undefined,
    fallback,
  });
};

const isDeletedAccount = (user: any): boolean =>
  user?.is_deleted === true || user?.is_deleted === 1;

const isDisabledAccount = (user: any): boolean =>
  user?.disabled === true || user?.disabled === 1;

const isUnavailableAccount = (user: any): boolean =>
  user?.available === false || user?.available === 0;

const getLoginStyleAccountBlock = (
  user: any
): { blocked: boolean; code?: number; message?: string } => {
  if (isDeletedAccount(user)) {
    return {
      blocked: true,
      code: 403,
      message:
        "Your account has been deleted. Please contact info@minhoo.app to reactivate your account.",
    };
  }
  if (isDisabledAccount(user)) {
    return {
      blocked: true,
      code: 403,
      message: "This account has been disabled by an administrator.",
    };
  }
  if (isUnavailableAccount(user)) {
    return {
      blocked: true,
      message: "User and/or Password not valid.",
    };
  }
  return { blocked: false };
};

const buildExistingEmailMessage = (
  isSpanish: boolean,
  deletedAccount: boolean
): string => {
  if (deletedAccount) {
    return isSpanish
      ? "Este correo pertenece a una cuenta eliminada. Solo un administrador puede reactivarla."
      : "This email belongs to a deleted account. Only an administrator can reactivate it.";
  }
  return isSpanish ? "El correo ya existe" : "The email already exists";
};

export const signUp = async (req: Request, res: Response) => {
  try {
    const isMultipart = !!req.is("multipart/form-data");

    if (!isMultipart) {
      await processSignUp(req, res);
      return;
    }

    uploadSignUpAvatar(req, res, async (err: any) => {
      if (err) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: err?.message || "Error uploading file",
        });
      }

      try {
        if ((req.body as any)?.image_profil === "")
          delete (req.body as any).image_profil;
        if ((req.body as any)?.image_profile === "")
          delete (req.body as any).image_profile;

        const filesAny: any = (req as any).files || {};
        const fileSingle: any = (req as any).file || null;
        const fileObj =
          fileSingle ??
          filesAny?.image_profil?.[0] ??
          filesAny?.image_profile?.[0] ??
          null;

        const arrProfil: any[] = filesAny.image_profil ?? [];
        const arrProfile: any[] = filesAny.image_profile ?? [];
        const total =
          (fileSingle ? 1 : 0) +
          (arrProfil?.length || 0) +
          (arrProfile?.length || 0);
        if ((arrProfil.length > 0 && arrProfile.length > 0) || total > 1) {
          return formatResponse({
            res,
            success: false,
            code: 400,
            message:
              "Solo se permite 1 archivo con el campo image_profile O image_profil.",
          });
        }

        if (fileObj?.buffer) {
          const uploadedAvatar = await uploadImageBufferToCloudflare({
            buffer: fileObj.buffer,
            filename: fileObj.originalname,
            mimeType: fileObj.mimetype,
            metadata: {
              app: "minhoo",
              context: "signup-avatar",
              email: String((req.body as any)?.email ?? "").trim(),
            },
          });
          (req.body as any).image_profil = uploadedAvatar.url;
          (req.body as any).image_profile = uploadedAvatar.url;
        }

        await processSignUp(req, res);
      } catch (uploadError: any) {
        return formatResponse({
          res,
          success: false,
          code: 502,
          message: uploadError?.message ?? "cloudflare upload failed",
        });
      }
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
const processSignUp = async (req: Request, res: Response) => {
  const { email, password, confirm_password, uuid } = req.body;
  const locale = resolveValidationEmailLocale(req);
  const isSpanish = locale === "es";

  // En signup no guardamos teléfono/ubicación hasta que el usuario lo edite.
  resetSignUpContactAndLocation(req.body);

  const rawAvatarUrl =
    (req.body as any)?.image_profil ?? (req.body as any)?.image_profile;
  const normalizedAvatarUrl = normalizeRemoteHttpUrl(rawAvatarUrl);
  const hasAvatarUrl =
    rawAvatarUrl !== undefined && String(rawAvatarUrl ?? "").trim() !== "";
  if (hasAvatarUrl && !normalizedAvatarUrl) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "image_profil must be a valid http(s) URL",
    });
  }
  if (normalizedAvatarUrl) {
    (req.body as any).image_profil = normalizedAvatarUrl;
    (req.body as any).image_profile = normalizedAvatarUrl;
  }

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
    return formatResponse({
      res,
      success: false,
      code: 401,
      message: buildExistingEmailMessage(
        isSpanish,
        isDeletedAccount(validateEmail)
      ),
      islogin: true,
    });
  }

  try {
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
    return formatResponse({
      res,
      success: false,
      message: error.message || "An error occurred during user registration",
    });
  }
};

export const validateEmail = async (req: Request, res: Response) => {
  const { email } = req.body;
  // En validación de correo para alta, si no llega idioma, priorizamos español por defecto.
  const locale = resolveValidationEmailLocale(req, "es", false);
  const isSpanish = locale === "es";

  try {
    const validateEmail = await repository.findByEmail(email);

    if (validateEmail) {
      return formatResponse({
        res: res,
        success: false,
        code: 401,
        message: buildExistingEmailMessage(
          isSpanish,
          isDeletedAccount(validateEmail)
        ),
      });
    } else {
      const send = true; //: any =
      const cod = generateTempPassword();
      if (send == true) {
        const body = {
          code: cod,
          email: email,
          created: now,
          locale_used: locale,
        };
        await repository.registerCode(body); //register code

        const emailParams = {
          subject: isSpanish ? "Verificacion de correo" : "Email verification",
          email: email,
          htmlPath: isSpanish
            ? "./src/public/html/email/emailCode_es.html"
            : "./src/public/html/email/emailCode.html",
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

  try {
    const user = await repository.findByEmail(email);
    if (user === null || user === undefined) {
      return formatResponse({
        res: res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    const accountBlock = getLoginStyleAccountBlock(user);
    if (accountBlock.blocked) {
      return formatResponse({
        res,
        success: false,
        islogin: true,
        ...(accountBlock.code ? { code: accountBlock.code } : {}),
        message: accountBlock.message,
      });
    }

    const code = generateTempPassword();
    const body = {
      temp_code: code,
      created_temp_code: now,
    };

    await uRepository.update(user.id, body);

    const emailParams = {
      subject: "reset password",
      email: email,
      htmlPath: "./src/public/html/email/reset_your_password.html",
      replacements: [{ code: code, name: user!.name }],
      from: "Minhoo App",
    };

    const sent = await sendEmail(emailParams);
    if (!sent) {
      return formatResponse({
        res: res,
        success: false,
        code: 500,
        message: "failed to send reset email",
      });
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

  try {
    const userByEmail = await repository.findByEmail(email);
    if (!userByEmail) {
      return formatResponse({
        res: res,
        success: false,
        islogin: true,
        message: "code not validated",
      });
    }

    const accountBlock = getLoginStyleAccountBlock(userByEmail);
    if (accountBlock.blocked) {
      return formatResponse({
        res,
        success: false,
        islogin: true,
        ...(accountBlock.code ? { code: accountBlock.code } : {}),
        message: accountBlock.message,
      });
    }

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
    const accountBlock = getLoginStyleAccountBlock(userTemp);
    if (accountBlock.blocked) {
      return formatResponse({
        res,
        success: false,
        islogin: true,
        ...(accountBlock.code ? { code: accountBlock.code } : {}),
        message: accountBlock.message,
      });
    }

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
