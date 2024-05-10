import Router from 'express';
<<<<<<< HEAD
import { workers, worker } from '../../../useCases/worker/_controller/controller';
=======
import { workers, worker, update } from '../../../useCases/worker/_controller/controller';
>>>>>>> b6c8ab0afc7b62635081ca5efd541cd60cb25b9a
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';

const router = Router();
router.get('/', workers);
router.get('/one/:id?', TokenValidation(), worker);
<<<<<<< HEAD
=======
router.put('/', TokenValidation(), update);
>>>>>>> b6c8ab0afc7b62635081ca5efd541cd60cb25b9a




export default router