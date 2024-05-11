import { Request, Response, formatResponse, repository, socket } from '../_module/module';

export const add = async (req: Request, res: Response) => {


    try {
        //
        const now = new Date(new Date().toUTCString())
        req.body.userId = req.userId;
        req.body.service_date = now;
        const service: any = await repository.add(req.body)


        ////////Emit the service/////
        socket.emit("services", service)

        return formatResponse({ res: res, success: true, body: service })
    } catch (error) {
        console.log(error)
        return formatResponse({ res: res, success: false, message: error })
    }
}



