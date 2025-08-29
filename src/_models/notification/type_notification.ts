// type_notification.ts
export const TypeNotificationEnum = [
  "postulation",
  "comment",
  "offerAccepted",
  "applicationCanceled",
  "applicationRemoved",
  "like",
  "admin",
  "follow",
  "message",
  "requestCanceled",
  "newService",
] as const;

export type TypeNotification = (typeof TypeNotificationEnum)[number];
