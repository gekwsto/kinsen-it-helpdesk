import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apiError, zodErrorResponse, internalErrorResponse } from "@/lib/api-errors";
import { extractBearerToken, verifyIntegrationKey, IntegrationPepperMissingError } from "@/lib/services/integration-key-service";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { isDepartmentAcceptingTickets } from "@/lib/services/department-scope-service";
import {
  createTicketAtomic,
  resolveIntegrationTicketDefaults,
} from "@/lib/services/ticket-creation-service";
import { createIntegrationTicketSchema, type CreateIntegrationTicketInput } from "@/lib/validations";

// Comfortably above the worst-case sum of every bounded field (title 200 +
// description 50,000 + requesterEmail 320 + requesterName 200 + sourceUrl
// 2,000 + externalReferenceId 200 + metadata ~10KB, plus JSON syntax/
// escaping overhead), while still blocking multi-MB abuse. Checked two
// ways: (1) Content-Length, when the caller sends one, is rejected before
// any body bytes are read at all — the cheap, fast path; (2) the actual
// received byte length is re-checked after reading, since Content-Length
// is caller-supplied and can be absent (chunked transfer) or wrong. Note
// that (2) alone can't prevent the memory cost of receiving an
// oversized body in the first place — that outer bound is the deployment
// platform's own HTTP body limit (e.g. Vercel's request size cap), which
// this app doesn't need to reimplement; this pair of checks exists so a
// too-large-but-under-the-platform-cap body is still rejected with a
// clear, controlled error instead of a generic validation failure.
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

type TicketResponseShape = { id: string; ticketNumber: number; url: string };

function toTicketResponse(ticket: { id: string; ticketNumber: number }): TicketResponseShape {
  return { id: ticket.id, ticketNumber: ticket.ticketNumber, url: `/tickets/${ticket.id}` };
}

/**
 * Real origin comparison (scheme + host + port via the URL parser), never
 * startsWith — a baseUrl of "https://app.example.com" must NOT accept
 * "https://app.example.com.evil.com/..." (startsWith would), and a
 * sourceUrl of "https://app.example.com:8443/x" must NOT be accepted
 * against a baseUrl on a different port.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Recursively key-sorted JSON.stringify — order-independent structural equality for the metadata comparison below. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type ExistingTicketForConflictCheck = {
  id: string;
  ticketNumber: number;
  title: string;
  description: string;
  sourceUrl: string | null;
  categoryId: string | null;
  priorityId: string | null;
  externalMetadata: unknown;
  requester: { email: string };
};

/**
 * externalReferenceId identifies a single, immutable creation event — a
 * replay with the SAME reference but a materially DIFFERENT payload means
 * either the caller has a bug (reusing a reference for a new event) or is
 * intentionally probing/tampering. The safe policy is: never mutate the
 * original ticket on replay, and make a genuine mismatch loud (409) rather
 * than silently returning the old ticket as if the new payload had been
 * accepted. Fields the caller didn't send this time (optional ones) are
 * never compared — omission isn't an assertion that they changed.
 */
function findIdempotencyConflicts(data: CreateIntegrationTicketInput, existing: ExistingTicketForConflictCheck): string[] {
  const conflicts: string[] = [];
  const normalizedEmail = data.requesterEmail.trim().toLowerCase();
  if (normalizedEmail !== existing.requester.email) conflicts.push("requesterEmail");
  if (data.title !== existing.title) conflicts.push("title");
  if (data.description !== existing.description) conflicts.push("description");
  if (data.sourceUrl !== undefined && (data.sourceUrl ?? null) !== (existing.sourceUrl ?? null)) conflicts.push("sourceUrl");
  if (data.categoryId !== undefined && data.categoryId !== (existing.categoryId ?? undefined)) conflicts.push("categoryId");
  if (data.priorityId !== undefined && data.priorityId !== (existing.priorityId ?? undefined)) conflicts.push("priorityId");
  if (data.metadata !== undefined && canonicalJson(data.metadata) !== canonicalJson(existing.externalMetadata ?? undefined)) {
    conflicts.push("metadata");
  }
  return conflicts;
}

