import { firebase_key } from "./firebase_key";
import admin from "firebase-admin";
import { TypeNotification } from "../../../_models/notification/type_notification";

admin.initializeApp({
  credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
});

export const sendPushToSingleUser = async (
  title: string,
  body: string,
  token: string,
  type: TypeNotification,
  id: number
) => {
  const message: admin.messaging.Message = {
    token,
    notification: {
      title,
      body,
    },
    data: {
      title,
      body,
      notificationId: id.toString(),
      type,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "high_importance_channel",
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("✅ Successfully sent message:", response);
  } catch (error: any) {
    if (
      error.errorInfo?.code === "messaging/registration-token-not-registered"
    ) {
      console.error(
        "🚫 The registration token is not registered. Please update your tokens."
      );
    } else {
      console.error("🔥 Error sending message:", error);
    }
  }
};
export const sendPushToMultipleUsers = async (
  title: string,
  body: string,
  tokens: string[]
) => {
  console.log("📣 Enviando notificaciones push a múltiples usuarios");
  console.log("🔑 Firebase Key:", firebase_key);

  const message: admin.messaging.MulticastMessage = {
    notification: {
      title,
      body,
    },
    data: {
      title,
      body,
      idnotificationlog: "4",
    },
    android: {
      priority: "high",
      notification: {
        channelId: "high_importance_channel",
      },
    },
    apns: {
      headers: {
        "apns-priority": "10", // "10" es para notificaciones visibles; "5" es para silenciosas
      },
      payload: {
        aps: {
          alert: {
            title,
            body,
          },
          sound: "default",
        },
      },
    },
    tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log("✅ Notificación enviada con éxito:", response);
  } catch (error) {
    console.error("❌ Error al enviar notificación:", error);
  }
};

function sendMessage(message: any) {
  admin
    .messaging()
    .send(message)
    .then((response) => {
      // Response is a message ID string.
      console.log("Successfully sent message:", response);
    })
    .catch((error) => {
      console.log("Error sending message:", error);
    });
}
