import crypto from "crypto";
import { Request, Response, formatResponse, repository } from "../_module/module";

const toSessionKey = (req: Request) => {
  const bodyKey = String((req.body as any)?.session_key ?? (req.body as any)?.sessionKey ?? "").trim();
  const queryKey = String((req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? "").trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = bodyKey || queryKey || headerKey;
  if (explicit) return explicit.slice(0, 128);

  const ip = String(req.ip ?? "").trim();
  const ua = String(req.header("user-agent") ?? "").trim();
  if (!ip && !ua) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${ua}`)
    .digest("hex")
    .slice(0, 40);
};

export const toggle_reel_star = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.toggleStar(req.userId, id);

    if (result.notFound) {
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
        reelId: Number(id),
        starred: result.starred,
        liked: result.starred,
        likes_count: result.likes_count,
        likesCount: result.likes_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const save_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.saveReel(req.userId, id);

    if (result.notFound) {
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
        reelId: Number(id),
        saved: true,
        created: result.created,
        saves_count: result.saves_count,
        savesCount: result.saves_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const unsave_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.unsaveReel(req.userId, id);

    if (result.notFound) {
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
        reelId: Number(id),
        saved: false,
        removed: result.removed,
        saves_count: result.saves_count,
        savesCount: result.saves_count,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const record_reel_view = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionKey = toSessionKey(req);

    const result = await repository.recordView(id, (req as any).userId, sessionKey);

    if (!result.found) {
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
        reelId: Number(id),
        counted: result.counted,
        views_count: Number((result.reel as any)?.views_count ?? 0),
        viewsCount: Number((result.reel as any)?.views_count ?? 0),
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const share_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.shareReel(id, (req as any).userId);

    if (!result.found) {
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
        reelId: Number(id),
        shares_count: Number((result.reel as any)?.shares_count ?? 0),
        sharesCount: Number((result.reel as any)?.shares_count ?? 0),
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
