import { Request, Response, formatResponse, repository } from '../_module/module';


////////////////////////Get all services//////////////////////
export const gets = async (req: Request, res: Response) => {
    try {
        const services = await repository.gets();
        return formatResponse({ res: res, success: true, body: { "services": services } })
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error })
    }
}

////////////////////////Get a service//////////////////////
export const get = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const services = await repository.get(id);
        return formatResponse({ res: res, success: true, body: { "services": services } })
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error })
    }
}


