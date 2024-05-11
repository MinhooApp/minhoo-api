import { worker } from 'repository/worker/worker_repository';
import { Request, Response, formatResponse, repository } from '../_module/module';


export const acceptWorker = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { workerId } = req.body;
    try {
        const tempService = await repository.get(id);
        const workers: any[] = tempService!.workers;
        const filteredWorkersActives = workers.filter(worker => {
            return worker.service_worker.removed == false;
        });

        if (tempService!.userId != req.userId) {
            return formatResponse({ res: res, success: false, message: "Service not found.", code: 400 });
        }
        if (filteredWorkersActives.length >= tempService!.places) {
            return formatResponse({ res: res, success: false, message: "The spaces available for service are complete.", code: 400 });
        }

        const assigned: boolean = filteredWorkersActives.length + 1 >= tempService!.places;
        await repository.assignWorker(workerId, tempService!, assigned);
        const service = await repository.get(id);
        return formatResponse({ res: res, success: true, body: service! });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }


}
export const update = async (reque: Request, res: Response) => { }