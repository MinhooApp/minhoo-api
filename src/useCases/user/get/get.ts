import { Request, Response, formatResponse, repository } from '../_module/module';


export const gets = async (req: Request, res: Response) => {

    try {
        const { page = 0, size = 5 } = req.query;
        const users: any = await repository.users(page, size);
        return formatResponse({
            res: res, success: true, body: {

                page: +page,
                size: +size,
                count: users.count,
                "users": users.rows
            }
        })
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }

}

export const get = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const user = await repository.get(id ?? req.userId);
        return formatResponse({ res: res, success: true, body: { user: user } });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }

}