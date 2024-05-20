import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
import { get, gets, follow, follows, followers } from '../../../useCases/user/_controller/controller';
router.get('/', TokenValidation(), gets);
router.post('/follow', TokenValidation(), follow);
router.get('/follows/:id?', TokenValidation(), follows);
router.get('/followers/:id?', TokenValidation(), followers);
router.get('/one/:id', get);



export default router