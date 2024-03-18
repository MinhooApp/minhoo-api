

import { formatResponse, repository, generatePassword, Request, Response, uploadFile, fs, sendEmail } from '../_module/module';

const now: any = new Date(new Date().toUTCString())


export const signUpWithImage = async (req: Request, res: Response) => {

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
            sendEmail
            return formatResponse({ res: res, success: false, code: 401, message: "The user already exists", islogin: true });
        }

        try {
            //Si existe el archivo, lo agrego al body
            if (file && file.image_profil) {
                req.body.image_profil = file.image_profil[0].path.replace("src\\public\\", "\\")

            }

            const categories: [] = req.body.categories.split(',');
            req.body.categories = categories;
            const userTemp: any = await repository.add(req.body);

            userTemp?.roles.forEach((u: any) => {
                roles.push(u.id);
            });

            const user = await repository.saveToken(userTemp?.get("id"), roles);
            return formatResponse({ res: res, success: true, body: user });
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
export const signUp = async (req: Request, res: Response) => {

    const roles: any = [];
    const { email, password } = req.body;
    const hashPassword = generatePassword(password as string);
    req.body.password = hashPassword;
    req.body.roles = [1];
    const validateEmail = await repository.findByEmail(email);

    if (validateEmail) {


        return formatResponse({ res: res, success: false, code: 401, message: "The user already exists", islogin: true });
    }

    try {
        const userTemp = await repository.add(req.body);
        userTemp?.roles.forEach((u: any) => {
            roles.push(u.id);
        });
        const user = await repository.saveToken(userTemp?.get("id"), roles);
        return formatResponse({ res: res, success: true, body: { user } });
    } catch (error) {

    }
}

export const validateEmail = async (req: Request, res: Response) => {


    const { email, } = req.body;

    try {
        const validateEmail = await repository.findByEmail(email);

        if (validateEmail) {


            return formatResponse({ res: res, success: false, code: 401, message: "The email already exists" });
        } else {

            const send: any = await sendEmail("cto@minhoo.app", "./src/public/html/email/emailCode.html", 8088);
            if (send == true) {

                const body = {
                    "code": 8088,
                    "email": email,
                    "created": now


                };
                const code = await repository.registerCode(body);
                return formatResponse({ res: res, success: true, code: 200, body: body });
            } else {
                return formatResponse({ res: res, success: false, message: "" });
            }
        }
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }




}
export const verifyEmailCode = async (req: Request, res: Response) => {
    const { email, code } = req.body;
    try {
        const response = await repository.verifyEmailCode(email, code);
        if (response) {

            const storedDate: any = new Date(response.created);
            // Calcula la diferencia en milisegundos entre las dos fechas
            const differenceInMs = now - storedDate;
            // Convierte la diferencia de milisegundos a días
            const differenceInDays = Math.floor(differenceInMs / (1000 * 60 * 60 * 24));
            if (differenceInDays > 1) {
                return formatResponse({ res: res, success: false, message: "Expired code" });
            }
            signUp(req, res);
        } else {
            return formatResponse({ res: res, success: false, message: "Incorrect code" });
        }
    } catch (error) {
        return formatResponse({ res: res, success: false, message: error });
    }
}