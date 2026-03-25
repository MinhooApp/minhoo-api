import Router from 'express';
import { add, deleteComment, report } from '../../../useCases/comment/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.post('/:id/report', TokenValidation(), report);
router.put('/:id/report', TokenValidation(), report);
router.patch('/:id/report', TokenValidation(), report);
router.post('/report/:id', TokenValidation(), report);
router.put('/report/:id', TokenValidation(), report);
router.patch('/report/:id', TokenValidation(), report);
router.delete('/group/:groupId/:id', TokenValidation(), deleteComment);
router.delete('/:id', TokenValidation(), deleteComment);



export default router
