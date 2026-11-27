/**
 * Configurable Project Statuses — THE shared backend mechanism for reading
 * status definitions and for resolving every Project status write.
 *
 * Model (see prisma/schema.prisma ProjectStatusDefinition):
 *  - One GLOBAL set of definitions (all Workspaces), managed by ADMIN.
 *  - Project.statusDefinitionId = the configured (display) status;
 *    Project.status = its CANONICAL lifecycle state. They always agree:
 *    resolveProjectStatusWrite below produces both together, and the DB
 *    trigger project_status_definition_sync rejects any mismatch from any
 *    other writer.
 *  - Lifecycle rules (completion/reopen, Feedback obligations, overdue/
 *    terminal, Actual dates, financials) read ONLY Project.status — never a
 *    label, color or definition id.
 *
 * DATABASE TRIGGERS (migrations 20261129090000_project_status_definitions +
 * 20261129100000_project_status_trigger_consistency) — a data-integrity
 * BACKSTOP for writers that bypass this service (scripts, raw SQL). They
 * implement NO lifecycle workflow: a raw write to COMPLETED creates no
 * Feedback obligation, notification or email — those live only in PATCH
 * /api/projects/[id].
 *  - project_status_definition_sync (BEFORE INSERT / UPDATE OF status,
 *    statusDefinitionId on "Project"):
 *      · canonical state unchanged, or a definition supplied explicitly ->
 *        the definition is kept (an existing custom/inactive status is never
 *        replaced) — same as resolveProjectStatusWrite's legacy rule;
 *      · canonical-only change (or INSERT without a definition) -> the
 *        ACTIVE system definition of the new state, else the first ACTIVE
 *        definition mapped to it (sortOrder, id) — the SAME order as
 *        resolveProjectStatusWrite; never an inactive one: if none is active
 *        the write is rejected (project_status_no_active_definition);
 *      · always: definition.canonicalStatus must equal status
 *        (project_status_mismatch).
 *    Explicit definitions are only checked for consistency — the
 *    active/inactive SELECTION rules (e.g. re-saving a Project's current
 *    inactive status) stay in resolveProjectStatusWrite.
 *  - project_status_definition_guard (BEFORE UPDATE OF canonicalStatus on
 *    "ProjectStatusDefinition"): rejects remapping a definition referenced
 *    by any Project (project_status_in_use). Deletion of a referenced
 *    definition is blocked by the ON DELETE RESTRICT foreign key.
 *  - Concurrency: definition reads take FOR SHARE, so a concurrent remap
 *    and Project assignment serialize; the later one is rejected.
 */
