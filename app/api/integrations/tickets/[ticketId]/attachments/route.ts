import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError, internalErrorResponse } from "@/lib/api-errors";
import { extractBearerToken, verifyIntegrationKey, IntegrationPepperMissingError } from "@/lib/services/integration-key-service";
import { MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType } from "@/lib/attachment-policy";
import { saveIntegrationTicketAttachment } from "@/lib/services/integration-attachment-service";
import { checkIntegrationRateLimit } from "@/lib/services/integration-rate-limiter";

// Same bound as externalReferenceId (see createIntegrationTicketSchema) —
// this is the same kind of caller-supplied idempotency key, just for one
// attachment instead of one ticket.
const MAX_EXTERNAL_ATTACHMENT_ID_LENGTH = 200;

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(apiError("rate_limited", "Too many requests. Please slow down and retry later."), {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

/**
 * POST /api/integrations/tickets/{ticketId}/attachments — lets an external
 * integration attach a file to a ticket IT created. Reuses the exact same
 * auth (verifyIntegrationKey), storage (writeAttachmentFile via
 * lib/services/integration-attachment-service.ts), validation
 * (MAX_ATTACHMENT_SIZE_BYTES / isAllowedAttachmentMimeType — the same
 * constants the WEB upload route enforces), and audit (TicketHistory
 * ATTACHMENT_ADDED) machinery as every other attachment path in the app.
 *
 * Ownership check is deliberately NOT "does this ticket belong to the
 * integration's department" — a ticket can share a department with many
 * integrations/humans. It's "did THIS integration create this exact
 * ticket" (ticket.integrationId === the authenticated integration's id).
 * A mismatch (or a ticket that simply doesn't exist) returns the SAME
 * generic 404 either way, so an integration can never use this endpoint to
 * learn that some other integration's ticket id exists at all.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  try {
    const { ticketId } = await params;

    const bearerToken = extractBearerToken(req.headers.get("authorization"));
    const verification = await verifyIntegrationKey(bearerToken);
    if (!verification.ok) {
      if (verification.reason === "disabled") {
        return NextResponse.json(apiError("integration_disabled", "This integration has been disabled."), { status: 403 });
      }
      return NextResponse.json(apiError("invalid_api_key", "Missing, malformed, or invalid API key."), { status: 401 });
    }
    const integration = verification.integration;

    // Applied only after a successfully verified key — see
    // lib/services/integration-rate-limiter.ts's own doc comment for why
    // this keeps the limiter's state bounded. A SEPARATE, independent
    // bucket from ticket creation's — one integration uploading many
    // attachments must never consume its ability to create new tickets,
    // or vice versa.
    const rateLimit = checkIntegrationRateLimit(integration.id, "attachment_upload");
    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit.retryAfterSeconds);
    }

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true, integrationId: true } });
    if (!ticket || ticket.integrationId !== integration.id) {
      return NextResponse.json(apiError("not_found", "Ticket not found."), { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(apiError("validation_failed", "Request body must be valid multipart/form-data."), { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(apiError("validation_failed", "A 'file' field is required.", { field: "file" }), { status: 400 });
    }

    const externalAttachmentIdRaw = formData.get("externalAttachmentId");
    let externalAttachmentId: string | null = null;
    if (typeof externalAttachmentIdRaw === "string" && externalAttachmentIdRaw.trim().length > 0) {
      const trimmed = externalAttachmentIdRaw.trim();
      if (trimmed.length > MAX_EXTERNAL_ATTACHMENT_ID_LENGTH) {
        return NextResponse.json(
          apiError("validation_failed", `externalAttachmentId must not exceed ${MAX_EXTERNAL_ATTACHMENT_ID_LENGTH} characters.`, { field: "externalAttachmentId" }),
          { status: 422 }
        );
      }
      externalAttachmentId = trimmed;
    }

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return NextResponse.json(apiError("validation_failed", "File too large (max 10MB).", { field: "file" }), { status: 413 });
    }
    if (!isAllowedAttachmentMimeType(file.type)) {
      return NextResponse.json(apiError("validation_failed", "File type not allowed.", { field: "file" }), { status: 422 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const result = await saveIntegrationTicketAttachment({
      ticketId: ticket.id,
      buffer,
      originalName: file.name,
      mimeType: file.type,
      externalAttachmentId,
      integrationName: integration.name,
    });

    switch (result.outcome) {
      case "created":
        return NextResponse.json({ success: true, created: true, attachment: result.attachment }, { status: 201 });
      case "duplicate":
        return NextResponse.json({ success: true, created: false, attachment: result.attachment }, { status: 200 });
      case "conflict":
        return NextResponse.json(
          apiError("idempotency_conflict", "This externalAttachmentId was already used to upload a different file to this ticket."),
          { status: 409 }
        );
      case "error":
        return NextResponse.json(apiError("storage_error", result.reason), { status: result.statusCode });
    }
  } catch (error) {
    if (error instanceof IntegrationPepperMissingError) {
      return NextResponse.json(
        apiError("configuration_required", "Integration authentication is not configured on this server."),
        { status: 503 }
      );
    }
    return internalErrorResponse();
  }
}
