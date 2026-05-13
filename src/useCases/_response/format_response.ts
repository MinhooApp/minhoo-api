import { Response } from "express";
interface parameters {
  res: Response;
  success: boolean;
  body?: any;
  message?: any;
  islogin?: boolean;
  code?: number;
}

export function formatResponse({
  res,
  success,
  body,
  message = "no incidents",
  islogin = false,
  code,
}: parameters) {
  const reqAny: any = (res as any)?.req ?? {};
  const userId = Number(reqAny?.userId ?? 0);
  const isAuthenticated =
    Boolean(reqAny?.authenticated) || (Number.isFinite(userId) && userId > 0);

  if (success) {
    return res.status(code ? code : 200).json({
      header: {
        success: success,
        authenticated: isAuthenticated,
        messages: [message],
      },
      body: body,
    });
  } else {
    {
      return res.status(code ? code : 409).json({
        header: {
          success: success,
          authenticated: isAuthenticated,
          message: message,
          messages: islogin
            ? [message]
            : ["Internal error, please consult the administrator", message],
        },
        body: body ?? null,
        message: message,
      });
    }
  }
}
