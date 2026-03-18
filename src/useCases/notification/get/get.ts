import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import { isSummaryMode, toNotificationSummary } from "../../../libs/summary_response";

export const myNotifications = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number((req.query as any)?.limit) || 20, 1), 20);
    const cursorRaw = (req.query as any)?.cursor;
    const cursor = cursorRaw ? Number(cursorRaw) : null;
    const summary = isSummaryMode((req.query as any)?.summary);
    const notifications = summary
      ? await repository.myNotificationsSummary(req.userId, { cursor, limit })
      : await repository.myNotifications(req.userId, { cursor, limit });
    const responseBody = summary
      ? (notifications ?? []).map((notification: any) => toNotificationSummary(notification))
      : notifications;
    const nextCursor =
      Array.isArray(notifications) && notifications.length === limit
        ? Number((notifications[notifications.length - 1] as any)?.id ?? 0) || null
        : null;

    setCacheControl(res, {
      visibility: "private",
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 60,
      staleIfErrorSeconds: 120,
    });
    res.set("X-Paging-Limit", String(limit));
    res.set("X-Paging-Cursor", cursor == null ? "" : String(cursor));
    res.set("X-Paging-Next-Cursor", nextCursor == null ? "" : String(nextCursor));
    if (respondNotModifiedIfFresh(req, res, responseBody)) return;

    return formatResponse({ res: res, success: true, body: responseBody });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
