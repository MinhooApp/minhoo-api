import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
import { add, get, gets, getsByService, acceptOffer, cancelOffer, removeOffer } from '../../../useCases/offer/_controller/controller';
const router = Router();
router.post('/', TokenValidation(), add);
router.get('/', TokenValidation(), gets);
router.get('/service/:serviceId', TokenValidation(), getsByService);
router.put('/accept/:offerId', TokenValidation(), acceptOffer);
router.put('/cancel/:offerId', TokenValidation(), cancelOffer);
router.delete('/remove/:offerId', TokenValidation(), removeOffer);
router.get('/:id', TokenValidation(), get);




export default router