import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
import { add, get, gets, getsByService } from '../../../useCases/offer/_controller/controller';
const router = Router();
router.post('/', TokenValidation(), add);
router.get('/', TokenValidation(), gets);
router.get('/service/:serviceId', TokenValidation(), getsByService);
router.get('/:id', TokenValidation(), get);




export default router