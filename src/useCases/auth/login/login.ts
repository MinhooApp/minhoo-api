import {
  Request,
  Response,
  formatResponse,
  repository,
  bcryptjs,
  generatePassword,
  uRepository,
  sendEmail,
} from "../_module/module";
import { getSocketInstance } from "../../../_sockets/socket_instance";
import User from "../../../_models/user/user";
import * as followerRepo from "../../../repository/follower/follower_repository";
import {
  revokeAllUserAuthSessions,
  revokeAuthSessionsByDeviceUuid,
  revokeUserAuthSessionToken,
} from "../../../libs/auth/user_auth_session";

const normalizeDeviceToken = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase() === "null" || value.toLowerCase() === "undefined") return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const extractDeviceToken = (req: Request): string => {
  const body: any = req.body ?? {};
  const headers: any = req.headers ?? {};

  const candidates = [
    body?.uuid,
    body?.fcmToken,
    body?.fcm_token,
    body?.deviceToken,
    body?.device_token,
    body?.pushToken,
    body?.push_token,
    body?.firebaseToken,
    body?.firebase_token,
    body?.notificationToken,
    body?.notification_token,
    headers?.["x-device-token"],
    headers?.["x-fcm-token"],
    headers?.["x-push-token"],
    headers?.["x-notification-token"],
  ];

  for (const candidate of candidates) {
    const token = normalizeDeviceToken(candidate);
    if (token.length >= 20) return token;
  }

  return "";
};

const normalizePreferredLanguage = (raw: any): "es" | "en" | undefined => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return undefined;

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

  return undefined;
};

const extractPreferredLanguage = (req: Request): "es" | "en" | undefined => {
  const body: any = req.body ?? {};
  const headers: any = req.headers ?? {};
  const candidates = [
    body?.language,
    body?.preferred_language,
    body?.preferredLanguage,
    body?.app_language,
    body?.appLanguage,
    body?.locale,
    body?.lang,
    headers?.["x-app-language"],
    headers?.["x-language"],
    headers?.["x-locale"],
  ];

  for (const candidate of candidates) {
    const normalized = normalizePreferredLanguage(candidate);
    if (normalized) return normalized;
  }

  return undefined;
};

const normalizeAuthToken = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const extractBearerToken = (req: Request): string => {
  const header = req.header("Authorization");
  if (!header) return "";
  return normalizeAuthToken(header);
};

export const login = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const roles: any = []; //
    const email = String(req.body?.email ?? "").trim();
    const inputPassword = String(
      req.body?.password ?? req.body?.clave ?? req.body?.pass ?? ""
    );
    const uuid = extractDeviceToken(req);
    const preferredLanguage = extractPreferredLanguage(req);

    if (!email || !inputPassword) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }

    // Lookup de login ligero (evita includes pesados en esta etapa).
    const userLookupStartedAt = Date.now();
    const userTemp = await repository.findByEmailForLogin(email);
    const userLookupMs = Date.now() - userLookupStartedAt;
    if (!userTemp) {
      console.log("🚫  User no found");
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }
    if ((userTemp as any).is_deleted === true || (userTemp as any).is_deleted === 1) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        code: 403,
        message:
          "Your account has been deleted. Please contact info@minhoo.app to reactivate your account.",
      });
    }
    if ((userTemp as any).disabled === true || (userTemp as any).disabled === 1) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        code: 403,
        message: "This account has been disabled by an administrator.",
      });
    }
    if ((userTemp as any).available === false || (userTemp as any).available === 0) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }
    const storedPassword = String(userTemp.password ?? "");
    if (!storedPassword) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }

    let validatePass = false;
    let shouldUpgradeToHash = false;

    try {
      const looksLikeHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);
      if (looksLikeHash) {
        validatePass = bcryptjs.compareSync(inputPassword, storedPassword);
      } else {
        // Compatibilidad con cuentas antiguas que aún tienen clave en texto plano.
        validatePass = storedPassword === inputPassword;
        shouldUpgradeToHash = validatePass;
      }
    } catch (_error) {
      // Si el valor guardado no es un hash válido, probamos comparación directa.
      validatePass = storedPassword === inputPassword;
      shouldUpgradeToHash = validatePass;
    }

    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    } else {
      if (shouldUpgradeToHash) {
        await uRepository.update(userTemp.id, {
          password: generatePassword(inputPassword),
        });
      }

      userTemp?.roles.forEach((u: any) => {
        roles.push(u.id);
      });

      const user = await repository.saveToken({
        userId: userTemp?.get("id"),
        uuid,
        roles: roles,
        workerId:
          userTemp?.get("worker") != null
            ? userTemp?.get("worker")["id"]
            : null,
      });

      if (preferredLanguage && preferredLanguage !== String((user as any)?.language ?? "")) {
        try {
          await uRepository.update(userTemp.id, { language: preferredLanguage });
          if (typeof (user as any)?.setDataValue === "function") {
            (user as any).setDataValue("language", preferredLanguage);
          } else if (user) {
            (user as any).language = preferredLanguage;
          }
        } catch (languageError) {
          console.log("[login] preferred language update skipped", languageError);
        }
      }

      const loginUserId = Number((user as any)?.id ?? (user as any)?.get?.("id"));
      let counts: { followersCount: number; followingCount: number } | null = null;
      if (Number.isFinite(loginUserId) && loginUserId > 0) {
        counts = await followerRepo.getCounts(loginUserId);
        const fields = {
          followers_count: counts.followersCount,
          followings_count: counts.followingCount,
          following_count: counts.followingCount,
          followersCount: counts.followersCount,
          followingsCount: counts.followingCount,
          followingCount: counts.followingCount,
        };

        if (typeof (user as any)?.setDataValue === "function") {
          Object.entries(fields).forEach(([key, value]) => {
            (user as any).setDataValue(key, value);
          });
        } else if (user) {
          Object.assign(user as any, fields);
        }
      }

      const totalMs = Date.now() - startedAt;
      console.log(
        `[perf][login] email=${email} totalMs=${totalMs} lookupMs=${userLookupMs}`
      );
      return formatResponse({
        res: res,
        success: true,
        body: {
          user,
          counts: counts
            ? {
                followersCount: counts.followersCount,
                followingCount: counts.followingCount,
                followers_count: counts.followersCount,
                followings_count: counts.followingCount,
                following_count: counts.followingCount,
              }
            : null,
        },
      });
    }
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const changePass = async (req: Request, res: Response) => {
  try {
    const { current_password, password, confirm_password } = req.body;
    //Validar Existencia de Usuario
    const userTemp = await repository.findById(req.userId);

    const validatePass = bcryptjs.compareSync(
      String(current_password),
      userTemp?.password
    );
    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Current password not valid.",
      });
    }
    if (password !== confirm_password) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Password and password confirmation do not match",
      });
    }
    const hashPassword = generatePassword(password as string);
    req.body.password = hashPassword;
    const body = {
      password: hashPassword,
      temp_code: null,
      created_temp_code: null,
    };
    await uRepository.update(userTemp?.id, body);
    const emailParams = {
      subject: "reset password",
      email: userTemp!.email,
      htmlPath: "./src/public/html/email/successful_password_change_email.html",
      replacements: [{ name: userTemp!.name }],
      from: "Minhoo App",
    };

    sendEmail(emailParams);
    return formatResponse({ res: res, success: true });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const validateSesion = async (req: Request, res: Response) => {
  try {
    return formatResponse({ res: res, success: true });
  } catch (error) {}
};

