import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

export function authorize(request: IncomingMessage, token: string, port: number, allowedOrigins: Set<string>, websocket = false) {
  for (const name of ['host', 'origin', 'authorization', 'sec-websocket-protocol']) {
    if (request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length > 1) {
      throw new ApiError(403, 'FORBIDDEN', 'Duplicate security header.');
    }
  }
  if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(request.headers.host ?? '')) {
    throw new ApiError(403, 'FORBIDDEN_HOST', 'Unexpected Host.');
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) throw new ApiError(403, 'FORBIDDEN_ORIGIN', 'Unexpected Origin.');
  const provided = websocket
    ? request.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()).find((p) => p.startsWith('paso-token.'))?.slice(11)
    : request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
  const actual = Buffer.from(provided ?? '');
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid session token is required.');
  }
}
