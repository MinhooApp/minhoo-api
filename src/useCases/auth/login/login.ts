import {
  Request,
  Response,
  formatResponse,
  repository,
  bcryptjs,
  generatePassword,
  uRepository,
  sendEmail,
} from "../_module/module";

export const login = async (req: Request, res: Response) => {
  try {
    const roles: any = []; //
    const { email, password, uuid } = req.body;
    //Validar Existencia de Usuario
    const userTemp = await repository.findByEmail(email);
    if (!userTemp) {
      console.log("🚫  User no found");
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }
    if ((userTemp as any).is_deleted === true || (userTemp as any).is_deleted === 1) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        code: 403,
        message:
          "Your account has been deleted. Please contact info@minhoo.app to reactivate your account.",
      });
    }
    const validatePass = bcryptjs.compareSync(
      String(password),
      userTemp.password
    );

    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    } else {
      userTemp?.roles.forEach((u: any) => {
        roles.push(u.id);
      });

      const user = await repository.saveToken({
        userId: userTemp?.get("id"),
        uuid,
        roles: roles,
        workerId:
          userTemp?.get("worker") != null
            ? userTemp?.get("worker")["id"]
            : null,
      });

      return formatResponse({ res: res, success: true, body: { user } });
    }
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const changePass = async (req: Request, res: Response) => {
  try {
    const { current_password, password, confirm_password } = req.body;
    //Validar Existencia de Usuario
    const userTemp = await repository.findById(req.userId);

    const validatePass = bcryptjs.compareSync(
      String(current_password),
      userTemp?.password
    );
    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Current password not valid.",
      });
    }
    if (password !== confirm_password) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Password and password confirmation do not match",
      });
    }
    const hashPassword = generatePassword(password as string);
    req.body.password = hashPassword;
    const body = {
      password: hashPassword,
      temp_code: null,
      created_temp_code: null,
    };
    await uRepository.update(userTemp?.id, body);
    const emailParams = {
      subject: "reset password",
      email: userTemp!.email,
      htmlPath: "./src/public/html/email/successful_password_change_email.html",
      replacements: [{ name: userTemp!.name }],
      from: "Minhoo App",
    };

    sendEmail(emailParams);
    return formatResponse({ res: res, success: true });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const validateSesion = async (req: Request, res: Response) => {
  try {
    return formatResponse({ res: res, success: true });
  } catch (error) {}
};
//
