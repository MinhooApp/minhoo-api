import admin from "firebase-admin";
import {
  firebase_key,
  hasFirebaseCredentials,
  firebaseCredentialsSource,
} from "./firebase_key";
import { TypeNotification } from "../../../_models/notification/type_notification";
import { firebaseBreaker } from "../../../libs/helper/circuit_breaker";

/**
 * ✅ Init seguro (evita reinicializar en hot-reload / serverless)
 */
let firebaseMessagingConfigured = false;
if (!admin.apps.length) {
  if (hasFirebaseCredentials && firebase_key) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
      });
      firebaseMessagingConfigured = true;
      console.log(
        `[push] Firebase admin initialized using ${firebaseCredentialsSource ?? "unknown source"}`
      );
    } catch (error) {
      firebaseMessagingConfigured = false;
      console.error("[push] Firebase admin init failed:", error);
    }
  } else {
    console.warn(
      "[push] Firebase credentials are not configured. Push notifications are disabled until credentials are provided."
    );
  }
} else {
  firebaseMessagingConfigured = true;
}

const HIGH_IMPORTANCE_CHANNEL_ID = "high_importance_channel";
const DEFAULT_PUSH_SOUND = "default";
const isFirebaseReady = () => firebaseMessagingConfigured || admin.apps.length > 0;

const isStrictInvalidTokenErrorCode = (code: string): boolean => {
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
};

const isSuspectInvalidTokenErrorCode = (
  code: string,
  details: string
): boolean => {
  return (
    code === "messaging/invalid-argument" &&
    details.includes("registration token")
  );
};

const obfuscateToken = (token: string): string => {
  const value = String(token ?? "").trim();
  if (!value) return "";
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
};

type PushPayload = {
  title: string;
  body: string;
  type: TypeNotification;
  notificationId: number | string;
};

function buildDataPayload(
  payload: PushPayload,
  extraData?: Record<string, any>
): Record<string, string> {
  const base: Record<string, string> = {
    title: payload.title,
    body: payload.body,
    type: String(payload.type),
    notificationId: String(payload.notificationId),
  };

  // ✅ extraData también se manda en data (solo strings)
  if (extraData && typeof extraData === "object") {
    for (const [k, v] of Object.entries(extraData)) {
      if (v === null || v === undefined) continue;
      base[String(k)] = String(v);
    }
  }

  return base;
}

/**
 * 📌 Push a 1 usuario
 * ✅ Ahora soporta 6to parámetro: extraData
 */
export async function sendPushToSingleUser(
  title: string,
  body: string,
  token: string,
  type: TypeNotification,
  notificationId: number,
  extraData?: Record<string, any> // ✅ NUEVO
) {
  if (!isFirebaseReady()) {
    return { ok: false, reason: "NOT_CONFIGURED" as const };
  }

  if (!token?.trim()) {
    return { ok: false, reason: "EMPTY_TOKEN" as const };
  }

  const message: admin.messaging.Message = {
    token,

    // ⚠️ NOTA:
    // Si envías "notification", Android puede mostrarla por sí sola en background,
    // pero tu Flutter usa message.data en foreground.
    // Dejamos notification para UX normal + data para foreground.
    notification: { title, body },

    data: buildDataPayload(
      { title, body, type, notificationId },
      extraData
    ),

    android: {
      priority: "high",
      notification: {
        channelId: HIGH_IMPORTANCE_CHANNEL_ID,
        sound: DEFAULT_PUSH_SOUND,
        defaultSound: true,
      },
    },

    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: DEFAULT_PUSH_SOUND,
        },
      },
    },
  };

  try {
    const messageId = await firebaseBreaker.call(() => admin.messaging().send(message));
    console.log("✅ Push (single) enviado:", messageId);
    return { ok: true, messageId };
  } catch (err: any) {
    if ((err as any)?.circuitOpen) {
      console.warn("[push] Firebase circuit OPEN — skipping single push");
      return { ok: false, reason: "CIRCUIT_OPEN" as const };
    }
    const code = err?.errorInfo?.code ?? err?.code;
    const detailsRaw = String(err?.errorInfo?.message ?? err?.message ?? "");
    const details = detailsRaw.toLowerCase();

    if (code === "messaging/registration-token-not-registered") {
      console.log("🚫 Token no registrado. Debes eliminarlo/actualizarlo en BD.");
      return { ok: false, reason: "TOKEN_NOT_REGISTERED" as const, code };
    }

    if (code === "messaging/invalid-registration-token") {
      console.log("🚫 Token inválido. Debes eliminarlo/actualizarlo en BD.");
      return { ok: false, reason: "TOKEN_INVALID" as const, code };
    }

    if (isSuspectInvalidTokenErrorCode(String(code ?? ""), details)) {
      console.warn("⚠️ Push (single) invalid-argument sospechoso de token:", {
        code,
        token: obfuscateToken(token),
        message: detailsRaw.slice(0, 220),
      });
    }

    console.error("🔥 Error enviando push (single):", err);
    return { ok: false, reason: "UNKNOWN_ERROR" as const, code, err };
  }
}

