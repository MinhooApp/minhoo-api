import { Request, Response, formatResponse, repository, fb } from '../_module/module';


////////////////////////Get all services//////////////////////
export const gets = async (req: Request, res: Response) => {
    try {
        const services = await repository.gets();
        return formatResponse({ res: res, success: true, body: { "services": services } })
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error })
    }
}

////////////////////////Get my services actives//////////////////////
export const onGoing = async (req: Request, res: Response) => {
    try {
        const services = await repository.onGoing(req.userId);
        return formatResponse({ res: res, success: true, body: { "services": services } })
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
        await fb().collection("services").doc(service?.id.toString()).set({
            "service": service!.toJSON()
        });
        return formatResponse({ res: res, success: true, body: { "service": service } })
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error })
    }
}


