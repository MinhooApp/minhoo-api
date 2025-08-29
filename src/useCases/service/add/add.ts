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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
export const add = async (req: Request, res: Response) => {
  try {
    const tokens: string[] = await sendNotificationByNewService(
      req.body.categoryId
    );

    //
    const now = new Date(new Date().toUTCString());
    req.body.userId = req.userId;
    req.body.service_date = now;
    const service: any = await repository.add(req.body);

    ////////Emit the service/////
    socket.emit("services", service);
    sendPushToMultipleUsers(
      "New Service Posted",
      "  ",
      "newService",
      service.id,
      tokens
    );
    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
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
    console.error(
      "Error en la solicitud de detalles del lugar:",
      error.message
    );
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

      // Obtener detalles para cada lugar
      const detailsPromises = predictions.map((prediction: any) =>
        getPlaceDetails(prediction.place_id)
      );

      const detailedResults = await Promise.all(detailsPromises);

      // Combinar las sugerencias con las coordenadas
      const results = predictions.map((prediction: any, index: number) => ({
        description: prediction.description,
        place_id: prediction.place_id,
        ...detailedResults[index], // Incluye las coordenadas si están disponibles
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

const sendNotificationByNewService = async (categoryId: number) => {
  const tokens: string[] = await workerRepository.tokensByNewService(
    categoryId
  );
  return tokens;
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
  } catch (error) {
    console.log(error);
  }
};
