import { Request, Response, formatResponse, repository, bcryptjs } from '../_module/module';

export const login = async (req: Request, res: Response) => {
    try {

        const roles: any = [];//
        const { email, password } = req.body;
        //Validar Existencia de Usuario
        const userTemp = await repository.findByEmail(email);
        if (!userTemp) {
            console.log("🚫  User no found");
            return formatResponse({ islogin: true, res: res, success: false, message: "User and/or Password not valid." });
        }
        const validatePass = bcryptjs.compareSync(
            String(password),
            userTemp.password,
        );

        if (!validatePass) {
            return formatResponse({ islogin: true, res: res, success: false, message: "User and/or Password not valid." });
        } else {
            userTemp?.roles.forEach((u: any) => {
                roles.push(u.id);
            });

            const user = await repository.saveToken({ userId: userTemp?.get("id"), roles: roles, workerId: userTemp?.get("worker") != null ? userTemp?.get("worker")["id"] : null });


            return formatResponse({ res: res, success: true, body: { user } });
        }


    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}