import { Request, Response, formatResponse, repository } from '../_module/module';


export const gets = async (req: Request, res: Response) => {

    try {
        const offers = await repository.gets();
        return formatResponse({ res: res, success: true, body: { "offers": offers } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}


export const getsByService = async (req: Request, res: Response) => {
    const { serviceId } = req.params;

    try {
        const offers = await repository.getsByService(serviceId);
        if (offers.length > 0 && offers[0].service.userId != req.userId) {
            return formatResponse({ res: res, success: true, body: { "offers": [] } });
        } else {
            return formatResponse({ res: res, success: true, body: { "offers": offers } });
        }
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}


export const get = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const offer = await repository.get(id);

        return formatResponse({ res: res, success: true, body: { "offer": offer } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}