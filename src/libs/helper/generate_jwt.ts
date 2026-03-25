import jsonwebtoken from "jsonwebtoken";
interface JWTOptions {

    userId: number | null;
    workerId?: number | null;
    name?: string;
    username?: string;
    roles?: number[];
    tokenType?: "access" | "refresh";
    expiresIn?: string | number;
}
const getUniqueSecrets = (values: any[]): string[] => {
    return Array.from(
        new Set(
            values
                .map((value) => String(value ?? "").trim())
                .filter(Boolean)
        )
    );
};

const parseTruthy = (value: any): boolean => {
    const normalized = String(value ?? "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

export const getAccessJwtSecrets = (): string[] => {
    return getUniqueSecrets([
        process.env.SECRETORPRIVATEKEY,
        process.env.JWT_SECRET,
    ]);
};

export const getRefreshJwtSecrets = (): string[] => {
    const allowFallbackToAccessSecret = parseTruthy(
        process.env.JWT_REFRESH_ALLOW_ACCESS_SECRET ?? "0"
    );
    const refreshSecrets = getUniqueSecrets([
        process.env.JWT_REFRESH_SECRET,
    ]);
    if (!allowFallbackToAccessSecret) return refreshSecrets;
    return getUniqueSecrets([...refreshSecrets, ...getAccessJwtSecrets()]);
};

const resolveAccessExpiresIn = (): string | number => {
    const configured = String(
        process.env.JWT_ACCESS_EXPIRES_IN ??
        process.env.JWT_EXPIRES_IN ??
        "20m"
    ).trim();
    return configured || "20m";
};

const resolveRefreshExpiresIn = (): string | number => {
    const configured = String(process.env.JWT_REFRESH_EXPIRES_IN ?? "45d").trim();
    return configured || "45d";
};

const signToken = (
    payload: Record<string, any>,
    secret: string,
    expiresIn: string | number
) =>
    new Promise<string>((resolve, reject) => {
        jsonwebtoken.sign(
            payload,
            secret,
            { expiresIn: expiresIn as any },
            (err, token) => {
                if (err || !token) {
                    reject("🚫  No se puede generar el token" + err);
                } else {
                    resolve(token);
                }
            }
        );
    });

const generarJWT = ({

    userId,
    workerId,
    name = "",
    username = "",
    roles = [] as number[],
    tokenType = "access",
    expiresIn,
}: JWTOptions) => {
    return new Promise((resolve, reject) => {
        const payload = {

            userId,
            workerId,
            name,
            username,
            roles,
            tokenType,
        };

        const secrets = tokenType === "refresh"
            ? getRefreshJwtSecrets()
            : getAccessJwtSecrets();
        const jwtSecret = secrets[0] ?? "";
        const effectiveExpiresIn =
            expiresIn ??
            (tokenType === "refresh" ? resolveRefreshExpiresIn() : resolveAccessExpiresIn());

        if (!jwtSecret) {
            reject("🚫  No se puede generar el token: JWT secret is not configured");
            return;
        }

        signToken(payload, jwtSecret, effectiveExpiresIn)
            .then((token) => resolve(token))
            .catch((error) => {
                console.log(error);
                reject(error);
            });
    });
};

export const generarRefreshJWT = (options: Omit<JWTOptions, "tokenType" | "expiresIn"> & { expiresIn?: string | number }) => {
    return generarJWT({
        ...options,
        tokenType: "refresh",
        expiresIn: options.expiresIn ?? resolveRefreshExpiresIn(),
    });
};

export default generarJWT;
