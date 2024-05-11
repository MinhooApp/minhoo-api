import { Request, Response, formatResponse, repository } from '../_module/module';


////////////////////////Get all services//////////////////////
export const gets = async (req: Request, res: Response) => {
    try {
        const services = await repository.gets();
        return formatResponse({ res: res, success: true, body: { services } })
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error })
    }
}

////////////////////////Get my services actives//////////////////////
export const myonGoing = async (req: Request, res: Response) => {
    try {
        const services = await repository.onGoing(req.userId);
        return formatResponse({ res: res, success: true, body: { services } })
    } catch (error: any) {
        console.log(error.toString());
        return formatResponse({ res: res, success: false, message: error })
    }
}

export const onGoing = async (req: Request, res: Response) => {
    try {
        const services = await repository.onGoing();
        return formatResponse({ res: res, success: true, body: { services } })
    } catch (error: any) {
        console.log(error.toString());
        return formatResponse({ res: res, success: false, message: error })
    }
}
////////////////////////Get a service//////////////////////
export const get = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const service = await repository.get(id);

        return formatResponse({ res: res, success: true, body: { service } })
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error })
    }
}

export const myHistory = async (req: Request, res: Response) => {
    try {
        const services = await repository.history(req.userId);
        return formatResponse({ res: res, success: true, body: { services } })
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error })
    }
}
export const history = async (req: Request, res: Response) => {
    try {
        const services = await repository.history();
        return formatResponse({ res: res, success: true, body: { services } })
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error })
    }
}


