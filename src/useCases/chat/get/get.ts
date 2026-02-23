import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import {
  emitChatStatusRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";

export const myChats = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const chats = await repository.getUserChats(req.userId, req.userId);
    console.log(
      `[perf][myChats] userId=${req.userId} chats=${Array.isArray(chats) ? chats.length : 0} totalMs=${Date.now() - startedAt}`
    );
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
  const otherUserId = Number(id);

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

    // ✅ al abrir sala se marcan como READ los mensajes recibidos pendientes
    // para que el emisor vea ✔✔ azul dentro y fuera del chat.
    if (chatId != null && messages && messages.length > 0) {
      const pendingToRead: any[] = [];

      for (const m of messages as any[]) {
        const isMine = String(m.senderId) === String(req.userId);
        const status = (m.status ?? "sent") as string;

        if (!isMine && (status === "sent" || status === "delivered") && m.id != null) {
          pendingToRead.push(m);
        }
      }

      if (pendingToRead.length > 0) {
        const { readAt } = await repository.markMessagesAsReadBulk(
          pendingToRead.map((m) => m.id)
        );
        const now = readAt ?? new Date();
        const deliveredAtIso = now.toISOString();

        for (const m of pendingToRead) {
          if (typeof (m as any).setDataValue === "function") {
            (m as any).setDataValue("status", "read");
            (m as any).setDataValue("readAt", now);
            (m as any).setDataValue("deliveredAt", now);
          } else {
            (m as any).status = "read";
            (m as any).readAt = now;
            (m as any).deliveredAt = now;
          }

          const statusPayload = {
            chatId,
            chat_id: chatId,
            messageId: m.id,
            message_id: m.id,
            id: m.id,
            status: "read",
            deliveredAt: deliveredAtIso,
            readAt: deliveredAtIso,
          };

          emitChatStatusRealtime(chatId, statusPayload, [req.userId, otherUserId]);
        }
      }

      // ✅ fuerza refresh de lista de chats para ambos lados (fuera de sala)
      if (Number.isFinite(otherUserId) && otherUserId > 0) {
        emitChatsRefreshRealtime(otherUserId);
      }
      emitChatsRefreshRealtime(req.userId);
    }

    const payload = {
      chatId: messages.length > 0 ? messages[0].chatId : null,
      messages,
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
