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
  report,
  deleteService,
  sendTestNotification,
  myHistoryCanceled,
} from "../../../useCases/service/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import EnsureAdmin from "../../../libs/middlewares/ensure_admin";
const router = Router();
router.post("/", TokenValidation(), add);
router.post("/send", TokenValidation(), EnsureAdmin(), sendTestNotification);
router.put("/:id/finalize", TokenValidation(), finalized);
router.put("/:id", TokenValidation(), update);
router.get("/myonGoing", TokenValidation(), myonGoing);
router.get("/onGoing", TokenOptional(), getsOnGoing);
router.get("/onGoing/worker", TokenValidation(), onGoingWorkers);
router.get("/worker/canceled", TokenValidation(), onGoingCanceledWorkers);
router.get("/history/worker", TokenValidation(), historyWorkers);
router.post("/:id/report", TokenValidation(), report);
router.put("/:id/report", TokenValidation(), report);
router.patch("/:id/report", TokenValidation(), report);
router.post("/report/:id", TokenValidation(), report);
router.put("/report/:id", TokenValidation(), report);
router.patch("/report/:id", TokenValidation(), report);
router.delete("/:id", TokenValidation(), deleteService);
router.get("/", TokenValidation(), gets);
router.get("/myHistory", TokenValidation(), myHistory);
router.get("/myHistoryCanceled", TokenValidation(), myHistoryCanceled);
router.get("/history", TokenValidation(), history);
router.get("/searchAddress", TokenValidation(), searchAddress);
router.get("/:id", TokenValidation(), get);

//

export default router;
