import { Request, Response, formatResponse, repository, fs, uploadFile } from '../_module/module';
export const add = async (req: Request, res: Response) => {

    var upload = uploadFile({
        route: "/uploads/images/post/media",
        file: "image_post",
        maxFiles: 1,
        is_img: true,
    });
    upload(req, res, async function (err) {
        var file: any = [];
        file = req.files
        try {
            //Si existe el archivo, lo agrego al body
            if (file && file.image_post) {
                req.body.media_url = file.image_post[0].path.replace("src\\public\\", "\\")

            }
            req.body.userId = req.userId;
            const post = await repository.add(req.body);
            return formatResponse({ res: res, success: true, body: post });
        } catch (error: any) {
            if (file.image_post) {
                //Si existe el archivo, lo elimino
                const filePath = file.image_post[0].path;
                fs.unlink(filePath, (err: any) => {
                    if (err) {
                        console.error(err);
                    }
                });
            }
            return formatResponse({ res: res, success: false, message: error.errors[0].message });
        }


    });

};