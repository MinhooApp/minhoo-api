import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

////////////////////////Get all services//////////////////////
export const gets = async (req: Request, res: Response) => {
  try {
    const services = await repository.gets();
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

////////////////////////Get my services actives//////////////////////
export const myonGoing = async (req: Request, res: Response) => {
  try {
    const services = await repository.onGoing(req.userId);
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const onGoing = async (req: Request, res: Response) => {
  try {
    const services = await repository.onGoing(req.userId);
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const getsOnGoing = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 10 } = req.query;
    const services = await repository.getsOnGoing(page, size, req.userId);
    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: services.count,
        services: services.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const onGoingWorkers = async (req: Request, res: Response) => {
  try {
    const services = await repository.onGoingWorkers(req.workerId, req.userId);
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const onGoingCanceledWorkers = async (req: Request, res: Response) => {
  try {
    const services = await repository.onGoingCanceledWorkers(
      req.workerId,
      req.userId
    );
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const historyWorkers = async (req: Request, res: Response) => {
  try {
    const services = await repository.historyWorkers(req.workerId, req.userId);
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error: any) {
    console.log(error.toString());
    return formatResponse({ res: res, success: false, message: error });
  }
};
////////////////////////Get a service//////////////////////
export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const service = await repository.get(id);

    return formatResponse({ res: res, success: true, body: { service } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const myHistory = async (req: Request, res: Response) => {
  try {
    const services = await repository.history(req.userId);
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const history = async (req: Request, res: Response) => {
  try {
    const services = await repository.history();
    return formatResponse({ res: res, success: true, body: { services } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
