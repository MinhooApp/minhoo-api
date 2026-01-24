import {
  Request,
  Response,
  formatResponse,
  repository,
  socket, // ✅ viene de ../_module/module
} from "../_module/module";

export const myChats = async (req: Request, res: Response) => {
  try {
    const chats = await repository.getUserChats(req.userId, req.userId);
    return formatResponse({
      res,
      success: true,
      body: { chatsByUser: chats },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const messages = async (req: Request, res: Response) => {
  const { id } = req.params; // id = userId del otro usuario

  // ✅ NUEVO: paginación (sin romper si no mandan query)
  const limitRaw = req.query.limit;
  const limitParsed = parseInt(String(limitRaw ?? "50"), 10);
  const limit = Number.isFinite(limitParsed) ? Math.max(1, Math.min(limitParsed, 200)) : 50;

  const beforeRaw = req.query.beforeMessageId;
  const beforeMessageIdParsed =
    beforeRaw == null ? null : parseInt(String(beforeRaw), 10);
  const beforeMessageId =
    Number.isFinite(beforeMessageIdParsed as any) ? (beforeMessageIdParsed as number) : null;

  try {
    // ✅ ahora pasamos opciones (si tu repo aún no las usa, NO rompe)
    const messages = await repository.getChatByUser(req.userId, id, {
      limit,
      beforeMessageId,
    });

    // chatId para emitir eventos
    const chatId = messages.length > 0 ? messages[0].chatId : null;

    // ✅ marcar DELIVERED al abrir el chat (mensajes NO míos que siguen en sent)
    // y emitir al socket server para que el emisor actualice en TIEMPO REAL.
    if (chatId != null && messages && messages.length > 0) {
      for (const m of messages as any[]) {
        const isMine = String(m.senderId) === String(req.userId);
        const status = (m.status ?? "sent") as string;

        if (!isMine && status === "sent" && m.id != null) {
          // update DB
          if (typeof m.update === "function") {
            await m.update({
              status: "delivered",
              deliveredAt: new Date(),
            });
          }

          // ✅ emitir al socket server -> este rebota al emisor (chat/status/{chatId})
          socket.emit("chat:delivered", {
            chatId,
            messageId: m.id,
            userId: req.userId,
          });
        }
      }
    }

    // 🔄 volver a cargar para devolver YA actualizado
    // ✅ IMPORTANTE: recarga con las mismas opciones para NO cambiar la página
    const messagesUpdated = await repository.getChatByUser(req.userId, id, {
      limit,
      beforeMessageId,
    });

    const payload = {
      chatId: messagesUpdated.length > 0 ? messagesUpdated[0].chatId : null,
      messages: messagesUpdated,
      // opcional útil para el cliente:
      paging: {
        limit,
        beforeMessageId,
      },
    };

    return formatResponse({ res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const getUserByMessage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const response = await repository.getSenderByMessageId(id);
    const user = (response as any)?.sender ?? null;
    if (!user) {
      return formatResponse({
        res,
        success: false,
        message: "User not found",
      });
    }
    return formatResponse({
      res,
      success: true,
      body: { user },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
