import Router from 'express';
import { add, myHistory, history, get, gets, myonGoing, onGoing, update, deleteService, removeWorker } from '../../../useCases/service/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.put('/:id', TokenValidation(), update);
router.get('/myonGoing', TokenValidation(), myonGoing);
router.get('/onGoing', onGoing);
router.delete('/:id', TokenValidation(), deleteService);
router.delete('/worker/:serviceId', TokenValidation(), removeWorker);
router.get('/', TokenValidation(), gets);
router.get('/myHistory', TokenValidation(), myHistory);
router.get('/history', TokenValidation(), history);
router.get('/:id', TokenValidation(), get);
//



export default router