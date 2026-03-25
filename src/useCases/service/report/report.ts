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

export const report = async (req: Request, res: Response) => {
  try {
    const serviceId = Number(req.params?.id);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "invalid service id",
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

    const reportResult = await repository.reportService({
      serviceIdRaw: serviceId,
      reporterIdRaw: reporterId,
      reason,
      details: details || null,
    });

    if (reportResult?.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "service not found",
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

    if (reportResult?.selfReport) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "you cannot report your own service",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        serviceId,
        reason,
        already_reported: Boolean(reportResult?.alreadyReported),
        alreadyReported: Boolean(reportResult?.alreadyReported),
        reports_count: Number(reportResult?.reportsCount ?? 0),
        reportsCount: Number(reportResult?.reportsCount ?? 0),
        auto_deleted: Boolean(reportResult?.autoDeleted),
        autoDeleted: Boolean(reportResult?.autoDeleted),
        threshold: Number(reportResult?.threshold ?? 20),
      },
      message: reportResult?.autoDeleted
        ? "Service removed automatically due to multiple reports."
        : reportResult?.alreadyReported
        ? "Report already submitted by this user."
        : "Report submitted successfully.",
    });
  } catch (error) {
    return formatResponse({
      res,
      success: false,
      message: error,
    });
  }
};
