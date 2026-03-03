import { Request, Response, formatResponse, repository } from "../_module/module";

export const reels_feed = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listFeed(page, size, (req as any).userId, false);

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
    const { page = 0, size = 15 } = req.query as any;
    const data = await repository.listFeed(page, size, (req as any).userId, true);

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
