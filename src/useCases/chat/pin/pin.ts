import { Request, Response, formatResponse, repository } from "../_module/module";
import { invalidateChatSummaryCacheByUser } from "../get/get";

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
  return updateChatStarState(req, res, "pin");
};

export const starChat = async (req: Request, res: Response) => {
  return updateChatStarState(req, res, "starred");
};

const updateChatStarState = async (
  req: Request,
  res: Response,
  source: "pin" | "starred"
) => {
  const chatId = Number(req.params.id);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return formatResponse({
      res,
      success: false,
      message: "Invalid chatId",
    });
  }

  const pinned = toBool(req.body?.pinned);
  const starred = toBool(req.body?.starred);
  const enabled = (source === "starred" ? starred : pinned) ?? starred ?? pinned ?? true;

  try {
    console.log("[chatStar] request", {
      userId: req.userId,
      chatId,
      enabled,
      body: req.body,
      source,
    });
    const row = await repository.setChatPinned({
      userId: req.userId,
      chatId,
      pinned: enabled,
    });

    if (!row) {
      return formatResponse({
        res,
        success: false,
        message: "Chat not found",
      });
    }

    console.log("[chatStar] updated", {
      userId: req.userId,
      chatId,
      pinnedAt: row.pinnedAt,
      source,
    });
    invalidateChatSummaryCacheByUser(req.userId);
    return formatResponse({
      res,
      success: true,
      body: {
        chatId,
        pinnedAt: row.pinnedAt,
        pinned: enabled,
        starred: enabled,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error as any });
  }
};
