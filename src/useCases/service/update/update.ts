import {
  socket,
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";

export const update = async (req: Request, res: Response) => {};

export const finalized = async (req: Request, res: Response) => {
  const serviceId = Number(req.params?.id);
  try {
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }

    const tempService = await repository.get(serviceId);
    if (!tempService) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }

    if (Number((tempService as any).userId) !== Number(req.userId)) {
      return formatResponse({
        res,
        success: false,
        message: "Forbidden. You can only finalize your own service.",
        code: 403,
      });
    }

    const finalizedResult: any = await repository.finalizedService(serviceId);
    if (finalizedResult?.notFound) {
      return formatResponse({
        res,
        success: false,
        message: "Service not found.",
        code: 404,
      });
    }
    if (finalizedResult?.invalidServiceId) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid service id.",
        code: 400,
      });
    }

    const responseBody = {
      id: Number(finalizedResult?.id ?? serviceId),
      status: String(finalizedResult?.status ?? "CANCELED"),
      acceptedCount: Number(finalizedResult?.acceptedCount ?? 0),
      closedAt: String(finalizedResult?.closedAt ?? new Date().toISOString()),
    };

    const refreshLists = [
      "myonGoing",
      "myHistory",
      "myHistoryCanceled",
      "onGoing/worker",
      "history/worker",
      "worker/canceled",
    ];

    socket.emit("offers", {
      action: "finalized",
      serviceId: responseBody.id,
      ownerUserId: Number(tempService?.userId ?? finalizedResult?.service?.userId ?? 0),
      refreshLists: ["onGoing/worker", "history/worker", "worker/canceled"],
      updatedAt: new Date().toISOString(),
    });

    const serviceForSocket =
      finalizedResult?.service && typeof finalizedResult.service.toJSON === "function"
        ? finalizedResult.service.toJSON()
        : finalizedResult?.service ?? null;

    socket.emit("services", {
      ...(serviceForSocket ?? {}),
      ...responseBody,
      refreshLists,
    });

    socket.emit("service/finalized", {
      ...responseBody,
      refreshLists,
    });

    await bumpHomeContentSectionVersion("services");

    return formatResponse({ res, success: true, body: responseBody });
  } catch (error) {
    console.log(error);
    return formatResponse({
      res,
      success: false,
      message: error,
      code: 400,
    });
  }
};
