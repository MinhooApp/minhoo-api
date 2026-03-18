import * as admin from "firebase-admin";
import {
  firebase_key,
  hasFirebaseCredentials,
  firebaseCredentialsSource,
} from "../../useCases/common/push_notification/firebase_key";

const ensureFirebaseApp = () => {
  if (admin.apps.length > 0) return true;
  if (!hasFirebaseCredentials || !firebase_key) {
    console.warn(
      "[firebase] credentials are not configured. Firestore access requires Firebase credentials."
    );
    return false;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(firebase_key as admin.ServiceAccount),
    });
    console.log(
      `[firebase] Firebase admin initialized using ${
        firebaseCredentialsSource ?? "unknown source"
      }`
    );
    return true;
  } catch (error) {
    console.error("[firebase] Failed to initialize Firebase admin:", error);
    return false;
  }
};

export const fb = () => {
  const ready = ensureFirebaseApp();
  if (!ready && admin.apps.length === 0) {
    throw new Error("Firebase credentials are not configured");
  }
  return admin.firestore();
};