const disconnectUserSockets = async (userId: number, onlyAuthToken?: string) => {
  try {
    const io = getSocketInstance();
    if (!io || !userId) return;

    const userRoom = `user_${userId}`;
    const namespaces = ["/", "/api", "/api/v1"];
    for (const namespace of namespaces) {
      const sockets = await io.of(namespace).in(userRoom).fetchSockets();
      for (const s of sockets) {
        if (onlyAuthToken) {
          const socketToken = normalizeAuthToken((s.data as any)?.authToken);
          if (!socketToken || socketToken !== onlyAuthToken) continue;
        }
        s.disconnect(true);
      }
    }
  } catch (error) {
    console.log("⚠️ logout socket disconnect error", error);
  }
};

export const logout = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid session user.",
      });
    }

    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      await revokeUserAuthSessionToken(userId, bearerToken);
      await User.update(
        { auth_token: null },
        {
          where: {
            id: userId,
            auth_token: bearerToken,
          },
        }
      );
      await disconnectUserSockets(userId, bearerToken);
    } else {
      await revokeAllUserAuthSessions(userId);
      await uRepository.update(userId, {
        auth_token: null,
        uuid: null,
      });
      await disconnectUserSockets(userId);
    }

    return formatResponse({ res, success: true });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const logoutDevice = async (req: Request, res: Response) => {
  try {
    const rawUuid = extractDeviceToken(req);
    const userIdRaw = Number(req.body?.userId ?? 0);

    if (!rawUuid || rawUuid.length < 20) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid device token.",
      });
    }

    const where: any = { uuid: rawUuid };
    if (Number.isFinite(userIdRaw) && userIdRaw > 0) {
      where.id = userIdRaw;
    }

    const users = await User.findAll({
      where,
      attributes: ["id"],
      raw: true,
    });

    const affectedUserIds = (users as unknown as Array<{ id: number }>)
      .map((u) => Number(u.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    await revokeAuthSessionsByDeviceUuid(rawUuid, {
      userId: Number.isFinite(userIdRaw) && userIdRaw > 0 ? userIdRaw : null,
    });

    await User.update(
      { uuid: null },
      { where: { uuid: rawUuid, ...(where.id ? { id: where.id } : {}) } }
    );

    // Evita cortar sesiones de otros dispositivos: las sesiones del device quedan revocadas.
    void affectedUserIds;

    return formatResponse({ res, success: true });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const saveDeviceToken = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid session user.",
      });
    }

    const token = extractDeviceToken(req);
    if (!token || token.length < 20) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "Invalid device token.",
      });
    }

    await uRepository.assignUuid(userId, token);

    return formatResponse({
      res,
      success: true,
      body: { saved: true },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
//
