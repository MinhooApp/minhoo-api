import { firebase_key } from "./firebase_key";
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
});

export const sendPushToOneUser = async (title: any, body: any, token: any) => {
  console.log("AQUII ");

  let message = {
    token: token,
    notification: {
      title: title, // Android, iOS (Watch)
      body: body, // Android, iOS
    },
    data: {
      title: title,
      body: body,
      idnotificationlog: "4",
    },
  };

  sendMessage(message);
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

export const sendPushToTopic = async (title: any, body: any, topic: any) => {
  let message = {
    topic: topic,
    notification: {},
    data: {
      title: title,
      body: body,
    },
  };

  sendMessage(message);
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
