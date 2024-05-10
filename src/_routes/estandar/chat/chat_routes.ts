import Router from 'express';
import { myChats, sendMessage, deleteChat, messages } from '../../../useCases/chat/_controller/controller';
import { TokenValidation } from '../../../libs/middlewares/verify_jwt';
const router = Router();

router.get('/', TokenValidation(), myChats);
router.get('/message/:id', TokenValidation(), messages);
router.post('/', TokenValidation(), sendMessage);
router.delete('/:id', TokenValidation(), deleteChat);





export default router