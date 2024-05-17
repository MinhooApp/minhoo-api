
import { Request, Response, formatResponse, repository, socket } from '../_module/module';



export const add = async (req: Request, res: Response) => {

    try {
        const body = req.body;
        body.workerId = req.workerId
        const now = new Date(new Date().toUTCString())
        req.body.offer_date = now;
        const offer = await repository.add(body);
        const response = await repository.get(offer.id);

        socket.emit("offers", offer)
        return formatResponse({ res: res, success: true, body: { "offer": response } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}