import Router from 'express';
import { add } from '../../../useCases/comment/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);



export default router