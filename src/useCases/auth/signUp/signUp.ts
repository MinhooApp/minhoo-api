
import { formatResponse, repository, generatePassword, Request, Response, uploadFile, fs } from '../_module/module';




export const signup = async (req: Request, res: Response) => {

    var upload = uploadFile({
        route: "/uploads/images/user/profil",
        file: "image_profil",
        maxFiles: 1,
        is_img: true,
    });
    upload(req, res, async function (err) {
        var file: any = [];
        file = req.files;
        const roles: any = [];
        const { email, password } = req.body;
        const hashPassword = generatePassword(password as string);
        req.body.password = hashPassword;
        req.body.roles = [1];
        const validateEmail = await repository.findByEmail(email);

        if (validateEmail) {

            try {
                //Elimina el archivo despues de cargarlo, porque el usuario existe
                fs.unlink(file.image_profil[0].path, (err: any) => {
                    if (err) {
                        console.error(err);
                    }
                });
            } catch (error) {
                console.error(err);
            }
            return formatResponse({ res: res, success: false, code: 401, message: "The user already exists", islogin: true });
        }

        try {
            //Si existe el archivo, lo agrego al body
            if (file && file.image_profil) {
                req.body.image_profil = file.image_profil[0].path.replace("src\\public\\", "\\")

            }
            const userTemp: any = await repository.add(req.body);
            userTemp?.roles.forEach((u: any) => {
                roles.push(u.id);
            });

            //const user = await repository.saveToken(userTemp?.get("id"), roles);
            return formatResponse({ res: res, success: true, body: userTemp });
        } catch (error: any) {
            if (file.image_profil) {
                const filePath = file.image_profil[0].path;
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