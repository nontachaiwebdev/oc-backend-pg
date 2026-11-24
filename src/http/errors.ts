import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const unauthorized = (m = "Unauthorized") => new HttpError(401, m, "unauthorized");
export const forbidden = (m = "Forbidden") => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found") => new HttpError(404, m, "not_found");
export const conflict = (m: string) => new HttpError(409, m, "conflict");
export const unavailable = (m: string) => new HttpError(503, m, "service_unavailable");

/** Parse untrusted input, turning validation failures into a 400. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    throw badRequest(path ? `${path}: ${issue?.message}` : (issue?.message ?? "Invalid request"));
  }
  return result.data;
}

const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  "23505": { status: 409, code: "unique_violation", message: "That value already exists" },
  "23503": { status: 409, code: "foreign_key_violation", message: "A related record is missing or still in use" },
  "23001": { status: 409, code: "restrict_violation", message: "This record cannot be deleted" },
  "23502": { status: 400, code: "not_null_violation", message: "A required value is missing" },
  "23514": { status: 400, code: "check_violation", message: "A value is not allowed" },
  "22P02": { status: 400, code: "invalid_input", message: "Invalid value" },
};

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const pgCode = (err as { code?: string })?.code;
  const mapped = pgCode ? PG_ERRORS[pgCode] : undefined;
  if (mapped) {
    res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    return;
  }
  const httpStatus = (err as { status?: number })?.status;
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    res.status(httpStatus).json({ error: "Invalid request", code: "bad_request" });
    return;
  }
  console.error(`${req.method} ${req.path} failed:`, err);
  res.status(500).json({ error: "Internal server error", code: "internal_error" });
}
