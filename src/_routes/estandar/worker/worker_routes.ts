import Router from 'express';
import { workers, worker } from '../../../useCases/worker/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';

const router = Router();
router.get('/', workers);
router.get('/one/:id?', TokenValidation(), worker);




export default router