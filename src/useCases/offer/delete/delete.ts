import { Request, Response, formatResponse, repository, serviceRepository } from '../_module/module';

export const removeOffer = async (req: Request, res: Response) => {
    const { offerId } = req.params;
    try {
        const offer = await repository.get(offerId);
        if (offer == null) {
            return formatResponse({ res: res, success: false, message: "Offer not found.", code: 400 });
        }
        else {
            await serviceRepository.removeWorker(offer.serviceId, offer.workerId);
            await repository.update(offerId, { "accepted": false })
            const service = await serviceRepository.get(offer!.serviceId);
            return formatResponse({ res: res, success: true, body: { service } });
        }

    } catch (error) {
        console.log(error)
        return formatResponse({ res: res, success: false, message: error });
    }

}