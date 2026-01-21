import { TypeNotification } from "_models/notification/type_notification";
import {
  repository,
  sendPushToSingleUser,
  userRepository,
  socket,
} from "../_module/module";

interface SendNotificationParams {
  userId: number;
  interactorId?: number;
  serviceId?: number;
  postId?: number;
  offerId?: number;
  followerId?: number;
  notification_date?: Date;
  type: TypeNotification;
  message: string;

  likerId?: number;
  commentId?: number;
  messageId?: number;

  // ✅ NUEVO: nombre del que dispara la notificación (chat)
  senderName?: string;
}

export const sendNotification = async (
  params: SendNotificationParams
): Promise<void> => {
  try {
    // si es el mismo usuario, puedes evitar notificar (si quieres)
    if (params.userId === params.interactorId) {
      // return;
    }

    const now = new Date(new Date().toUTCString());

    const notificationData = {
      userId: params.userId,
      interactorId: params.interactorId,
      serviceId: params.serviceId,
      postId: params.postId,
      offerId: params.offerId,
      type: params.type,
      message: params.message,
      likerId: params.likerId,
      commentId: params.commentId,
      messageId: params.messageId,
      notification_date: now,
      read: false,
    };

    const notification = await repository.add(notificationData);
    const uuid = await userRepository.getUuid(params.userId);

    socket.emit("notification", notification);

    // ✅ Para chat: queremos que se vea el nombre en la barra de notificaciones
    const pushTitle =
      params.type === "message"
        ? (params.senderName?.trim() || "Nuevo mensaje")
        : "Minhoo news";

    const pushBody = params.message;

    // ✅ data extra para Flutter (foreground)
    const extraData = {
      senderName: params.senderName ?? "",     // Flutter lo usa como title
      senderId: params.interactorId ?? "",     // para filtrar/suprimir
      // opcional:
      messageId: params.messageId ?? "",
    };

    sendPushToSingleUser(
      pushTitle,
      pushBody,
      uuid,
      params.type,
      getFirstAvailableId(notificationData),
      extraData
    );
  } catch (error) {
    console.error("Error al enviar la notificación:", error);
    throw error;
  }
};

function getFirstAvailableId(data: SendNotificationParams): number {
  switch (data.type) {
    case "postulation":
    case "applicationCanceled":
    case "offerAccepted":
    case "applicationRemoved":
    case "requestCanceled":
      return data.serviceId!;

    case "like":
    case "comment":
      return data.postId!;

    case "follow":
    case "message":
      return data.interactorId!;

    case "admin":
    default:
      return (data.serviceId ||
        data.postId ||
        data.offerId ||
        data.likerId ||
        data.commentId ||
        data.followerId ||
        data.messageId!)!;
  }
}
