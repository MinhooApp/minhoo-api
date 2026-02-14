import admin from "firebase-admin";
import { firebase_key } from "./firebase_key";
import { TypeNotification } from "../../../_models/notification/type_notification";

/**
 * ✅ Init seguro (evita reinicializar en hot-reload / serverless)
 */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
  });
}

const HIGH_IMPORTANCE_CHANNEL_ID = "high_importance_channel";

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
  if (!token?.trim()) {
    console.warn("⚠️ Token vacío: no se envía push.");
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
      notification: { channelId: HIGH_IMPORTANCE_CHANNEL_ID },
    },

    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
        },
      },
    },
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log("✅ Push (single) enviado:", messageId);
    return { ok: true, messageId };
  } catch (err: any) {
    const code = err?.errorInfo?.code ?? err?.code;

    if (code === "messaging/registration-token-not-registered") {
      console.error("🚫 Token no registrado. Debes eliminarlo/actualizarlo en BD.");
      return { ok: false, reason: "TOKEN_NOT_REGISTERED" as const, code };
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
  const cleanTokens = (tokens ?? []).map(t => t?.trim()).filter(Boolean);

  if (cleanTokens.length === 0) {
    console.warn("⚠️ Lista de tokens vacía: no se envía push.");
    return { ok: false, reason: "EMPTY_TOKENS" as const };
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
      notification: { channelId: HIGH_IMPORTANCE_CHANNEL_ID },
    },

    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
        },
      },
    },
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(message);

    console.log("✅ Push (multicast) enviado:", {
      successCount: resp.successCount,
      failureCount: resp.failureCount,
    });

    const invalidTokens: string[] = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = (r.error as any)?.errorInfo?.code ?? (r.error as any)?.code;
        if (code === "messaging/registration-token-not-registered") {
          invalidTokens.push(cleanTokens[idx]);
        }
      }
    });

    if (invalidTokens.length) {
      console.warn("🧹 Tokens no registrados detectados:", invalidTokens.length);
    }

    return {
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidTokens,
    };
  } catch (err: any) {
    console.error("❌ Error enviando push (multicast):", err);
    return { ok: false, reason: "UNKNOWN_ERROR" as const, err };
  }
}
