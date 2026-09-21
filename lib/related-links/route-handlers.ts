import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import {
  createRelatedLink,
  deleteRelatedLink,
  listRelatedLinks,
  updateRelatedLink,
  type RelatedLinksActor,
  type RelatedLinksResult,
} from "@/lib/services/related-links-service";
import type { RelatedLinkEntityType } from "@/lib/related-links/types";

/**
 * Shared request handling for the four thin per-entity route files
 * (app/api/{projects,activities}/[id]/related-links[/[linkId]]/route.ts).
 * Each of those files only names its entity type and forwards here, so
 * Projects and Activities cannot drift apart. Every handler authenticates
 * and the service independently re-authorizes each request.
 */
async function actorFromSession(): Promise<RelatedLinksActor> {
  const session = await requireAuth();
  return { id: session.user.id, role: session.user.role, customRoleId: session.user.customRoleId };
}

function respond<T>(result: RelatedLinksResult<T>, okStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: okStatus });
  return NextResponse.json(
    { error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) },
    { status: result.status }
  );
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof Error && (err.message === "Unauthorized" || err.name === "SessionExpiredError")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function handleList(type: RelatedLinkEntityType, params: Promise<{ id: string }>) {
  try {
    const { id } = await params;
    return respond(await listRelatedLinks(await actorFromSession(), type, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleCreate(type: RelatedLinkEntityType, req: NextRequest, params: Promise<{ id: string }>) {
  try {
    const { id } = await params;
    const actor = await actorFromSession();
    return respond(await createRelatedLink(actor, type, id, await readJson(req)), 201);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleUpdate(type: RelatedLinkEntityType, req: NextRequest, params: Promise<{ id: string; linkId: string }>) {
  try {
    const { id, linkId } = await params;
    const actor = await actorFromSession();
    return respond(await updateRelatedLink(actor, type, id, linkId, await readJson(req)));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDelete(type: RelatedLinkEntityType, params: Promise<{ id: string; linkId: string }>) {
  try {
    const { id, linkId } = await params;
    return respond(await deleteRelatedLink(await actorFromSession(), type, id, linkId));
  } catch (err) {
    return errorResponse(err);
  }
}
