import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import type { Server } from 'node:http';
import { z } from 'zod';
export const BODY_LIMIT = 32 * 1024;
export const loginSchema = z.object({ passphrase: z.string().max(256).optional() }).strict();
export function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}
export function baseApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  return app;
}
export function jsonBody(app: Express): void {
  app.use(express.json({ limit: BODY_LIMIT, strict: true, inflate: false }));
}
export function finishApp(app: Express): void {
  app.use((_req, res) => errorResponse(res, 404, 'NOT_FOUND', '指定された操作はありません。'));
  const handler: ErrorRequestHandler = (error: unknown, _req: Request, res: Response, _next) => {
    const status = (error as { status?: number })?.status;
    if (status === 413) errorResponse(res, 413, 'BODY_TOO_LARGE', '送信内容が上限を超えています。');
    else if (status && status >= 400 && status < 500)
      errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。');
    else errorResponse(res, 500, 'INTERNAL_ERROR', '処理に失敗しました。');
  };
  app.use(handler);
}
export function configureServer(server: Server): void {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
}
export function installShutdown(server: Server): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
