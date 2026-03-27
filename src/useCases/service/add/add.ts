import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  axios,
  workerRepository,
  sendPushToMultipleUsers,
  sendNotification,
} from "../_module/module";
import { bumpHomeContentCacheVersion } from "../../../libs/cache/bootstrap_home_cache_version";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

type NewServicePushTarget = {
  token: string;
  language?: string | null;
  language_codes?: string[];
  language_names?: string[];
};

type PushLocale = "en" | "es";

function toPlain<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

function normalizeCurrency(body: any) {
  // acepta snake_case y camelCase
  const code = body.currencyCode ?? body.currency_code;
  const prefix = body.currencyPrefix ?? body.currency_prefix;

  // guarda en ambos para no romper nada
  if (code) {
    body.currencyCode = code;
    body.currency_code = code;
  }
  if (prefix) {
    body.currencyPrefix = prefix;
    body.currency_prefix = prefix;
  }

  // fallback legacy: si no mandan moneda, mantenemos compatibilidad (AU$)
  if (!body.currencyCode && !body.currency_code) {
    body.currencyCode = "AUD";
    body.currency_code = "AUD";
  }
  if (!body.currencyPrefix && !body.currency_prefix) {
    body.currencyPrefix = "AU$";
    body.currency_prefix = "AU$";
  }
}

const normalizePushLocale = (raw: any): PushLocale | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized.startsWith("es") ||
    normalized.includes("spanish") ||
    normalized.includes("espanol") ||
    normalized.includes("español")
  ) {
    return "es";
  }

  if (
    normalized.startsWith("en") ||
    normalized.includes("english") ||
    normalized.includes("ingles") ||
    normalized.includes("inglés")
  ) {
    return "en";
  }

  return null;
};

const firstDetectedLocale = (values: any[]): PushLocale | null => {
  for (const value of values) {
    const detected = normalizePushLocale(value);
    if (detected) return detected;
  }
  return null;
};

const resolveTargetLocale = (target: NewServicePushTarget): PushLocale => {
  const fromLanguage = normalizePushLocale(target?.language);
  if (fromLanguage) return fromLanguage;

  const fromCodes = firstDetectedLocale(Array.isArray(target?.language_codes) ? target.language_codes : []);
  if (fromCodes) return fromCodes;

  const fromNames = firstDetectedLocale(Array.isArray(target?.language_names) ? target.language_names : []);
  if (fromNames) return fromNames;

  return "en";
};

const localizeNewServiceTitle = (locale: PushLocale) =>
  locale === "es" ? "Nuevo servicio publicado" : "New Service Posted";

const sendNewServicePushByLocale = async (
  targets: NewServicePushTarget[],
  notificationId: number | string
) => {
  const grouped: Record<PushLocale, string[]> = { en: [], es: [] };

  for (const target of targets) {
    const token = String(target?.token ?? "").trim();
    if (!token) continue;
    const locale = resolveTargetLocale(target);
    grouped[locale].push(token);
  }

  const jobs: Promise<any>[] = [];
  if (grouped.es.length > 0) {
    jobs.push(
      sendPushToMultipleUsers(
        localizeNewServiceTitle("es"),
        "  ",
        "newService",
        notificationId,
        grouped.es
      )
    );
  }
  if (grouped.en.length > 0) {
    jobs.push(
      sendPushToMultipleUsers(
        localizeNewServiceTitle("en"),
        "  ",
        "newService",
        notificationId,
        grouped.en
      )
    );
  }

  if (jobs.length > 0) {
    await Promise.all(jobs);
  }
};

export const add = async (req: Request, res: Response) => {
  try {
    const pushTargets: NewServicePushTarget[] = await sendNotificationByNewService(
      req.body.categoryId,
      req.userId
    );

    const now = new Date(new Date().toUTCString());
    req.body.userId = req.userId;
    req.body.service_date = now;

    // ✅ moneda backward compatible
    normalizeCurrency(req.body);

    const service: any = await repository.add(req.body);
    await bumpHomeContentCacheVersion();

    // ✅ evita circular JSON
    const safeService = toPlain(service);

    socket.emit("services", safeService);
    void sendNewServicePushByLocale(pushTargets, safeService.id).catch((pushError) => {
      console.log("[service][newServicePush] skipped", pushError);
    });

    return formatResponse({ res: res, success: true, body: { service: safeService } });
  } catch (error: any) {
    console.log(error);
    // ojo: no devuelvas error crudo si tiene cosas no serializables
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};

const getPlaceDetails = async (place_id: string) => {
  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/place/details/json",
      {
        params: {
          place_id: place_id,
          key: GOOGLE_API_KEY,
        },
      }
    );

    if (response.data.status === "OK") {
      const result = response.data.result;
      return {
        formattedAddress: result.formatted_address,
        location: result.geometry.location,
      };
    } else {
      throw new Error("Error al obtener detalles del lugar");
    }
  } catch (error: any) {
    console.error("Error en la solicitud de detalles del lugar:", error.message);
    return null;
  }
};

export const searchAddress = async (req: Request, res: Response) => {
  const input = req.query.query as string;

  if (!input) {
    return formatResponse({
      res: res,
      success: false,
      message: "Entrada no proporcionada",
    });
  }

  try {
    const autocompleteResponse = await axios.get(
      "https://maps.googleapis.com/maps/api/place/autocomplete/json",
      {
        params: {
          input: input,
          key: GOOGLE_API_KEY,
        },
      }
    );

    if (autocompleteResponse.data.status === "OK") {
      const predictions = autocompleteResponse.data.predictions;

      const detailsPromises = predictions.map((prediction: any) =>
        getPlaceDetails(prediction.place_id)
      );

      const detailedResults = await Promise.all(detailsPromises);

      const results = predictions.map((prediction: any, index: number) => ({
        description: prediction.description,
        place_id: prediction.place_id,
        ...detailedResults[index],
      }));

      return formatResponse({
        res: res,
        success: true,
        body: { predictions: results },
      });
    } else {
      console.log(autocompleteResponse.data);
      return formatResponse({
        res: res,
        success: false,
        message: "Error al buscar direcciones",
      });
    }
  } catch (error: any) {
    console.error("Error en la solicitud a la API de Google:", error.message);
    return formatResponse({
      res: res,
      success: false,
      message: error.message,
    });
  }
};

const sendNotificationByNewService = async (categoryId: number, userId: any) => {
  const targets = await workerRepository.pushTargetsByNewService(
    categoryId,
    userId
  );
  return targets;
};

export const sendTestNotification = async (req: Request, res: Response) => {
  try {
    await sendNotification({
      userId: req.body.userid,
      interactorId: req.body.interactorId,
      serviceId: req.body.serviceId,
      postId: req.body.postId,
      type: req.body.type,
      message: req.body.message,
    });

    return formatResponse({
      res: res,
      success: true,
      body: { response: "ok" },
    });
  } catch (error: any) {
    console.log(error);
    return formatResponse({
      res: res,
      success: false,
      message: error?.message ?? String(error),
    });
  }
};
