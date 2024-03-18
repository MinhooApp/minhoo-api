import * as admin from 'firebase-admin';
import key from "./key";



export const fb = () => {
    if (admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(key as any) });
    }
    const db = admin.firestore();
    return db;
}