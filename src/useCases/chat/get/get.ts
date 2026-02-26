import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { createHash } from "crypto";
import {
  emitChatStatusRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { serializeMessagesToCanonical } from "../_shared/message_contract";

const setNoCacheHeaders = (res: Response) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
};

const buildWeakEtag = (payload: any) => {
  const hash = createHash("sha1").update(JSON.stringify(payload ?? {})).digest("hex");
  return `W/"${hash}"`;
};

const isEtagFresh = (req: Request, etag: string): boolean => {
  const raw = String(req.headers["if-none-match"] ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const tags = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tags.includes(etag);
};

export const myChats = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    setNoCacheHeaders(res);

    const chats = await repository.getUserChats(req.userId, req.userId);
    console.log(
      `[perf][myChats] userId=${req.userId} chats=${Array.isArray(chats) ? chats.length : 0} totalMs=${Date.now() - startedAt}`
    );

    const body = { chatsByUser: chats };
    const etag = buildWeakEtag(body);
    res.set("ETag", etag);
    if (isEtagFresh(req, etag)) {
      res.status(304).end();
      return;
    }

    return formatResponse({
      res,
      success: true,
      body,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const messages = async (req: Request, res: Response) => {
  const { id } = req.params;
  const otherUserId = Number(id);

  const limitRaw = req.query.limit;
  const limitParsed = parseInt(String(limitRaw ?? "50"), 10);
  const limit = Number.isFinite(limitParsed)
    ? Math.max(1, Math.min(limitParsed, 200))
    : 50;

  const beforeRaw = req.query.beforeMessageId;
  const beforeMessageIdParsed =
    beforeRaw == null ? null : parseInt(String(beforeRaw), 10);
  const beforeMessageId = Number.isFinite(beforeMessageIdParsed as any)
    ? (beforeMessageIdParsed as number)
    : null;

  try {
    setNoCacheHeaders(res);

    const messageRows = await repository.getChatByUser(req.userId, id, {
      limit,
      beforeMessageId,
    });

    let chatId =
      messageRows.length > 0
        ? Number((messageRows[0] as any).chatId) || null
        : null;

    if (!chatId) {
      chatId = await repository.getDirectChatIdByUsers(req.userId, id);
    }

    if (chatId != null && messageRows && messageRows.length > 0) {
      const pendingToRead: any[] = [];

      for (const m of messageRows as any[]) {
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

      if (Number.isFinite(otherUserId) && otherUserId > 0) {
        emitChatsRefreshRealtime(otherUserId);
      }
      emitChatsRefreshRealtime(req.userId);
    }

    const payload = {
      chatId,
      messages: serializeMessagesToCanonical(messageRows, { includeLegacy: true }),
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
    setNoCacheHeaders(res);

    const rawMessageId = (req.params as any)?.messageId ?? (req.params as any)?.id;
    const messageId = Number(rawMessageId);

    if (!Number.isFinite(messageId) || messageId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "messageId must be a valid number",
      });
    }

    const response = await repository.resolveConversationByMessageId(
      req.userId,
      messageId
    );

    if (!response) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "message not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
