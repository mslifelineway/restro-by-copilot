import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a client-supplied x-request-id only if it is a UUID; otherwise generates one. */
export function requestId(req: Request & { requestId?: string }, res: Response, next: NextFunction) {
  const inbound = req.headers['x-request-id'];
  req.requestId = typeof inbound === 'string' && UUID.test(inbound) ? inbound : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}
