import { firebase_key } from "./firebase_key";
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
});

export const sendPushToSingleUser = async (
  title: string,
  body: string,
  token: string
) => {
  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: {
      title: title,
      body: body,
      idnotificationlog: "4",
    },
    token: token,
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("Successfully sent message:", response);
  } catch (error: any) {
    if (
      error.errorInfo.code === "messaging/registration-token-not-registered"
    ) {
      console.error(
        "The registration token is not registered. Please update your tokens."
      );
      // Aquí podrías eliminar el token de la base de datos o tomar otra acción
    } else {
      console.error("Error sending message:", error);
    }
  }
};
export const sendPushToMultipleUsers = async (
  title: string,
  body: string,
  tokens: string[]
) => {
  console.log("AQUII ");
  console.log(firebase_key);
  const message = {
    notification: {
      title: title, // Android, iOS (Watch)
      body: body, // Android, iOS
    },
    data: {
      title: title,
      body: body,
      idnotificationlog: "4",
    },
    tokens: tokens,
  };

  try {
    const response = await admin.messaging().sendMulticast(message);
    console.log("Successfully sent message:", response);
  } catch (error) {
    console.error("Error sending message:", error);
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