const EXISTING_TICKET_CONFLICT_CHECK_SELECT = {
  id: true,
  ticketNumber: true,
  title: true,
  description: true,
  sourceUrl: true,
  categoryId: true,
  priorityId: true,
  externalMetadata: true,
  requester: { select: { email: true } },
} satisfies Prisma.TicketSelect;

function conflictResponse(conflicts: string[]) {
  return NextResponse.json(
    apiError(
      "idempotency_conflict",
      `This externalReferenceId was already used to create a different ticket — the following field(s) don't match the original request: ${conflicts.join(", ")}.`,
      { fieldErrors: Object.fromEntries(conflicts.map((f) => [f, "Does not match the original request for this externalReferenceId."])) }
    ),
    { status: 409 }
  );
}

export async function POST(req: NextRequest) {
  // Everything below is deliberately inside one try/catch, all the way
  // from auth through the final persistence step — an earlier version only
  // wrapped the last section, so a transient failure anywhere before it
  // (e.g. a missing INTEGRATION_KEY_PEPPER, or a DB hiccup during the
  // idempotency lookup or config resolution) would throw an uncaught
  // exception straight out of this route handler instead of the app's own
  // controlled error contract. Verified via a direct test: with the pepper
  // unset, this used to produce an unhandled rejection rather than a clean
  // response.
  try {
    const bearerToken = extractBearerToken(req.headers.get("authorization"));
    const verification = await verifyIntegrationKey(bearerToken);
    if (!verification.ok) {
      if (verification.reason === "disabled") {
        return NextResponse.json(
          apiError("integration_disabled", "This integration has been disabled."),
          { status: 403 }
        );
      }
      return NextResponse.json(
        apiError("invalid_api_key", "Missing, malformed, or invalid API key."),
        { status: 401 }
      );
    }
    const integration = verification.integration;

    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
      return NextResponse.json(apiError("validation_failed", "Request body is too large."), { status: 413 });
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return NextResponse.json(apiError("validation_failed", "Request body must be valid JSON."), { status: 400 });
    }
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return NextResponse.json(apiError("validation_failed", "Request body is too large."), { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(apiError("validation_failed", "Request body must be valid JSON."), { status: 400 });
    }

    const parsed = createIntegrationTicketSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed.error);
    }
    const data = parsed.data;

    if (data.sourceUrl && integration.baseUrl && !sameOrigin(data.sourceUrl, integration.baseUrl)) {
      return NextResponse.json(
        apiError("source_url_origin_mismatch", "sourceUrl does not share this integration's configured baseUrl origin.", {
          field: "sourceUrl",
        }),
        { status: 422 }
      );
    }

    if (data.subDepartmentId) {
      const validSubDepartment = await validateSubDepartmentInDepartment(data.subDepartmentId, integration.departmentId);
      if (!validSubDepartment) {
        return NextResponse.json(
          apiError("subdepartment_department_mismatch", "subDepartmentId does not belong to this integration's department.", {
            field: "subDepartmentId",
          }),
          { status: 422 }
        );
      }
    }

    // Idempotency fast path — the common case (a genuine replay of a
    // previously-succeeded call) never touches requester resolution or the
    // creation transaction at all.
    const existingTicket = await prisma.ticket.findUnique({
      where: {
        integrationId_externalReferenceId: {
          integrationId: integration.id,
          externalReferenceId: data.externalReferenceId,
        },
      },
      select: EXISTING_TICKET_CONFLICT_CHECK_SELECT,
    });
    if (existingTicket) {
      const conflicts = findIdempotencyConflicts(data, existingTicket);
      if (conflicts.length > 0) return conflictResponse(conflicts);
      return NextResponse.json(
        { success: true, created: false, ticket: toTicketResponse(existingTicket) },
        { status: 200 }
      );
    }

    // Re-checked at the moment of use, not just against the row fetched
    // during key verification above — an admin can disable the integration
    // in the (typically sub-second, but not zero) window between that
    // check and this one. Narrows the race to "disabled after verification
    // but before this point" instead of "disabled any time before the
    // final DB write", which is as tight as it can get without adding a
    // second read immediately before the transaction itself.
    const stillActive = await prisma.externalIntegration.findUnique({ where: { id: integration.id }, select: { isActive: true } });
    if (!stillActive?.isActive) {
      return NextResponse.json(apiError("integration_disabled", "This integration has been disabled."), { status: 403 });
    }

    // Same shared gate WEB ticket/project/activity creation goes through
    // (resolveDepartmentForCreate in department-scope-service.ts) — an
    // integration's department is fixed at creation time rather than
    // resolved per-request, so it never passes through that function, but
    // it must still respect the identical "inactive department accepts no
    // new work" policy rather than silently diverging from WEB. The
    // integration row itself, and every ticket it already created, remain
    // fully intact and readable — only NEW ticket creation is refused.
    if (!(await isDepartmentAcceptingTickets(integration.departmentId))) {
      return NextResponse.json(
        apiError(
          "integration_department_inactive",
          "This integration's department is inactive and is not accepting new tickets. Existing tickets remain accessible."
        ),
        { status: 409 }
      );
    }

    // Re-validated at the moment of use, not just at auth time — the
    // integration or its department config can change between the key
    // verification above and this point (e.g. an admin disables it, or
    // deactivates its department/category/priority, in a race with this
    // request). Config gaps are always a controlled 422/503, never a 500.
    const defaults = await resolveIntegrationTicketDefaults(integration, {
      categoryId: data.categoryId,
      priorityId: data.priorityId,
    });
    if (!defaults.ok) {
      const field = defaults.code === "category_department_mismatch" ? "categoryId" : defaults.code === "priority_department_mismatch" ? "priorityId" : undefined;
      return NextResponse.json(apiError(defaults.code, defaults.message, field ? { field } : undefined), { status: 422 });
    }

    const requester = await resolveOrCreateRequester(data.requesterEmail, data.requesterName);

    try {
      const ticket = await createTicketAtomic(
        {
          title: data.title,
          description: data.description,
          source: "API",
          requesterId: requester.id,
          statusId: defaults.statusId,
          categoryId: defaults.categoryId,
          priorityId: defaults.priorityId,
          departmentId: integration.departmentId,
          subDepartmentId: data.subDepartmentId ?? null,
          integrationId: integration.id,
          externalReferenceId: data.externalReferenceId,
          sourceUrl: data.sourceUrl ?? null,
          externalMetadata: data.metadata as Prisma.InputJsonValue | undefined,
        },
        {
          changedById: null,
          description: `Ticket created through integration ${integration.name}`,
        }
      );

      return NextResponse.json(
        { success: true, created: true, ticket: toTicketResponse(ticket) },
        { status: 201 }
      );
    } catch (error) {
      // Lost a concurrent race against another request for the same
      // (integrationId, externalReferenceId) pair — the DB's own unique
      // constraint is the real guarantee here (not the fast-path check
      // above, which can't see a create that's still in-flight in another
      // request). Whoever loses just returns the winner's ticket.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await prisma.ticket.findUnique({
          where: {
            integrationId_externalReferenceId: {
              integrationId: integration.id,
              externalReferenceId: data.externalReferenceId,
            },
          },
          select: EXISTING_TICKET_CONFLICT_CHECK_SELECT,
        });
        if (winner) {
          const conflicts = findIdempotencyConflicts(data, winner);
          if (conflicts.length > 0) return conflictResponse(conflicts);
          return NextResponse.json(
            { success: true, created: false, ticket: toTicketResponse(winner) },
            { status: 200 }
          );
        }
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof IntegrationPepperMissingError) {
      // A real server misconfiguration, not a caller error — 503 (not 500)
      // signals "this service can't authenticate anyone right now", and
      // never echoes the internal error message to the caller.
      return NextResponse.json(
        apiError("configuration_required", "Integration authentication is not configured on this server."),
        { status: 503 }
      );
    }
    return internalErrorResponse();
  }
}
