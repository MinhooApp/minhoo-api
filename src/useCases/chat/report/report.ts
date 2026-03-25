import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

const ALLOWED_REPORT_REASONS = new Set([
  "impersonation_or_identity_fraud",
  "nudity_or_sexual_content",
  "false_or_misleading_information",
  "scam_or_suspicious_behavior",
  "something_else",
]);

const normalizeReportReason = (value: any): string => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .slice(0, 120);
  if (!raw) return "something_else";
  return ALLOWED_REPORT_REASONS.has(raw) ? raw : "something_else";
};

const toNullablePositiveInt = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

export const report = async (req: Request, res: Response) => {
  try {
    const chatId = Number(req.params?.id);
    if (!Number.isFinite(chatId) || chatId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "invalid chat id",
      });
    }

    const reporterId = Number(req.userId);
    if (!Number.isFinite(reporterId) || reporterId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "unauthorized",
      });
    }

    const reason = normalizeReportReason((req.body as any)?.reason);
    const details = String((req.body as any)?.details ?? "").trim().slice(0, 4000);
    const messageId = toNullablePositiveInt(
      (req.body as any)?.messageId ?? (req.body as any)?.message_id ?? (req.query as any)?.messageId
    );

    const reportResult: any = await repository.reportChat({
      chatIdRaw: chatId,
      reporterIdRaw: reporterId,
      reason,
      details: details || null,
      messageIdRaw: messageId,
    });

    if (reportResult?.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "chat not found",
      });
    }

    if (reportResult?.invalidReporter) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "unauthorized",
      });
    }

    if (reportResult?.forbidden) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you are not part of this chat",
      });
    }

    if (reportResult?.messageNotFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "message not found in this chat",
      });
    }

    if (reportResult?.selfReport) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "you cannot report your own message",
      });
    }

    if (reportResult?.storageMissing) {
      return formatResponse({
        res,
        success: false,
        code: 503,
        message: "reports storage is not ready yet. run migrations first",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        chatId,
        message_id: messageId,
        messageId,
        reason,
        already_reported: Boolean(reportResult?.alreadyReported),
        alreadyReported: Boolean(reportResult?.alreadyReported),
        reports_count: Number(reportResult?.reportsCount ?? 0),
        reportsCount: Number(reportResult?.reportsCount ?? 0),
        auto_action_executed: false,
        autoActionExecuted: false,
      },
      message: reportResult?.alreadyReported
        ? "Report already submitted by this user."
        : "Chat report submitted successfully for admin review.",
    });
  } catch (error) {
    return formatResponse({
      res,
      success: false,
      message: error,
    });
  }
};
