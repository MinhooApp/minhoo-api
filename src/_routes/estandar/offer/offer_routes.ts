import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';

import {
  add,
  get,
  gets,
  getsByService,
  acceptOffer,
  cancelOffer,
  removeOffer,
} from '../../../useCases/offer/_controller/controller';

const router = Router();

// --------------------
// CRUD
// --------------------
router.post('/', TokenValidation(), add);
router.get('/', TokenValidation(), gets);
router.get('/:id', TokenValidation(), get);

// --------------------
// LISTAR OFFERS POR SERVICIO
// --------------------
router.get('/service/:serviceId', TokenValidation(), getsByService);

// --------------------
// ACCEPT (mantengo PUT + agrego POST por compatibilidad)
// --------------------
router.put('/accept/:offerId', TokenValidation(), acceptOffer);
router.post('/accept/:offerId', TokenValidation(), acceptOffer);

// --------------------
// CANCEL (mantengo PUT + agrego POST por compatibilidad)
// --------------------
router.put('/cancel/:offerId', TokenValidation(), cancelOffer);
router.post('/cancel/:offerId', TokenValidation(), cancelOffer);

// --------------------
// REMOVE (mantengo DELETE + agrego PUT/POST por compatibilidad)
// --------------------
router.delete('/remove/:offerId', TokenValidation(), removeOffer);
router.put('/remove/:offerId', TokenValidation(), removeOffer);
router.post('/remove/:offerId', TokenValidation(), removeOffer);

export default router;



