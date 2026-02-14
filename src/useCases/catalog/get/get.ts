import { Request, Response, formatResponse, readJsonFile } from "../_module/module";

const languagesPath = "_data/catalog/languages.json";
const countriesPath = "_data/catalog/countries.json";
const statesPath = "_data/catalog/states.json";
const citiesPath = "_data/catalog/cities.json";

export const languages = async (_req: Request, res: Response) => {
  try {
    const languages = readJsonFile(languagesPath);
    return formatResponse({
      res,
      success: true,
      message: "ok",
      body: { languages },
    });
  } catch (error) {
    console.error(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const countries = async (_req: Request, res: Response) => {
  try {
    const countries = readJsonFile(countriesPath);
    return formatResponse({
      res,
      success: true,
      message: "ok",
      body: { countries },
    });
  } catch (error) {
    console.error(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const states = async (req: Request, res: Response) => {
  try {
    const raw = (req.query as any)?.country_id;
    const countryId = raw ? Number(raw) : null;
    const states = readJsonFile(statesPath);
    const filtered =
      countryId && Number.isFinite(countryId)
        ? states.filter((s: any) => Number(s.country_id) === countryId)
        : states;

    return formatResponse({
      res,
      success: true,
      message: "ok",
      body: { states: filtered },
    });
  } catch (error) {
    console.error(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const cities = async (req: Request, res: Response) => {
  try {
    const rawCountry = (req.query as any)?.country_id;
    const rawState = (req.query as any)?.state_id;
    const countryId = rawCountry ? Number(rawCountry) : null;
    const stateId = rawState ? Number(rawState) : null;
    const cities = readJsonFile(citiesPath);
    const filtered =
      stateId && Number.isFinite(stateId)
        ? cities.filter((c: any) => Number(c.state_id) === stateId)
        : countryId && Number.isFinite(countryId)
        ? cities.filter((c: any) => Number(c.country_id) === countryId)
        : cities;

    return formatResponse({
      res,
      success: true,
      message: "ok",
      body: { cities: filtered },
    });
  } catch (error) {
    console.error(error);
    return formatResponse({ res, success: false, message: error });
  }
};
