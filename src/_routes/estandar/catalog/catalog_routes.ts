import Router from "express";
import { languages, countries, states, cities } from "../../../useCases/catalog/_controller/controller";

const router = Router();

router.get("/languages", languages);
router.get("/countries", countries);
router.get("/states", states);
router.get("/cities", cities);

export default router;
