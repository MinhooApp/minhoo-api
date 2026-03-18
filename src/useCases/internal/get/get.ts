import { axios, Request, Response, formatResponse } from "../_module/module";

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round2 = (value: number) => Math.round(value * 100) / 100;
const isTruthy = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};
const reductionPercent = (legacy: number, current: number) => {
  if (!Number.isFinite(legacy) || legacy <= 0) return null;
  return round2(((legacy - current) / legacy) * 100);
};
const toByteLength = (value: any): number => {
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value));
};
const getInternalBaseUrl = (req: Request) => {
  const localPort = Number((req.socket as any)?.localPort);
  if (Number.isFinite(localPort) && localPort > 0) {
    return `http://127.0.0.1:${localPort}/api/v1`;
  }

  const host = String(req.get("host") ?? "").trim();
  if (host) {
    const protocol = req.protocol || "http";
    return `${protocol}://${host}/api/v1`;
  }

  const fallbackPort = Number(process.env.PORT ?? 3000) || 3000;
  return `http://127.0.0.1:${fallbackPort}/api/v1`;
};

type ProbeResult = {
  status: number;
  response_size_bytes: number;
  response_time_ms: number;
  ok: boolean;
  error?: string;
};

const probe = async (
  baseUrl: string,
  endpoint: string,
  headers: Record<string, string>
): Promise<ProbeResult> => {
  const startedAt = nowMs();
  try {
    const response = await axios.get(`${baseUrl}${endpoint}`, {
      headers,
      responseType: "arraybuffer",
      timeout: 15_000,
      validateStatus: () => true,
    });
    const headerSize = Number(response.headers?.["content-length"] ?? 0);
    const responseSize =
      Number.isFinite(headerSize) && headerSize > 0
        ? headerSize
        : toByteLength(response.data);

    return {
      status: Number(response.status) || 0,
      response_size_bytes: responseSize,
      response_time_ms: round2(nowMs() - startedAt),
      ok: response.status >= 200 && response.status < 300,
    };
  } catch (error: any) {
    return {
      status: Number(error?.response?.status ?? 0) || 0,
      response_size_bytes: 0,
      response_time_ms: round2(nowMs() - startedAt),
      ok: false,
      error: String(error?.message ?? error),
    };
  }
};

const SUMMARY_ROUTES = [
  "/post",
  "/post/suggested",
  "/reel",
  "/reel/suggested",
  "/service",
  "/service/onGoing",
  "/notification",
  "/chat",
  "/chat/message/:id",
  "/user/followers/:id?",
  "/user/follows/:id?",
];

export const debugSummaryRoutes = async (_req: Request, res: Response) => {
  return formatResponse({
    res,
    success: true,
    body: {
      summary_routes: SUMMARY_ROUTES,
    },
  });
};

export const perfCheck = async (req: Request, res: Response) => {
  try {
    const baseUrl = getInternalBaseUrl(req);
    const headers: Record<string, string> = {};
    const authHeader = String(req.header("authorization") ?? "").trim();
    const sessionKey = String(req.header("x-session-key") ?? "").trim();

    if (authHeader) headers.authorization = authHeader;
    if (sessionKey) headers["x-session-key"] = sessionKey;
    // Helps internal calls if production guard is active in the same process.
    headers["x-internal-debug"] = isTruthy(req.header("x-internal-debug"))
      ? "true"
      : String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production"
      ? "true"
      : "false";

    const [postLegacy, postSummary, reelLegacy, reelSummary, chatLegacy, chatSummary] =
      await Promise.all([
        probe(baseUrl, "/post?size=20", headers),
        probe(baseUrl, "/post?summary=1&size=20", headers),
        probe(baseUrl, "/reel?size=20", headers),
        probe(baseUrl, "/reel?summary=1&size=20", headers),
        probe(baseUrl, "/chat", headers),
        probe(baseUrl, "/chat?summary=1", headers),
      ]);

    return formatResponse({
      res,
      success: true,
      body: {
        post: {
          legacy_bytes: postLegacy.response_size_bytes,
          summary_bytes: postSummary.response_size_bytes,
          legacy_time_ms: postLegacy.response_time_ms,
          summary_time_ms: postSummary.response_time_ms,
          legacy_status: postLegacy.status,
          summary_status: postSummary.status,
          payload_reduction_percent: reductionPercent(
            postLegacy.response_size_bytes,
            postSummary.response_size_bytes
          ),
          time_reduction_percent: reductionPercent(
            postLegacy.response_time_ms,
            postSummary.response_time_ms
          ),
        },
        reel: {
          legacy_bytes: reelLegacy.response_size_bytes,
          summary_bytes: reelSummary.response_size_bytes,
          legacy_time_ms: reelLegacy.response_time_ms,
          summary_time_ms: reelSummary.response_time_ms,
          legacy_status: reelLegacy.status,
          summary_status: reelSummary.status,
          payload_reduction_percent: reductionPercent(
            reelLegacy.response_size_bytes,
            reelSummary.response_size_bytes
          ),
          time_reduction_percent: reductionPercent(
            reelLegacy.response_time_ms,
            reelSummary.response_time_ms
          ),
        },
        chat: {
          legacy_bytes: chatLegacy.response_size_bytes,
          summary_bytes: chatSummary.response_size_bytes,
          legacy_time_ms: chatLegacy.response_time_ms,
          summary_time_ms: chatSummary.response_time_ms,
          legacy_status: chatLegacy.status,
          summary_status: chatSummary.status,
          payload_reduction_percent: reductionPercent(
            chatLegacy.response_size_bytes,
            chatSummary.response_size_bytes
          ),
          time_reduction_percent: reductionPercent(
            chatLegacy.response_time_ms,
            chatSummary.response_time_ms
          ),
        },
        meta: {
          base_url: baseUrl,
          chat_requires_auth: !authHeader,
        },
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
