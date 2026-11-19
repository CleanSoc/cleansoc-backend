export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`, 'not_found');
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Sign in required') => new ApiError(401, message, 'unauthorized');
export const forbidden = (message = 'Not allowed') => new ApiError(403, message, 'forbidden');
export const conflict = (message: string) => new ApiError(409, message, 'conflict');

