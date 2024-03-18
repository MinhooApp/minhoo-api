import { Request, Response, formatResponse, repository } from '../_module/module';

export const workers = async (req: Request, res: Response) => {
    try {
        const { page = 0, size = 5 } = req.query;
        const workers: any = await repository.workers(page, size);
        return formatResponse({
            res: res, success: true, body: {

                page: +page,
                size: +size,
                count: workers.count,
                "workers": workers.rows
            }
        });
    } catch (error) {
        console.log(error)
        return formatResponse({ res: res, success: false, message: error });
    }

}


export const worker = async (req: Request, res: Response) => {
    const { id } = req.params;

    try {

        const worker: any = await repository.worker(id ?? req.userId);
        return formatResponse({
            res: res, success: true, body: {

                "worker": worker
            }
        });
    } catch (error) {
        console.log(error)
        return formatResponse({ res: res, success: false, message: error });
    }

}