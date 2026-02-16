import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";

const toInt = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const buildFullName = (sender: any): string => {
  if (!sender) return "";

  const firstName = (sender.name ?? sender.firstName ?? sender.firstname ?? "")
    .toString()
    .trim();

  const lastName = (
    sender.lastName ??
    sender.lastname ??
    sender.surname ??
    sender.last_name ??
    ""
  )
    .toString()
    .trim();

  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (combined) return combined;

  const fullName = (sender.fullName ?? sender.userName ?? sender.username ?? "")
    .toString()
    .trim();

  return fullName;
};

const buildSenderTitle = (_senderId: number, fullName: string): string => {
  const name = (fullName || "").trim();
  return name ? name : "Nuevo mensaje";
};

export const sendMessage = async (req: Request, res: Response) => {
  const { userId, message } = req.body;

  // ✅ aceptar reply (camelCase + snake_case)
  const replyToMessageId =
    toInt(req.body.replyToMessageId) ?? toInt(req.body.reply_to_message_id);

  try {
    const flag = await repository.validateBlock(req.userId, userId);

    if (flag) {
      return formatResponse({
        res,
        success: false,
        message: "User not fount",
      });
    }

    // ✅ guardar mensaje (con reply)
    const created = await repository.initNewChat(
      req.userId,
      userId,
      message,
      replyToMessageId
    );
    if (!created || !created.chatId || !created.messageId) {
      return formatResponse({
        res,
        success: false,
        message: "No se pudo enviar el mensaje",
      });
    }

    const chatId = Number((created as any).chatId);
    const createdMessageId = Number((created as any).messageId);
    const fullMessage = await repository.getSenderByMessageId(createdMessageId);
    if (!fullMessage) {
      return formatResponse({
        res,
        success: false,
        message: "No se pudo cargar el mensaje enviado",
      });
    }

    // ✅ fallback por si el repo no devolvió el campo reply
    if (replyToMessageId != null) {
      (fullMessage as any).replyToMessageId ??= replyToMessageId;
      (fullMessage as any).reply_to_message_id ??= replyToMessageId;

      if (!(fullMessage as any).replyTo) {
        (fullMessage as any).replyTo = null;
      }
    }

    //////// Emit the chat ///////
    socket.emit("chat", fullMessage);
    socket.emit("chats", userId);
    socket.emit("chats", req.userId);

    // ==========================================================
    // ✅ senderName = "ID: X\nNombre Apellido"
    // ==========================================================
    const senderId = req.userId;
    const senderFromMessage = (fullMessage as any)?.sender;

    // 1) intento directo desde fullMessage.sender
    let fullName = buildFullName(senderFromMessage);

    // 2) si no trae apellido (o viene vacío), buscar el user real del emisor
    if (!fullName || fullName.split(" ").length < 2) {
      try {
        // Intentos de métodos comunes (no rompe si no existen)
        const me =
          (repository as any).getUserById?.(senderId) ??
          (repository as any).getUser?.(senderId) ??
          (repository as any).findUserById?.(senderId);

        const resolved = await me;
        if (resolved) {
          const fixed = buildFullName(resolved);
          if (fixed) fullName = fixed;
        }
      } catch (_) {
        // no rompemos el chat si el fallback falla
      }
    }

    // title final sin ID
    const senderName = buildSenderTitle(senderId, fullName || "Nuevo mensaje");

    const rawPreview = (message ?? "").toString().trim();
    const snippet =
      rawPreview.length > 60 ? `${rawPreview.slice(0, 60)}...` : rawPreview;
    const notificationBody = snippet || "You have a new message";

    // ✅ enviar push
    await sendNotification({
      userId,                  // receptor
      interactorId: senderId,   // senderId
      messageId: createdMessageId,
      type: "message",
      message: notificationBody,
      senderName,              // 👈 title = "ID: X\nNombre Apellido"
    });

    // ✅ recargar al final para evitar devolver estados viejos (ticks)
    const messages = await repository.getChatByUser(req.userId, userId);

    const payload = {
      chatId: messages.length > 0 ? messages[0].chatId : chatId,
      messages,
    };

    return formatResponse({ res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error as any });
  }
};

