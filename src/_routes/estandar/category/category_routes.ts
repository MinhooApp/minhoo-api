import Router from 'express';
import { gets, } from '../../../useCases/category/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();

router.get('/', gets);




export default router