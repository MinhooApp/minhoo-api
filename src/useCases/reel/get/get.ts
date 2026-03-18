import { Request, Response, formatResponse, repository } from "../_module/module";
import crypto from "crypto";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;

const toSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = queryKey || headerKey;
  if (explicit) return explicit.slice(0, 128);

  const viewerId = Number((req as any)?.userId ?? 0);
  if (Number.isFinite(viewerId) && viewerId > 0) return `u:${viewerId}`;

  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  if (!ip && !userAgent) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 40);
};

export const reels_feed = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listFeed(page, size, (req as any).userId, false, {
      sessionKey: toSessionKey(req),
    });
    if (shouldLogFindProfile()) {
      console.log(
        `[find/orbit/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/reel",
          page: Number(page) || 0,
          size: Number(size) || 15,
          viewerId: Number((req as any).userId ?? 0) || null,
          totalCount: Number(data?.count ?? 0),
          served: Array.isArray(data?.rows) ? data.rows.length : 0,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_suggested = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listFeed(page, size, (req as any).userId, true, {
      sessionKey: toSessionKey(req),
    });
    if (shouldLogFindProfile()) {
      console.log(
        `[find/orbit/endpoint] ${JSON.stringify({
          endpoint: "/api/v1/reel/suggested",
          page: Number(page) || 0,
          size: Number(size) || 15,
          viewerId: Number((req as any).userId ?? 0) || null,
          totalCount: Number(data?.count ?? 0),
          served: Array.isArray(data?.rows) ? data.rows.length : 0,
          totalLatencyMs: round3(nowMs() - startedAtMs),
        })}`
      );
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const my_reels = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listMine(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const user_reels = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listByUser(id, page, size, (req as any).userId);

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_saved = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listSaved(req.userId, page, size);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_by_id = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reel = await repository.getById(id, (req as any).userId);

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { reel },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_comments = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = 0, size = 20 } = req.query as any;
    const data = await repository.listComments(id, page, size);

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        comments: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_download = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reel = await repository.getById(id, (req as any).userId);

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const isOwner = Number((reel as any).userId) === Number((req as any).userId || 0);
    if (!(reel as any).allow_download && !isOwner) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "download not allowed",
      });
    }

    const downloadUrl = repository.getDownloadUrl(reel);
    if (!downloadUrl) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "download url not available",
      });
    }

    const shouldRedirect = String((req.query as any)?.redirect ?? "0") === "1";
    if (shouldRedirect) {
      return res.redirect(downloadUrl);
    }

    return formatResponse({
      res,
      success: true,
      body: {
        reelId: Number((reel as any).id),
        download_url: downloadUrl,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
