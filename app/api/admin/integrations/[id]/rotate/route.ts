import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { generateUniqueIntegrationKey } from "@/lib/services/integration-key-service";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

/**
 * Rotates an integration's API key: generates a brand-new {prefix, hash}
 * pair and overwrites the stored one, so the previous raw key stops
 * verifying immediately (verifyIntegrationKey looks up by apiKeyPrefix —
 * once the old prefix is gone from the row, no lookup can ever match it
 * again, and even a guessed-correct old raw key would still fail the hash
 * comparison against the new apiKeyHash). The new raw key is returned
 * exactly once, same as at creation time.
 *
 * Race-safe by construction: two admins rotating the same integration at
 * the same instant used to both succeed (last UPDATE wins), silently
 * leaving one admin holding a raw key that was never actually the active
 * one — a real gap found during a hardening audit. Fixed with optimistic
 * concurrency: the conditional UPDATE only matches a row if keyVersion is
 * still exactly what this request read moments ago. Whichever request's
 * UPDATE affects zero rows lost the race and gets a controlled 409 with no
 * raw key in the response — never a raw key that silently doesn't work.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "integration.manage", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to manage integrations.");

    const existing = await prisma.externalIntegration.findUnique({ where: { id }, select: { id: true, keyVersion: true } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This integration no longer exists."), { status: 404 });

    const { rawKey, keyPrefix, keyHash } = await generateUniqueIntegrationKey();

    // Compare-and-swap: matches this row only if nothing else has rotated
    // it since the read above. There is no admin-facing delete endpoint
    // for integrations (see app/api/admin/integrations/[id]/route.ts), so
    // a zero-row result here can only mean a concurrent rotation won the
    // race — never a vanished row — making the 409 mapping unambiguous.
    const result = await prisma.externalIntegration.updateMany({
      where: { id, keyVersion: existing.keyVersion },
      data: { apiKeyPrefix: keyPrefix, apiKeyHash: keyHash, keyVersion: { increment: 1 }, lastUsedAt: null },
    });

    if (result.count === 0) {
      return NextResponse.json(
        apiError(
          "integration_key_rotation_conflict",
          "Another rotation for this integration completed first. Your new key was never activated — retry to generate a fresh one."
        ),
        { status: 409 }
      );
    }

    const integration = await prisma.externalIntegration.findUnique({
      where: { id },
      select: { id: true, name: true, apiKeyPrefix: true },
    });
    if (!integration) return NextResponse.json(apiError("item_not_found", "This integration no longer exists."), { status: 404 });

    // Only reachable after result.count === 1 confirmed this exact request
    // won the compare-and-swap — the one place the raw key is returned.
    return NextResponse.json({ integration, apiKey: rawKey });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.code === "P2025") {
      return NextResponse.json(apiError("item_not_found", "This integration no longer exists."), { status: 404 });
    }
    return internalErrorResponse();
  }
}
