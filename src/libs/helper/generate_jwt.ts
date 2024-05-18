import jsonwebtoken from "jsonwebtoken";
const generarJWT = ({
    id = "",
    workerId = 0 as number,
    name = "",
    username = "",
    roles = [] as number[],
}) => {
    return new Promise((resolve, reject) => {
        const payload = {
            id,
            workerId,
            name,
            username,
            roles,
        };

        jsonwebtoken.sign(
            payload,
            process.env.SECRETORPRIVATEKEY || "",
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