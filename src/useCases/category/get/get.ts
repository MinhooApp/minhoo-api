import { Request, Response, formatResponse, repository } from '../_module/module';


export const gets = async (req: Request, res: Response) => {

    try {
        const categories = await repository.gets();
        return formatResponse({ res: res, success: true, body: { categories } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}