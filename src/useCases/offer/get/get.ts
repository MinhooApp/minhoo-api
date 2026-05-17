import { Request, Response, formatResponse, repository } from '../_module/module';
import logger from "../../../libs/logger/logger";

const enrichOfferUiFlags = (offerRaw: any) => {
    const offer = offerRaw ?? {};
    const accepted = Boolean(offer.accepted);
    const canceled = Boolean(offer.canceled);
    const removed = Boolean(offer.removed);

    const workerCanceledOffer = !accepted && canceled && !removed;
    const clientRemovedOffer = removed && !canceled;
    const clientInteractionEnabled = accepted && !canceled && !removed;
    const clientCardDisabled = !clientInteractionEnabled;
    const clientDisableReason = workerCanceledOffer
        ? "worker_canceled"
        : clientRemovedOffer
        ? "client_removed"
        : canceled
        ? "canceled"
        : removed
        ? "removed"
        : "inactive";

    offer.client_can_open = clientInteractionEnabled;
    offer.clientCanOpen = clientInteractionEnabled;
    offer.client_interaction_enabled = clientInteractionEnabled;
    offer.clientInteractionEnabled = clientInteractionEnabled;
    offer.client_card_disabled = clientCardDisabled;
    offer.clientCardDisabled = clientCardDisabled;
    offer.client_disable_reason = clientDisableReason;
    offer.clientDisableReason = clientDisableReason;
    offer.client_can_rate = accepted && !canceled && !removed;
    offer.clientCanRate = accepted && !canceled && !removed;
    offer.worker_canceled = workerCanceledOffer;
    offer.workerCanceled = workerCanceledOffer;

    return offer;
}

export const gets = async (req: Request, res: Response) => {

    try {
        const offersRaw = await repository.gets((req as any)?.workerId, (req as any)?.userId);
        const offers = (Array.isArray(offersRaw) ? offersRaw : []).map(enrichOfferUiFlags);
        return formatResponse({ res: res, success: true, body: { "offers": offers } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}


export const getsByService = async (req: Request, res: Response) => {
    const { serviceId } = req.params;

    try {
        const offersRaw = await repository.getsByService(serviceId);
        const offers = (Array.isArray(offersRaw) ? offersRaw : []).map(enrichOfferUiFlags);

        if (offers.length > 0 && offers[0].service.userId != req.userId) {
            return formatResponse({ res: res, success: true, body: { "offers": [] } });
        } else {
            return formatResponse({ res: res, success: true, body: { "offers": offers } });
        }
    } catch (error) {
        logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
        return formatResponse({ res: res, success: false, message: error });
    }
}


export const get = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const offerRaw = await repository.get(id);
        const offer = offerRaw ? enrichOfferUiFlags(offerRaw) : offerRaw;

        return formatResponse({ res: res, success: true, body: { "offer": offer } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}
