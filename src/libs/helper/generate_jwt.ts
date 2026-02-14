import jsonwebtoken from "jsonwebtoken";
interface JWTOptions {

    userId: number | null;
    workerId?: number | null;
    name?: string;
    username?: string;
    roles?: number[];
}
const generarJWT = ({

    userId,
    workerId,
    name = "",
    username = "",
    roles = [] as number[],
}: JWTOptions) => {
    return new Promise((resolve, reject) => {
        const payload = {

            userId,
            workerId,
            name,
            username,
            roles,
        };

        const jwtSecret =
            (process.env.SECRETORPRIVATEKEY ?? "").trim() ||
            (process.env.JWT_SECRET ?? "").trim() ||
            "tokenTest";

        jsonwebtoken.sign(
            payload,
            jwtSecret,
            {
                expiresIn: "365d",
            },
            (err, token) => {
                if (err) {
                    console.log(err);
                    reject("🚫  No se puede generar el token" + err);
                } else {
                    resolve(token);
                }
            },
        );
    });
};

export default generarJWT;
