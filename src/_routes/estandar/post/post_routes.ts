import Router from 'express';
import { add, get, gets, like } from '../../../useCases/post/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.get('/', gets);
router.put('/like/:id', TokenValidation(), like);
router.get('/:id', get);




export default router

