import Router from 'express';
import { add, deleteComment } from '../../../useCases/comment/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();
router.post('/', TokenValidation(), add);
router.delete('/group/:groupId/:id', TokenValidation(), deleteComment);
router.delete('/:id', TokenValidation(), deleteComment);



export default router
