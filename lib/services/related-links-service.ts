/**
 * The ONE Related Links implementation shared by Projects and Activities —
 * every route (app/api/{projects,activities}/[id]/related-links/**) is a thin
 * wrapper (see lib/related-links/route-handlers.ts) around these functions;
 * nothing here is per-entity except the tiny ENTITY_CONFIG table below.
 *
 * AUTHORIZATION (no new permission introduced — reuses exactly what Notes
 * already use for the same entity):
 *   view   = project.view / activity.view
 *   modify = project.edit / activity.edit   (add, edit, delete)
 * Both resolved through hasEffectiveEntityPermission — the union of a global
 * grant and an active DepartmentMembership/custom Department role grant FOR
 * THE ENTITY'S OWN departmentId, read from the database row here. Never the
 * active workspace, never the caller's primary department, never anything
 * the client sent. Not hasEffectiveModulePermission (which would let a
 * Department A grant authorize a Department B entity) and not a global-only
 * hasPermission.
 *
 * OWNERSHIP: update/delete match on (linkId AND this route's entity id) in a
 * single statement, so a Related Link id belonging to a different
 * Project/Activity is indistinguishable from a nonexistent one (404) and can
 * never be edited through a crafted route.
 */
import { prisma } from "@/lib/prisma";
import type { Role } from "@prisma/client";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { relatedLinkSchema } from "@/lib/related-links/validation";
import type { RelatedLinkDto, RelatedLinkEntityType } from "@/lib/related-links/types";

export interface RelatedLinksActor {
  id: string;
  role: Role;
  customRoleId: string | null | undefined;
}

export type RelatedLinksResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 403 | 404 | 422; error: string; fieldErrors?: Record<string, string[] | undefined> };

const ENTITY_CONFIG = {
  project: { viewKey: "project.view", editKey: "project.edit", ownerColumn: "projectId" },
  activity: { viewKey: "activity.view", editKey: "activity.edit", ownerColumn: "activityId" },
} as const;

const linkSelect = {
  id: true,
  url: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

function toDto(row: {
  id: string;
  url: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: { id: string; name: string | null; email: string } | null;
}): RelatedLinkDto {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Loads the REAL entity row — the only source of departmentId authorization ever uses. */
async function loadEntity(type: RelatedLinkEntityType, id: string): Promise<{ id: string; departmentId: string | null } | null> {
  return type === "project"
    ? prisma.project.findUnique({ where: { id }, select: { id: true, departmentId: true } })
    : prisma.projectActivity.findUnique({ where: { id }, select: { id: true, departmentId: true } });
}

async function authorize(actor: RelatedLinksActor, type: RelatedLinkEntityType, entity: { departmentId: string | null }, level: "view" | "modify"): Promise<boolean> {
  const cfg = ENTITY_CONFIG[type];
  return hasEffectiveEntityPermission(actor.id, actor.role, actor.customRoleId, entity.departmentId, level === "view" ? cfg.viewKey : cfg.editKey);
}

/** View + modify permission for the server-rendered Project page, which needs both without a client round trip. Null if the entity doesn't exist. */
export async function getRelatedLinksAccess(actor: RelatedLinksActor, type: RelatedLinkEntityType, entityId: string) {
  const entity = await loadEntity(type, entityId);
  if (!entity) return null;
  const [canView, canManage] = await Promise.all([authorize(actor, type, entity, "view"), authorize(actor, type, entity, "modify")]);
  return { canView, canManage };
}

async function queryLinks(type: RelatedLinkEntityType, entityId: string): Promise<RelatedLinkDto[]> {
  const rows = await prisma.relatedLink.findMany({
    where: { [ENTITY_CONFIG[type].ownerColumn]: entityId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], // newest first
    select: linkSelect,
  });
  return rows.map(toDto);
}

export async function listRelatedLinks(actor: RelatedLinksActor, type: RelatedLinkEntityType, entityId: string): Promise<RelatedLinksResult<{ links: RelatedLinkDto[]; canManage: boolean }>> {
  const entity = await loadEntity(type, entityId);
  if (!entity) return { ok: false, status: 404, error: "Not found" };
  if (!(await authorize(actor, type, entity, "view"))) return { ok: false, status: 403, error: "Forbidden" };
  const [canManage, links] = await Promise.all([authorize(actor, type, entity, "modify"), queryLinks(type, entity.id)]);
  return { ok: true, data: { links, canManage } };
}

/** Initial data for a server-rendered page. The CALLER must already have authorized view access (see getRelatedLinksAccess). */
export async function listRelatedLinksForPage(type: RelatedLinkEntityType, entityId: string): Promise<RelatedLinkDto[]> {
  return queryLinks(type, entityId);
}

function validate(input: unknown): RelatedLinksResult<{ url: string; title: string }> {
  const parsed = relatedLinkSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const first = Object.values(fieldErrors).flat()[0] ?? "Invalid input";
    return { ok: false, status: 422, error: first, fieldErrors };
  }
  return { ok: true, data: parsed.data };
}

export async function createRelatedLink(actor: RelatedLinksActor, type: RelatedLinkEntityType, entityId: string, input: unknown): Promise<RelatedLinksResult<RelatedLinkDto>> {
  const entity = await loadEntity(type, entityId);
  if (!entity) return { ok: false, status: 404, error: "Not found" };
  if (!(await authorize(actor, type, entity, "modify"))) return { ok: false, status: 403, error: "Forbidden" };
  const v = validate(input);
  if (!v.ok) return v;
  const row = await prisma.relatedLink.create({
    data: {
      url: v.data.url,
      title: v.data.title,
      // Owner comes from the already-loaded entity, creator from the
      // authenticated session — never from the request body.
      [ENTITY_CONFIG[type].ownerColumn]: entity.id,
      createdById: actor.id,
    },
    select: linkSelect,
  });
  return { ok: true, data: toDto(row) };
}

export async function updateRelatedLink(actor: RelatedLinksActor, type: RelatedLinkEntityType, entityId: string, linkId: string, input: unknown): Promise<RelatedLinksResult<RelatedLinkDto>> {
  const entity = await loadEntity(type, entityId);
  if (!entity) return { ok: false, status: 404, error: "Not found" };
  if (!(await authorize(actor, type, entity, "modify"))) return { ok: false, status: 403, error: "Forbidden" };
  const v = validate(input);
  if (!v.ok) return v;
  // Ownership check and write in ONE statement: matches only if the link
  // belongs to THIS entity, so a foreign link id can't be touched at all.
  const result = await prisma.relatedLink.updateMany({
    where: { id: linkId, [ENTITY_CONFIG[type].ownerColumn]: entity.id },
    data: { url: v.data.url, title: v.data.title },
  });
  if (result.count === 0) return { ok: false, status: 404, error: "Not found" };
  const row = await prisma.relatedLink.findUniqueOrThrow({ where: { id: linkId }, select: linkSelect });
  return { ok: true, data: toDto(row) };
}

export async function deleteRelatedLink(actor: RelatedLinksActor, type: RelatedLinkEntityType, entityId: string, linkId: string): Promise<RelatedLinksResult<{ id: string }>> {
  const entity = await loadEntity(type, entityId);
  if (!entity) return { ok: false, status: 404, error: "Not found" };
  if (!(await authorize(actor, type, entity, "modify"))) return { ok: false, status: 403, error: "Forbidden" };
  const result = await prisma.relatedLink.deleteMany({ where: { id: linkId, [ENTITY_CONFIG[type].ownerColumn]: entity.id } });
  if (result.count === 0) return { ok: false, status: 404, error: "Not found" };
  return { ok: true, data: { id: linkId } };
}
