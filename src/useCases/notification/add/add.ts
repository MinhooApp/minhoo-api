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
  notification_date?: Date;
  type:
    | "postulation"
    | "comment"
    | "offerAccepted"
    | "like"
    | "admin"
    | "message";
  message: string;
  likerId?: number; // ID del usuario que dio el "like" (opcional)
  commentId?: number; // ID del comentario (opcional)
  messageId?: number; // ID del mensaje (opcional)
}

export const sendNotification = async (
  params: SendNotificationParams
): Promise<void> => {
  try {
    // Verificar si userId e interactorId son diferentes
    if (params.userId === params.interactorId) {
      // Si son iguales, no hacer nada y salir de la función
      return;
    }

    const now = new Date(new Date().toUTCString());

    // Crear la notificación a partir de los parámetros
    const notificationData = {
      userId: params.userId,
      interactorId: params.interactorId,
      serviceId: params.serviceId,
      postId: params.postId,
      offerId: params.offerId,
      type: params.type,
      message: params.message,
      likerId: params.likerId, // ID del usuario que dio el "like"
      commentId: params.commentId, // ID del comentario
      messageId: params.messageId, // ID del mensaje
      notification_date: now,
      read: false, // Asumimos que la notificación no está leída al momento de su creación
    };

    // Agregar la notificación a la base de datos usando el repositorio
    const notification = await repository.add(notificationData);
    const uuid = await userRepository.getUuid(params.userId);
    socket.emit("notification", notification);
    sendPushToSingleUser("Minhoo news", params.message, uuid);
  } catch (error) {
    console.error("Error al enviar la notificación:", error);
    throw error; // Puedes lanzar el error o manejarlo según tu lógica de manejo de errores
  }
};
