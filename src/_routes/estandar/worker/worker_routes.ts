import Router from 'express';
import { workers } from '../../../useCases/worker/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.get('/', workers);




export default router