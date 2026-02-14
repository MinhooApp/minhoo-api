import Router from "express";
import {
  add,
  searchAddress,
  myHistory,
  history,
  get,
  gets,
  myonGoing,
  getsOnGoing,
  onGoingWorkers,
  onGoingCanceledWorkers,
  historyWorkers,
  update,
  finalized,
  deleteService,
  sendTestNotification,
  myHistoryCanceled,
} from "../../../useCases/service/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
const router = Router();
router.post("/", TokenValidation(), add);
router.post("/send", sendTestNotification);
router.get("/finalized/:id", TokenValidation(), finalized);
router.put("/:id", TokenValidation(), update);
router.get("/myonGoing", TokenValidation(), myonGoing);
router.get("/onGoing", TokenOptional(), getsOnGoing);
router.get("/onGoing/worker", TokenValidation(), onGoingWorkers);
router.get("/worker/canceled", TokenValidation(), onGoingCanceledWorkers);
router.get("/history/worker", TokenValidation(), historyWorkers);
router.delete("/:id", TokenValidation(), deleteService);
router.get("/", TokenValidation(), gets);
router.get("/myHistory", TokenValidation(), myHistory);
router.get("/myHistoryCanceled", TokenValidation(), myHistoryCanceled);
router.get("/history", TokenValidation(), history);
router.get("/searchAddress", TokenValidation(), searchAddress);
router.get("/:id", TokenValidation(), get);

//

export default router;