import { Prisma, ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

export const PROJECT_STATUS_DEFINITION_SELECT = {
  id: true,
  key: true,
  label: true,
  color: true,
  sortOrder: true,
  isActive: true,
  canonicalStatus: true,
  isSystem: true,
} as const;

export type ProjectStatusDefinitionDTO = {
  id: string;
  key: string;
  label: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
  canonicalStatus: ProjectStatus;
  isSystem: boolean;
};

export const PROJECT_STATUS_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
export const PROJECT_STATUS_KEY_REGEX = /^[A-Z][A-Z0-9_]{1,49}$/;

/** All definitions (inactive included — they still display on Projects using them), display order. */
export async function listProjectStatusDefinitions(db: Db = prisma): Promise<ProjectStatusDefinitionDTO[]> {
  return db.projectStatusDefinition.findMany({ orderBy: [{ sortOrder: "asc" }, { label: "asc" }], select: PROJECT_STATUS_DEFINITION_SELECT });
}

/** The always-active default for new Projects (Create default, Request Setup): the SYSTEM PLANNING definition. */
export async function getDefaultProjectStatusDefinition(db: Db = prisma): Promise<ProjectStatusDefinitionDTO> {
  return db.projectStatusDefinition.findFirstOrThrow({ where: { isSystem: true, canonicalStatus: ProjectStatus.PLANNING }, select: PROJECT_STATUS_DEFINITION_SELECT });
}

export type ProjectStatusWrite = { statusDefinitionId: string; status: ProjectStatus };
export type ProjectStatusWriteError = {
  code: "invalid_status_definition" | "inactive_status" | "status_conflict";
  message: string;
};
export type ProjectStatusWriteResult = { ok: true; write: ProjectStatusWrite | null } | { ok: false; error: ProjectStatusWriteError };

/**
 * Resolves a requested status change into the (definition, canonical) pair
 * to persist — or `write: null` for "leave unchanged".
 *
 *  - `statusDefinitionId` given: must exist; if `status` is ALSO given it
 *    must equal the definition's canonical state (else status_conflict).
 *    Newly selecting an INACTIVE definition is rejected; re-saving the
 *    Project's CURRENT (possibly inactive) definition is allowed.
 *  - Only the legacy enum `status` given (backward-compatible callers):
 *    unchanged canonical state -> unchanged (an existing custom/inactive
 *    definition is never replaced); a different state -> the active SYSTEM
 *    definition of that state, else the first active definition mapped to
 *    it (display order); none active -> inactive_status.
 *  - Neither given: unchanged; for a NEW Project (`current` null) the
 *    default SYSTEM PLANNING definition.
 */
export async function resolveProjectStatusWrite(
  input: { statusDefinitionId?: string | null; status?: ProjectStatus | null },
  current: ProjectStatusWrite | null,
  db: Db = prisma
): Promise<ProjectStatusWriteResult> {
  const { statusDefinitionId, status } = input;

  if (statusDefinitionId) {
    const def = await db.projectStatusDefinition.findUnique({ where: { id: statusDefinitionId }, select: PROJECT_STATUS_DEFINITION_SELECT });
    if (!def) return { ok: false, error: { code: "invalid_status_definition", message: "The selected Project Status does not exist." } };
    if (status && status !== def.canonicalStatus) {
      return { ok: false, error: { code: "status_conflict", message: `The selected Project Status "${def.label}" represents ${def.canonicalStatus}, not ${status}.` } };
    }
    if (!def.isActive && def.id !== current?.statusDefinitionId) {
      return { ok: false, error: { code: "inactive_status", message: `The Project Status "${def.label}" is inactive and can't be selected.` } };
    }
    if (current && current.statusDefinitionId === def.id) return { ok: true, write: null };
    return { ok: true, write: { statusDefinitionId: def.id, status: def.canonicalStatus } };
  }

  if (status) {
    if (current && current.status === status) return { ok: true, write: null };
    const candidates = await db.projectStatusDefinition.findMany({
      where: { canonicalStatus: status, isActive: true },
      orderBy: [{ isSystem: "desc" }, { sortOrder: "asc" }],
      select: { id: true },
      take: 1,
    });
    if (candidates.length === 0) {
      return { ok: false, error: { code: "inactive_status", message: `No active Project Status represents ${status}.` } };
    }
    return { ok: true, write: { statusDefinitionId: candidates[0].id, status } };
  }

  if (current) return { ok: true, write: null };
  const def = await getDefaultProjectStatusDefinition(db);
  return { ok: true, write: { statusDefinitionId: def.id, status: def.canonicalStatus } };
}

// ─── Administration ───────────────────────────────────────────────────────────

export type ProjectStatusAdminError = {
  status: 400 | 404 | 409;
  code:
    | "invalid_label"
    | "invalid_color"
    | "invalid_sort_order"
    | "invalid_canonical_status"
    | "invalid_key"
    | "duplicate_key"
    | "duplicate_label"
    | "not_found"
    | "system_status_protected"
    | "planning_must_stay_active"
    | "status_in_use";
  message: string;
  usageCount?: number;
};
type AdminResult = { ok: true; definition: ProjectStatusDefinitionDTO } | { ok: false; error: ProjectStatusAdminError };

const isCanonical = (v: unknown): v is ProjectStatus => typeof v === "string" && (Object.values(ProjectStatus) as string[]).includes(v);

function validateDisplayFields(input: { label?: unknown; color?: unknown; sortOrder?: unknown }): ProjectStatusAdminError | null {
  if (input.label !== undefined && (typeof input.label !== "string" || input.label.trim().length === 0 || input.label.trim().length > 50)) {
    return { status: 400, code: "invalid_label", message: "A label (1-50 characters) is required." };
  }
  if (input.color !== undefined && (typeof input.color !== "string" || !PROJECT_STATUS_COLOR_REGEX.test(input.color))) {
    return { status: 400, code: "invalid_color", message: "Color must be a valid #RRGGBB hex value." };
  }
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || (input.sortOrder as number) < 0)) {
    return { status: 400, code: "invalid_sort_order", message: "Display order must be a whole number (0 or more)." };
  }
  return null;
}

