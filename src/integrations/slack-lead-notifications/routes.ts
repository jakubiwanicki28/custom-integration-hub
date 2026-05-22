import { Router } from 'express';
import { webhookHandler } from './handler.js';

const router = Router();

router.post('/webhook', webhookHandler);

export { router };
