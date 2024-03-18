import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
import { get, gets } from '../../../useCases/user/_controller/controller';
const router = Router();
router.get('/', TokenValidation(), gets);
router.get('/one/:id?', TokenValidation(), get);



export default router