import { Request, Response, formatResponse, repository } from '../_module/module';
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";


export const gets = async (req: Request, res: Response) => {

    try {
        const categories = await repository.gets();
        const payload = { categories };
        setCacheControl(res, {
            visibility: "public",
            maxAgeSeconds: 3600,
            staleWhileRevalidateSeconds: 86400,
            staleIfErrorSeconds: 86400,
        });
        if (respondNotModifiedIfFresh(req, res, payload)) return;
        return formatResponse({ res: res, success: true, body: payload });
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}
