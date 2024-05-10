import Router from 'express';
import { add, get, gets, onGoing, update, deleteService } from '../../../useCases/service/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.get('/', TokenValidation(), gets);
router.get('/onGoing', TokenValidation(), onGoing);
router.get('/:id', TokenValidation(), get);
router.put('/:id', TokenValidation(), update);
router.delete('/:id', TokenValidation(), deleteService);




export default router