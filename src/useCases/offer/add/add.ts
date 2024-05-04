import { Request, Response, formatResponse, repository, fb } from '../_module/module';


export const add = async (req: Request, res: Response) => {

    try {
        const body = req.body;
        body.userId = req.userId
        const offer = await repository.add(body);
        const response = await repository.get(offer.id);
        await fb().collection("offers").doc(offer.id.toString()).set({
            "offer": response!.toJSON()
        });

        return formatResponse({ res: res, success: true, body: { "offer": response } });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}