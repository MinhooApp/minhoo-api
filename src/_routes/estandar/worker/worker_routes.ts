import Router from 'express';
import { workers, worker, update } from '../../../useCases/worker/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';

const router = Router();
router.get('/', workers);
router.get('/one/:id?', TokenValidation(), worker);
router.put('/', TokenValidation(), update);




export default router