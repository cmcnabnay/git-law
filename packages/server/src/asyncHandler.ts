import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejected promises returned from async route
 * handlers — an unhandled rejection there crashes the entire process
 * (Node's default behavior since v15), taking down every other request in
 * flight, not just the one that failed. Wrapping every async handler in
 * this forwards the error to Express's error middleware instead, so a bad
 * git command or corrupted row turns into a 500 response for that one
 * request rather than an outage.
 */
export function asyncHandler<P = any>(
  fn: (req: Request<P>, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    Promise.resolve(fn(req as Request<P>, res, next)).catch(next);
  };
}
