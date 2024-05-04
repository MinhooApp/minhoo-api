import { add } from './../../../repository/auth/auth_repository';
import { Request, Response, formatResponse, repository, uRepository, fs, uploadFile, path } from '../_module/module';
const PUBLIC_FOLDER = path.join(__dirname, '../../../../src/public');
const PROFILE_IMAGE_FOLDER = path.join(PUBLIC_FOLDER, 'uploads/images/user/profile/');
export const update = async (req: Request, res: Response) => {

    var upload = uploadFile({
        route: "/uploads/images/user/profile",
        file: "image_profile",
        maxFiles: 1, // Cambiar según la cantidad máxima de archivos que quieres permitir
        is_img: true,
    });

    upload(req, res, async function (err) {
        var files: any = [];
        const mediaUrls: any = [];
        files = req.files
        var trash = "";
        var filePath = "";
        try {
            const worker = await repository.worker(req.userId)
            if (files && files.image_profile != null && files.image_profile.length > 0) {
                filePath = files.image_profile[0].path.replace("src\\public\\", "\\");
                mediaUrls.push(filePath);
                trash = PROFILE_IMAGE_FOLDER + req.body.delete;
                fs.unlink(trash, (err: any) => {
                    if (err) {
                        console.error(err);
                    }
                });
            }
            /////Body to update user data/////////////
            const bodyUser = {
                "name": req.body.name,
                "last_name": req.body.last_name,
                "dialing_code": "+" + req.body.dialing_code.replace("+", ""),
                "phone": req.body.phone,
                "image_profil": filePath
            }

            /////Body to update worker data/////////////
            var bodyWorker = {
                "planId": worker?.planId,
                "about": req.body.about,
                "categories": req.body.skills.split(',').map(Number),
                "userId": req.userId
            }
            //update user//
            await uRepository.update(req.userId, bodyUser)
            const user = await uRepository.get(req.userId)

            //update worker
            if (worker != null) {
                await repository.update(worker.id, bodyWorker);
            } else {
                bodyWorker.planId = 1,
                    await repository.add(bodyWorker);
            }


            return formatResponse({
                res: res, success: true, body: { user }

            });
        } catch (error) {
            if (files.length > 0) {
                console.log("ELIMINANDO");
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
            return formatResponse({ res: res, success: false, message: error });
        }
        /*try {
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
        }*/



    });
};
