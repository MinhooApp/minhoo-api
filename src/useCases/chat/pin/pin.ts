import { Request, Response, formatResponse, repository } from "../_module/module";

const toBool = (v: any): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const val = v.trim().toLowerCase();
    if (val === "true") return true;
    if (val === "false") return false;
  }
  return null;
};

export const pinChat = async (req: Request, res: Response) => {
  const chatId = Number(req.params.id);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return formatResponse({
      res,
      success: false,
      message: "Invalid chatId",
    });
  }

  const pinned = toBool(req.body?.pinned) ?? true;

  try {
    console.log("[pinChat] request", {
      userId: req.userId,
      chatId,
      pinned,
      body: req.body,
    });
    const row = await repository.setChatPinned({
      userId: req.userId,
      chatId,
      pinned,
    });

    if (!row) {
      return formatResponse({
        res,
        success: false,
        message: "Chat not found",
      });
    }

    console.log("[pinChat] updated", {
      userId: req.userId,
      chatId,
      pinnedAt: row.pinnedAt,
    });
    return formatResponse({
      res,
      success: true,
      body: { chatId, pinnedAt: row.pinnedAt, pinned },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error as any });
  }
};
