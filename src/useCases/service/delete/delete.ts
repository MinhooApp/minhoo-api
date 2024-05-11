import { Request, Response, formatResponse, repository } from '../_module/module';
import { worker } from '../../../repository/worker/worker_repository';
export const deleteService = async (reque: Request, res: Response) => {

}

export const removeWorker = async (req: Request, res: Response) => {
    const { serviceId } = req.params;
    const { workerId } = req.body;
    try {

        const worker = await repository.removeWorker(serviceId, workerId)

        return formatResponse({ res: res, success: true, body: worker });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }

}