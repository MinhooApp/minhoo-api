import Router from "express";
import {
  add,
  searchAddress,
  myHistory,
  history,
  get,
  gets,
  myonGoing,
  onGoing,
  onGoingWorkers,
  onGoingCanceledWorkers,
  historyWorkers,
  update,
  finalized,
  deleteService,
  sendTestNotification,
} from "../../../useCases/service/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();
router.post("/", TokenValidation(), add);
router.post("/send", sendTestNotification);
router.get("/finalized/:id", TokenValidation(), finalized);
router.put("/:id", TokenValidation(), update);
router.get("/myonGoing", TokenValidation(), myonGoing);
router.get("/onGoing", onGoing);
router.get("/onGoing/worker", TokenValidation(), onGoingWorkers);
router.get(
  "/onGoing/worker/canceled",
  TokenValidation(),
  onGoingCanceledWorkers
);
router.get("/history/worker", TokenValidation(), historyWorkers);
router.delete("/:id", TokenValidation(), deleteService);
router.get("/", TokenValidation(), gets);
router.get("/myHistory", TokenValidation(), myHistory);
router.get("/history", TokenValidation(), history);
router.get("/searchAddress", TokenValidation(), searchAddress);
router.get("/:id", TokenValidation(), get);

//

export default router;
