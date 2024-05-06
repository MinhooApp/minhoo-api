import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
import { get, gets, follow, } from '../../../useCases/user/_controller/controller';
router.get('/', TokenValidation(), gets);
router.post('/follow', TokenValidation(), follow);
router.get('/one/:id?', TokenValidation(), get);



export default router