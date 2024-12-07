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
  if (success) {
    return res.status(code ? code : 200).json({
      header: {
        success: success,
        authenticated: true,
        messages: [message],
      },
      body: body,
    });
  } else {
    {
      return res.status(code ? code : 409).json({
        header: {
          success: success,
          authenticated: false,
          messages: islogin
            ? [message]
            : ["Internal error, please consult the administrator", message],
        },
      });
    }
  }
}