/**
 * 📌 Push a múltiples usuarios (Multicast)
 * ✅ También soporta extraData (opcional)
 */
export async function sendPushToMultipleUsers(
  title: string,
  body: string,
  type: TypeNotification,
  notificationId: number | string,
  tokens: string[],
  extraData?: Record<string, any> // ✅ NUEVO
) {
  if (!isFirebaseReady()) {
    return { ok: false, reason: "NOT_CONFIGURED" as const };
  }

  const FIREBASE_MULTICAST_BATCH_SIZE = 500; // Firebase hard limit per sendEachForMulticast call
  const cleanTokens = (tokens ?? []).map(t => t?.trim()).filter(Boolean);

  if (cleanTokens.length === 0) {
    console.warn("⚠️ Lista de tokens vacía: no se envía push.");
    return { ok: false, reason: "EMPTY_TOKENS" as const };
  }

  // Split into batches to respect Firebase's 500-token limit.
  // Process batches sequentially to avoid flooding Firebase on large sends.
  if (cleanTokens.length > FIREBASE_MULTICAST_BATCH_SIZE) {
    let totalSuccess = 0;
    let totalFailure = 0;
    const allInvalidTokens: string[] = [];
    const allSuspectTokens: string[] = [];
    const allInvalidDetails: any[] = [];

    for (let i = 0; i < cleanTokens.length; i += FIREBASE_MULTICAST_BATCH_SIZE) {
      const batch = cleanTokens.slice(i, i + FIREBASE_MULTICAST_BATCH_SIZE);
      const batchResult = await sendPushToMultipleUsers(title, body, type, notificationId, batch, extraData);
      if ((batchResult as any).ok) {
        totalSuccess += (batchResult as any).successCount ?? 0;
        totalFailure += (batchResult as any).failureCount ?? 0;
        allInvalidTokens.push(...((batchResult as any).invalidTokens ?? []));
        allSuspectTokens.push(...((batchResult as any).suspectInvalidTokens ?? []));
        allInvalidDetails.push(...((batchResult as any).invalidTokenDetails ?? []));
      }
    }
    return {
      ok: true,
      successCount: totalSuccess,
      failureCount: totalFailure,
      invalidTokens: allInvalidTokens,
      suspectInvalidTokens: allSuspectTokens,
      invalidTokenDetails: allInvalidDetails,
    };
  }

  const message: admin.messaging.MulticastMessage = {
    tokens: cleanTokens,
    notification: { title, body },

    data: buildDataPayload(
      { title, body, type, notificationId },
      extraData
    ),

    android: {
      priority: "high",
      notification: {
        channelId: HIGH_IMPORTANCE_CHANNEL_ID,
        sound: DEFAULT_PUSH_SOUND,
        defaultSound: true,
      },
    },

    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: DEFAULT_PUSH_SOUND,
        },
      },
    },
  };

  try {
    const resp = await firebaseBreaker.call(() => admin.messaging().sendEachForMulticast(message));

    console.log("✅ Push (multicast) enviado:", {
      successCount: resp.successCount,
      failureCount: resp.failureCount,
    });

    const invalidTokens: string[] = [];
    const suspectInvalidTokens: string[] = [];
    const invalidTokenDetails: Array<{
      token: string;
      code: string;
      message: string;
      strict: boolean;
    }> = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = String(
          (r.error as any)?.errorInfo?.code ?? (r.error as any)?.code ?? ""
        );
        const detailsRaw = String(
          (r.error as any)?.errorInfo?.message ?? (r.error as any)?.message ?? ""
        );
        const details = detailsRaw.toLowerCase();
        const token = String(cleanTokens[idx] ?? "").trim();

        if (!token) return;

        if (isStrictInvalidTokenErrorCode(code)) {
          invalidTokens.push(token);
          invalidTokenDetails.push({
            token,
            code,
            message: detailsRaw,
            strict: true,
          });
          return;
        }

        if (isSuspectInvalidTokenErrorCode(code, details)) {
          suspectInvalidTokens.push(token);
          invalidTokenDetails.push({
            token,
            code,
            message: detailsRaw,
            strict: false,
          });
        }
      }
    });

    if (invalidTokens.length) {
      console.warn("🧹 Tokens inválidos (strict) detectados:", invalidTokens.length);
    }

    if (suspectInvalidTokens.length) {
      console.warn("⚠️ Tokens sospechosos (no auto-limpieza) detectados:", {
        count: suspectInvalidTokens.length,
        sample: suspectInvalidTokens.slice(0, 3).map(obfuscateToken),
      });
    }

    return {
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidTokens,
      suspectInvalidTokens,
      invalidTokenDetails,
    };
  } catch (err: any) {
    if ((err as any)?.circuitOpen) {
      console.warn("[push] Firebase circuit OPEN — skipping multicast push");
      return { ok: false, reason: "CIRCUIT_OPEN" as const };
    }
    console.error("❌ Error enviando push (multicast):", err);
    return { ok: false, reason: "UNKNOWN_ERROR" as const, err };
  }
}
