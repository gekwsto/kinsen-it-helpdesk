import { NextResponse } from "next/server";
import type { ZodError } from "zod";

/**
 * Shared error-response contract for every admin config route (Categories/
 * Priorities/Statuses/Cancel Reasons/SLA/Activity Progress/Activity
 * Statuses). Every caller gets a real, human-readable, specific message —
 * never a raw Prisma error, SQL detail, stack trace, or internal id.
 *
 * `error` is the ORIGINAL key every existing frontend caller already reads
 * (`err.error`) — kept for zero-regression backward compatibility. `message`
 * is the same string under the name this task's error contract asks for.
 * Both are always present and always equal.
 */
export interface ApiErrorBody {
  code: string;
  error: string;
  message: string;
  /** Dot-path of the single most relevant offending field, when applicable — lets the UI show an inline error under that exact input. */
  field?: string;
  /** Every field with an issue, first message per field — for forms with more than one bad field at once. */
  fieldErrors?: Record<string, string>;
}

export function apiError(code: string, message: string, opts?: { field?: string; fieldErrors?: Record<string, string> }): ApiErrorBody {
  return { code, error: message, message, ...opts };
}

/**
 * Converts a Zod validation failure into the shared error contract —
 * this is the actual root cause of "Failed to create status" and similar
 * generic messages: the old `{ error: error.errors }` shape put a raw
 * ZodIssue[] array under `error`, which the frontend's `friendlyError()`
 * helper only ever accepted as a plain string, so EVERY validation failure
 * (bad color, short name, etc.) silently fell back to the caller's generic
 * "Failed to create X" default instead of Zod's own specific, already
 * human-written message (e.g. "Invalid color").
 */
export function zodErrorResponse(error: ZodError, status = 422) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  const first = error.issues[0];
  const field = first && first.path.length > 0 ? first.path.join(".") : undefined;
  return NextResponse.json(apiError("validation_failed", first?.message ?? "Invalid input.", { field, fieldErrors }), { status });
}

export function unauthorizedResponse() {
  return NextResponse.json(apiError("unauthorized", "You must be signed in to do this."), { status: 401 });
}

export function forbiddenResponse(message = "You do not have permission to manage this in this department.") {
  return NextResponse.json(apiError("missing_permission", message), { status: 403 });
}

export function internalErrorResponse() {
  return NextResponse.json(apiError("internal_error", "Something went wrong on our end. Please try again."), { status: 500 });
}
