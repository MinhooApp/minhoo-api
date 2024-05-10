import Router from 'express';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
<<<<<<< HEAD
import { get, gets } from '../../../useCases/user/_controller/controller';
const router = Router();
router.get('/', TokenValidation(), gets);
=======
const router = Router();
import { get, gets, follow, } from '../../../useCases/user/_controller/controller';
router.get('/', TokenValidation(), gets);
router.post('/follow', TokenValidation(), follow);
>>>>>>> b6c8ab0afc7b62635081ca5efd541cd60cb25b9a
router.get('/one/:id?', TokenValidation(), get);



export default router