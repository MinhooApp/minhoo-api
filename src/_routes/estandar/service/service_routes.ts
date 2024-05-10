import Router from 'express';
<<<<<<< HEAD
import { add, get, gets, update, deleteService } from '../../../useCases/service/_controller/controller';
=======
import { add, get, gets, onGoing, update, deleteService } from '../../../useCases/service/_controller/controller';
>>>>>>> b6c8ab0afc7b62635081ca5efd541cd60cb25b9a
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.get('/', TokenValidation(), gets);
<<<<<<< HEAD
=======
router.get('/onGoing', TokenValidation(), onGoing);
>>>>>>> b6c8ab0afc7b62635081ca5efd541cd60cb25b9a
router.get('/:id', TokenValidation(), get);
router.put('/:id', TokenValidation(), update);
router.delete('/:id', TokenValidation(), deleteService);




export default router