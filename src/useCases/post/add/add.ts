import { Request, Response, formatResponse, repository, fs, uploadFile } from '../_module/module';

export const add = async (req: Request, res: Response) => {

    var upload = uploadFile({
        route: "/uploads/post",
        file: "image_post",
        maxFiles: 5, // Cambiar según la cantidad máxima de archivos que quieres permitir
        is_img: true,
    });

    upload(req, res, async function (err) {
        var files: any = [];
        const mediaUrls: any = [];
        files = req.files
        try {
            if (files && files.image_post != null && files.image_post.length > 0) {
                const now = new Date(new Date().toUTCString());
                req.body.created_date = now;



                // Iterar sobre cada archivo subido para obtener las URLs
                for (let i = 0; i < files.image_post.length; i++) {
                    const filePath = files.image_post[i].path.replace("src\\public\\", "\\");
                    mediaUrls.push(filePath);
                }

                req.body.media_url = mediaUrls; // Guardar array de URLs en req.body.media_url
            }

            req.body.userId = req.userId;
            const now = new Date(new Date().toUTCString());
            req.body.created_date = now;

            const post = await repository.add(req.body);
            return formatResponse({ res: res, success: true, body: post });
        } catch (error: any) {
            if (files.length > 0) {
                // Eliminar los archivos si hay algún error
                for (let i = 0; i < files.length; i++) {
                    const filePath = files[i].path;
                    fs.unlink(filePath, (err: any) => {
                        if (err) {
                            console.error(err);
                        }
                    });
                }
            }
            return formatResponse({ res: res, success: false, message: error.errors[0].message });
        }
    });
};
