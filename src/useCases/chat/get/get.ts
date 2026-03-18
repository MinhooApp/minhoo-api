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
import {
  isSummaryMode,
  toChatMessageSummary,
  toChatSummary,
} from "../../../libs/summary_response";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";

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

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const applyRelativeToLegacyChats = (rows: any[], locale: AppLocale) => {
  if (!Array.isArray(rows)) return rows;

  rows.forEach((row: any) => {
    const chat = (row as any)?.Chat;
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const lastMessage = messages[0] ?? null;
    const referenceDate =
      (lastMessage as any)?.date ??
      (lastMessage as any)?.createdAt ??
      (lastMessage as any)?.updatedAt ??
      (row as any)?.updatedAt ??
      (chat as any)?.updatedAt ??
      (row as any)?.createdAt ??
      null;

    const relativeTime = formatRelativeTime(referenceDate, locale);
    if (!relativeTime) return;

    if (lastMessage) {
      setValue(lastMessage, "relativeTime", relativeTime);
      setValue(lastMessage, "relative_time", relativeTime);
    }

    setValue(row, "relativeTime", relativeTime);
    setValue(row, "relative_time", relativeTime);
    setValue(chat, "relativeTime", relativeTime);
    setValue(chat, "relative_time", relativeTime);
  });

  return rows;
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = Number((req as any)?.userId ?? 0);

  if (!Number.isFinite(userId) || userId <= 0) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  try {
    const pushSettings = await userRepository.getPushSettings(userId);
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
      storedLanguage: pushSettings?.language,
      storedLanguageCodes: pushSettings?.language_codes,
      storedLanguageNames: pushSettings?.language_names,
    });
  } catch {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }
};

const resolveNextBeforeMessageId = (messages: any[], limit: number): number | null => {
  if (!Array.isArray(messages) || messages.length < limit) return null;
  let minId = Number.POSITIVE_INFINITY;

  messages.forEach((message: any) => {
    const id = Number((message as any)?.id);
    if (Number.isFinite(id) && id > 0) {
      minId = Math.min(minId, Math.trunc(id));
    }
  });

  if (!Number.isFinite(minId) || minId <= 0) return null;
  return minId;
};

export const myChats = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    setNoCacheHeaders(res);
    const summary = isSummaryMode((req.query as any)?.summary);
    const locale = await resolveRequestLocale(req);

    const chats = summary
      ? await repository.getUserChatsSummary(req.userId, req.userId)
      : await repository.getUserChats(req.userId, req.userId);
    console.log(
      `[perf][myChats] userId=${req.userId} chats=${Array.isArray(chats) ? chats.length : 0} totalMs=${Date.now() - startedAt}`
    );

    const body = {
      chatsByUser: summary
        ? (chats ?? []).map((chat: any) => toChatSummary(chat, locale))
        : applyRelativeToLegacyChats(chats ?? [], locale),
    };
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

export const starredChats = async (req: Request, res: Response) => {
  try {
    setNoCacheHeaders(res);

    const limitRaw = req.query.limit;
    const limitParsed = parseInt(String(limitRaw ?? "20"), 10);
    const limit = Number.isFinite(limitParsed)
      ? Math.max(1, Math.min(limitParsed, 100))
      : 20;

    const beforePinnedAtRaw = String((req.query as any)?.beforePinnedAt ?? "").trim();
    const beforePinnedAt = beforePinnedAtRaw.length > 0 ? beforePinnedAtRaw : null;

    const beforeChatIdParsed = parseInt(String((req.query as any)?.beforeChatId ?? ""), 10);
    const beforeChatId = Number.isFinite(beforeChatIdParsed) ? beforeChatIdParsed : null;

    const response = await repository.getUserStarredChats({
      currentUserId: req.userId,
      meId: req.userId,
      limit,
      beforePinnedAt,
      beforeChatId,
    });

    return formatResponse({
      res,
      success: true,
      body: {
        chatsByUser: response.chats,
        paging: {
          limit,
          beforePinnedAt,
          beforeChatId,
          next_cursor: response.paging.nextCursor,
        },
      },
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
  const sortRaw = String((req.query as any)?.sort ?? "").toLowerCase();
  const sort: "asc" | "desc" = sortRaw === "desc" ? "desc" : "asc";
  const summary = isSummaryMode((req.query as any)?.summary);

  try {
    setNoCacheHeaders(res);
    const locale = await resolveRequestLocale(req);

    const messageRows = summary
      ? await repository.getChatByUserSummary(req.userId, id, {
          limit,
          beforeMessageId,
          sort,
        })
      : await repository.getChatByUser(req.userId, id, {
          limit,
          beforeMessageId,
          sort,
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

    const nextBeforeMessageId = resolveNextBeforeMessageId(messageRows as any[], limit);
    res.set(
      "X-Paging-Next-Before-Message-Id",
      nextBeforeMessageId == null ? "" : String(nextBeforeMessageId)
    );

    const payload = {
      chatId,
      messages: summary
        ? messageRows.map((message: any) => toChatMessageSummary(message, locale))
        : serializeMessagesToCanonical(messageRows, { includeLegacy: true, locale }),
      paging: {
        limit,
        beforeMessageId,
        sort,
        next_before_message_id: nextBeforeMessageId,
        nextBeforeMessageId,
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