async function labelTaken(label: string, exceptId?: string): Promise<boolean> {
  return (await prisma.projectStatusDefinition.count({ where: { label: { equals: label.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
}

function keyFromLabel(label: string): string {
  const base = label.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(base) ? base.slice(0, 40) : `STATUS_${base}`.slice(0, 40);
}

export async function createProjectStatusDefinition(input: { key?: unknown; label?: unknown; color?: unknown; sortOrder?: unknown; canonicalStatus?: unknown; isActive?: unknown }): Promise<AdminResult> {
  if (input.label === undefined) return { ok: false, error: { status: 400, code: "invalid_label", message: "A label (1-50 characters) is required." } };
  const invalid = validateDisplayFields(input);
  if (invalid) return { ok: false, error: invalid };
  if (!isCanonical(input.canonicalStatus)) {
    return { ok: false, error: { status: 400, code: "invalid_canonical_status", message: "Select the lifecycle state this status represents." } };
  }
  const label = (input.label as string).trim();
  if (await labelTaken(label)) return { ok: false, error: { status: 409, code: "duplicate_label", message: `A Project Status labelled "${label}" already exists.` } };
  let key: string;
  if (input.key !== undefined && input.key !== null && input.key !== "") {
    if (typeof input.key !== "string" || !PROJECT_STATUS_KEY_REGEX.test(input.key)) {
      return { ok: false, error: { status: 400, code: "invalid_key", message: "Key must be UPPER_SNAKE_CASE (letters, digits, underscores; starts with a letter)." } };
    }
    key = input.key;
    if (await prisma.projectStatusDefinition.findUnique({ where: { key } })) {
      return { ok: false, error: { status: 409, code: "duplicate_key", message: `The key "${key}" is already used.` } };
    }
  } else {
    const base = keyFromLabel(label);
    key = base;
    for (let n = 2; await prisma.projectStatusDefinition.findUnique({ where: { key } }); n++) key = `${base}_${n}`;
  }
  const maxOrder = await prisma.projectStatusDefinition.aggregate({ _max: { sortOrder: true } });
  const definition = await prisma.projectStatusDefinition.create({
    data: {
      key,
      label,
      color: (input.color as string | undefined) ?? "#94a3b8",
      sortOrder: (input.sortOrder as number | undefined) ?? (maxOrder._max.sortOrder ?? 0) + 10,
      isActive: input.isActive === undefined ? true : input.isActive === true,
      canonicalStatus: input.canonicalStatus,
      isSystem: false,
    },
    select: PROJECT_STATUS_DEFINITION_SELECT,
  });
  return { ok: true, definition };
}

export async function updateProjectStatusDefinition(
  id: string,
  input: { key?: unknown; label?: unknown; color?: unknown; sortOrder?: unknown; canonicalStatus?: unknown; isActive?: unknown }
): Promise<AdminResult> {
  const existing = await prisma.projectStatusDefinition.findUnique({ where: { id }, select: PROJECT_STATUS_DEFINITION_SELECT });
  if (!existing) return { ok: false, error: { status: 404, code: "not_found", message: "This Project Status no longer exists." } };
  if (input.key !== undefined && input.key !== existing.key) {
    return { ok: false, error: { status: 400, code: "invalid_key", message: "A Project Status key is immutable." } };
  }
  const invalid = validateDisplayFields(input);
  if (invalid) return { ok: false, error: invalid };
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") {
    return { ok: false, error: { status: 400, code: "invalid_label", message: "isActive must be true or false." } };
  }
  if (input.canonicalStatus !== undefined && input.canonicalStatus !== existing.canonicalStatus) {
    if (!isCanonical(input.canonicalStatus)) {
      return { ok: false, error: { status: 400, code: "invalid_canonical_status", message: "Select the lifecycle state this status represents." } };
    }
    if (existing.isSystem) {
      return { ok: false, error: { status: 409, code: "system_status_protected", message: `"${existing.label}" is a system status — its lifecycle state can't be changed.` } };
    }
    const usageCount = await prisma.project.count({ where: { statusDefinitionId: id } });
    if (usageCount > 0) {
      return { ok: false, error: { status: 409, code: "status_in_use", usageCount, message: `"${existing.label}" is used by ${usageCount} Project(s) — its lifecycle state can't be changed. Create a new status instead.` } };
    }
  }
  if (input.isActive === false && existing.isSystem && existing.canonicalStatus === ProjectStatus.PLANNING) {
    return { ok: false, error: { status: 409, code: "planning_must_stay_active", message: `"${existing.label}" is the default status for new Projects and must stay active.` } };
  }
  if (typeof input.label === "string" && (await labelTaken(input.label, id))) {
    return { ok: false, error: { status: 409, code: "duplicate_label", message: `A Project Status labelled "${input.label.trim()}" already exists.` } };
  }
  const definition = await prisma.projectStatusDefinition.update({
    where: { id },
    data: {
      label: typeof input.label === "string" ? input.label.trim() : undefined,
      color: input.color as string | undefined,
      sortOrder: input.sortOrder as number | undefined,
      isActive: input.isActive as boolean | undefined,
      canonicalStatus: input.canonicalStatus as ProjectStatus | undefined,
    },
    select: PROJECT_STATUS_DEFINITION_SELECT,
  });
  return { ok: true, definition };
}

export async function deleteProjectStatusDefinition(id: string): Promise<{ ok: true } | { ok: false; error: ProjectStatusAdminError }> {
  const existing = await prisma.projectStatusDefinition.findUnique({ where: { id }, select: PROJECT_STATUS_DEFINITION_SELECT });
  if (!existing) return { ok: false, error: { status: 404, code: "not_found", message: "This Project Status no longer exists." } };
  if (existing.isSystem) {
    return { ok: false, error: { status: 409, code: "system_status_protected", message: `"${existing.label}" is a system status and can't be deleted (it can be renamed, recolored or deactivated).` } };
  }
  const usageCount = await prisma.project.count({ where: { statusDefinitionId: id } });
  if (usageCount > 0) {
    return { ok: false, error: { status: 409, code: "status_in_use", usageCount, message: `"${existing.label}" is used by ${usageCount} Project(s) and can't be deleted. Move those Projects to another status, or deactivate it instead.` } };
  }
  await prisma.projectStatusDefinition.delete({ where: { id } });
  return { ok: true };
}

/** Usage counts for the Admin list (one grouped query). */
export async function getProjectStatusUsageCounts(): Promise<Record<string, number>> {
  const rows = await prisma.project.groupBy({ by: ["statusDefinitionId"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.statusDefinitionId, r._count._all]));
}
