import Router from 'express';
import { signup, login } from '../../../useCases/auth/_controller/controller';
const router = Router();
router.post('/', signup);
router.post('/login', login);

export default router