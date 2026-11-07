import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function errorResponse(error: unknown) {
  if (error instanceof ApiError) return { status: error.status, error: { code: error.code, message: error.message } };
  if (error instanceof ZodError) return { status: 400, error: { code: 'VALIDATION_ERROR', message: error.message } };
  if (error instanceof SyntaxError) return { status: 400, error: { code: 'INVALID_JSON', message: 'Invalid JSON.' } };
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Local data service failed.' } };
}
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
