/**
 * Phase 4 — Historical Projects Excel Mapping & Dry Run.
 *
 * STRICTLY READ-ONLY. This script never calls createHistoricalProjectRequest
 * (the real, write-capable service) and never opens a Prisma transaction
 * that mutates anything — every Prisma call here is a `findMany`/`findUnique`/
 * `count`. Payload validation reuses the REAL, unmodified
 * createHistoricalProjectRequestSchema (lib/validations.ts) via `.safeParse()`
 * only — the exact contract the real privileged route enforces, never a
 * reimplementation of it.
 *
 * IMPORTANT — DATA SOURCE CAVEAT (see the generated report's own banner):
 * this sandbox's local dev database contains ZERO real Saracakis Group
 * organizational/user data — confirmed by exhaustive name search before
 * this script was written. It is populated entirely with synthetic test
 * fixtures from this session's own automated tests, plus a handful of
 * generic starter departments (Human Resources, Finance, IT, Sales).
 * Every "NO MATCH"/"NONE" result below is therefore expected and does NOT
 * mean the real entity doesn't exist in production — it means this
 * sandbox cannot see production. This run exists to build and prove the
 * MECHANISM (source parsing, normalization, confidence scoring, Zod
 * validation against the real contract, workbook generation) so the exact
 * same script can be re-pointed at a real Helpdesk database later with no
 * logic changes.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/phase4-historical-import-dry-run.ts
 */
import fs from "fs/promises";

const SOURCE_JSON = "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/project_list_rows.json";
const OUTPUT_JSON = "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/phase4_dry_run_results.json";

const STATUS_MAP: Record<string, string> = {
  Delivered: "COMPLETED",
  "In Progress": "IN_PROGRESS",
  "On Hold": "ON_HOLD",
  Cancelled: "CANCELLED",
};

// Never auto-resolved, no matter what a fuzzy DB search turns up — these
// values are inherently organization-wide/ambiguous in the source data
// ("Group" appears to mean "everyone in the Group of companies"; "CEO"
// names an office, not obviously one Department) and resolving either to
// a specific entity without a human decision would risk silently granting
// BROADER access than intended — exactly what this feature's own spec
// forbids ("Never resolve ambiguous organizational audiences by granting
// broader access").
const FORCE_MANUAL_REVIEW = new Set(["Group", "CEO"]);

function splitMulti(v: string | null | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function toDateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

type Confidence = "EXACT" | "FUZZY" | "AMBIGUOUS" | "NONE" | "MANUAL_REVIEW";

interface ResolutionResult {
  sourceValue: string;
  entityType: "User" | "Department" | "BusinessUnit" | "Company" | "Unresolved";
  matches: { id: string; name: string | null; email?: string; isActive?: boolean }[];
  confidence: Confidence;
  note: string;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const { createHistoricalProjectRequestSchema } = await import("@/lib/validations");

  const rawRows: Record<string, any>[] = JSON.parse(await fs.readFile(SOURCE_JSON, "utf8"));

  // ── Resolution caches (one DB round-trip per unique value, never per row) ──
  const userCache = new Map<string, ResolutionResult>();
  const orgCache = new Map<string, ResolutionResult>();

  async function resolveUser(name: string): Promise<ResolutionResult> {
    const key = name.trim();
    if (userCache.has(key)) return userCache.get(key)!;
    const exact = await prisma.user.findMany({
      where: { name: { equals: key, mode: "insensitive" } },
      select: { id: true, name: true, email: true, isActive: true },
    });
    let result: ResolutionResult;
    if (exact.length === 1) {
      result = { sourceValue: key, entityType: "User", matches: exact, confidence: "EXACT", note: "" };
    } else if (exact.length > 1) {
      result = { sourceValue: key, entityType: "User", matches: exact, confidence: "AMBIGUOUS", note: "Multiple active users share this exact name." };
    } else {
      const firstToken = key.split(/\s+/)[0];
      const fuzzy = await prisma.user.findMany({
        where: { name: { contains: firstToken, mode: "insensitive" } },
        select: { id: true, name: true, email: true, isActive: true },
        take: 5,
      });
      result = fuzzy.length
        ? { sourceValue: key, entityType: "User", matches: fuzzy, confidence: "FUZZY", note: "Partial name match only — requires confirmation." }
        : { sourceValue: key, entityType: "Unresolved", matches: [], confidence: "NONE", note: "No active user found by this name in the current Helpdesk database." };
    }
    userCache.set(key, result);
    return result;
  }

  async function resolveOrgEntity(name: string): Promise<ResolutionResult> {
    const key = name.trim();
    if (orgCache.has(key)) return orgCache.get(key)!;

    if (FORCE_MANUAL_REVIEW.has(key)) {
      const result: ResolutionResult = {
        sourceValue: key,
        entityType: "Unresolved",
        matches: [],
        confidence: "MANUAL_REVIEW",
        note: `"${key}" is inherently organization-wide/ambiguous in the source data — deliberately NEVER auto-resolved to avoid granting broader access than intended. Requires an explicit owner decision on the EXACT Department/Business Unit/Company this should become.`,
      };
      orgCache.set(key, result);
      return result;
    }

    const [deptExact, buExact, companyExact] = await Promise.all([
      prisma.department.findMany({ where: { name: { equals: key, mode: "insensitive" } }, select: { id: true, name: true, isActive: true } }),
      prisma.businessUnit.findMany({ where: { name: { equals: key, mode: "insensitive" } }, select: { id: true, name: true } }),
      prisma.company.findMany({ where: { name: { equals: key, mode: "insensitive" } }, select: { id: true, name: true } }),
    ]);
    const exactMatches = [
      ...deptExact.map((d) => ({ ...d, entityType: "Department" as const })),
      ...buExact.map((b) => ({ ...b, entityType: "BusinessUnit" as const, isActive: undefined })),
      ...companyExact.map((c) => ({ ...c, entityType: "Company" as const, isActive: undefined })),
    ];
    let result: ResolutionResult;
    if (exactMatches.length === 1) {
      const m = exactMatches[0];
      result = { sourceValue: key, entityType: m.entityType, matches: [m], confidence: "EXACT", note: "" };
    } else if (exactMatches.length > 1) {
      result = { sourceValue: key, entityType: exactMatches[0].entityType, matches: exactMatches, confidence: "AMBIGUOUS", note: "Multiple entities (possibly across Department/Business Unit/Company) share this exact name." };
    } else {
      const [deptFuzzy, buFuzzy] = await Promise.all([
        prisma.department.findMany({ where: { name: { contains: key.split(/[\s&-]+/)[0], mode: "insensitive" } }, select: { id: true, name: true, isActive: true }, take: 5 }),
        prisma.businessUnit.findMany({ where: { name: { contains: key.split(/[\s&-]+/)[0], mode: "insensitive" } }, select: { id: true, name: true }, take: 5 }),
      ]);
      const fuzzy = [...deptFuzzy.map((d) => ({ ...d, entityType: "Department" as const })), ...buFuzzy.map((b) => ({ ...b, entityType: "BusinessUnit" as const, isActive: undefined }))];
      result = fuzzy.length
        ? { sourceValue: key, entityType: fuzzy[0].entityType, matches: fuzzy, confidence: "FUZZY", note: "Partial name match only — requires confirmation." }
        : { sourceValue: key, entityType: "Unresolved", matches: [], confidence: "NONE", note: "No Department, Business Unit or Company found by this name in the current Helpdesk database." };
    }
    orgCache.set(key, result);
    return result;
  }

  // ── Per-project dry run ──
  const projectResults: any[] = [];
  const seenExternalIds = new Set<string>();

  for (const row of rawRows) {
    const title: string = row["Τίτλος"];
    const ticketId: string | null = row["Ticket ID"] ? String(row["Ticket ID"]) : null;
    const externalSourceId = ticketId
      ? `historical-import:projectlist-2026-11-23:ticket-${ticketId}`
      : `historical-import:projectlist-2026-11-23:title-${slugify(title)}`;
    const isDuplicateExternalId = seenExternalIds.has(externalSourceId);
    seenExternalIds.add(externalSourceId);

    const teamRes = await resolveOrgEntity(row["Team"]);
    const projectOwnerColRes = row["Project Owner"] ? await resolveOrgEntity(row["Project Owner"]) : null;
    const teamOwnerRes = row["Team's Owner"] ? await resolveUser(row["Team's Owner"]) : null;

    const audienceTokens = splitMulti(row["Audiences"]);
    const audienceResolutions = await Promise.all(audienceTokens.map((t) => resolveOrgEntity(t)));

    const responsiblePeopleTokens = splitMulti(row["Responsible People"]);
    const responsibleResolutions = await Promise.all(responsiblePeopleTokens.map((t) => resolveUser(t)));

    const unresolved: string[] = [];
    if (!teamRes || teamRes.confidence === "NONE") unresolved.push(`Project Department ("${row["Team"]}") — no match in this sandbox.`);
    if (projectOwnerColRes && (projectOwnerColRes.confidence === "NONE" || projectOwnerColRes.confidence === "MANUAL_REVIEW" || projectOwnerColRes.confidence === "AMBIGUOUS")) {
      unresolved.push(`Requester Department ("${row["Project Owner"]}") — ${projectOwnerColRes.note || "no confident match"}.`);
    }
    if (teamOwnerRes && teamOwnerRes.confidence === "NONE") unresolved.push(`Project Owner/User ("${row["Team's Owner"]}") — no match in this sandbox.`);
    audienceResolutions.forEach((r, i) => {
      if (r.confidence === "NONE" || r.confidence === "MANUAL_REVIEW" || r.confidence === "AMBIGUOUS") {
        unresolved.push(`Audience ("${audienceTokens[i]}") — ${r.note || "no confident match"}.`);
      }
    });
    responsibleResolutions.forEach((r, i) => {
      if (r.confidence === "NONE") unresolved.push(`Responsible Person ("${responsiblePeopleTokens[i]}") — no match in this sandbox.`);
    });

    // Build the would-be payload in the SAME shape createHistoricalProjectRequestSchema
    // expects (string dates, string ids) — placeholders for anything unresolved so the
    // schema-shape check and the entity-resolution check stay independent concerns.
    const placeholderId = (label: string) => `UNRESOLVED__${label}`;
    const resolvedDepartmentId = teamRes.matches[0]?.id ?? placeholderId("department");
    const resolvedRequesterDeptId = projectOwnerColRes?.matches[0]?.id;
    const resolvedOwnerId = teamOwnerRes?.matches[0]?.id ?? placeholderId("owner");

    const audienceDepartmentIds: string[] = [];
    const audienceBusinessUnitIds: string[] = [];
    audienceResolutions.forEach((r, i) => {
      const m = r.matches[0];
      if (!m) return;
      if (r.entityType === "Department") audienceDepartmentIds.push(m.id);
      else if (r.entityType === "BusinessUnit") audienceBusinessUnitIds.push(m.id);
      // Company-type matches (e.g. "Group" if ever resolved) are deliberately
      // excluded from automatic payload construction — there is no
      // "Audience Company" concept in the historical creation contract, and
      // this value is forced to MANUAL_REVIEW above regardless.
    });
    const responsiblePeopleIds = responsibleResolutions.map((r) => r.matches[0]?.id).filter((id): id is string => !!id);

    const missingRequiredSourceFields: string[] = [];
    if (row["Περιγραφή"] == null || String(row["Περιγραφή"]).trim() === "") missingRequiredSourceFields.push("description");
    // importance/teamConcerned/expectedBenefits have NO source column at all —
    // every row is missing them, not just some; still reported per-row so the
    // Project Import Preview sheet shows it beside each affected project.
    missingRequiredSourceFields.push("importance (no source column)", "teamConcerned (no source column)", "expectedBenefits (no source column)");

    const candidatePayload = {
      title,
      description: row["Περιγραφή"] ?? "", // "" deliberately left to FAIL validation below — never fabricated text.
      importance: undefined, // no source column — left undefined so Zod reports it, never guessed.
      teamConcerned: undefined,
      expectedBenefits: undefined,
      externalSourceId,
      departmentId: resolvedDepartmentId,
      requesterDepartmentId: resolvedRequesterDeptId,
      projectStatus: STATUS_MAP[row["Status"]] ?? undefined,
      projectTitle: undefined,
      projectDescription: undefined,
      startDate: toDateOnly(row["Actual Start Date"]),
      endDate: toDateOnly(row["Actual Finish Date"]),
      ownerIds: [resolvedOwnerId],
      audienceIds: [], // no individual-user audience signal in this source column — only org entities.
      audienceDepartmentIds,
      audienceBusinessUnitIds,
      responsiblePeopleIds,
    };

    const parsed = createHistoricalProjectRequestSchema.safeParse(candidatePayload);

    projectResults.push({
      excelRow: row["_excel_row"],
      title,
      ticketId,
      externalSourceId,
      isDuplicateExternalId,
      status: row["Status"],
      mappedProjectStatus: STATUS_MAP[row["Status"]] ?? null,
      team: row["Team"],
      teamResolution: teamRes,
      teamOwnerRaw: row["Team's Owner"],
      teamOwnerResolution: teamOwnerRes,
      projectOwnerColRaw: row["Project Owner"],
      requesterDepartmentResolution: projectOwnerColRes,
      audienceTokens,
      audienceResolutions,
      responsiblePeopleTokens,
      responsibleResolutions,
      actualStartDate: toDateOnly(row["Actual Start Date"]),
      actualFinishDate: toDateOnly(row["Actual Finish Date"]),
      expectedStartDate: toDateOnly(row["Expected Start Date"]),
      expectedFinishDate: toDateOnly(row["Expected Finish Date"]),
      totalDays: row["Total Days"],
      ticketZohoLink: row["Zoho Link"],
      feedbackUsers: row["Feedback(s) User(s)"],
      estimatedCost: row["ProjectsList_RES_LIST_ProjectList_COLUMN_EstimatedCost"],
      actualCost: row["Actual Cost"],
      description: row["Περιγραφή"],
      missingRequiredSourceFields,
      unresolved,
      zodValidation: parsed.success ? { ok: true } : { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }

  // ── Duplicate/existing-record check (read-only) ──
  const existingByExternalId = await prisma.projectRequest.findMany({
    where: { externalSourceId: { in: Array.from(seenExternalIds) } },
    select: { id: true, externalSourceId: true, title: true },
  });
  const existingByTitle = await prisma.projectRequest.findMany({
    where: { title: { in: rawRows.map((r) => r["Τίτλος"]) } },
    select: { id: true, title: true, externalSourceId: true, source: true },
  });

  // ── Unique-value inventories for the User/Organizational Mapping sheets ──
  const allUserNames = new Set<string>();
  const allOrgNames = new Set<string>();
  for (const row of rawRows) {
    if (row["Team's Owner"]) allUserNames.add(row["Team's Owner"]);
    for (const n of splitMulti(row["Responsible People"])) allUserNames.add(n);
    allOrgNames.add(row["Team"]);
    if (row["Project Owner"]) allOrgNames.add(row["Project Owner"]);
    for (const n of splitMulti(row["Audiences"])) allOrgNames.add(n);
  }
  const userMappingTable = await Promise.all(Array.from(allUserNames).map((n) => resolveUser(n)));
  const orgMappingTable = await Promise.all(Array.from(allOrgNames).map((n) => resolveOrgEntity(n)));

  const output = {
    generatedAt: new Date().toISOString(),
    dataSourceCaveat:
      "This sandbox's local dev database has ZERO real Saracakis Group organizational/user data. All NO MATCH/NONE results reflect that, not a real absence in production.",
    totalProjects: rawRows.length,
    projectResults,
    userMappingTable,
    orgMappingTable,
    existingByExternalId,
    existingByTitle,
  };
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(output, null, 2), "utf8");
  console.log(`Wrote dry-run results for ${rawRows.length} projects to ${OUTPUT_JSON}`);
  console.log(`Existing ProjectRequest rows matching any proposed externalSourceId: ${existingByExternalId.length} (expected 0)`);
  console.log(`Existing ProjectRequest rows matching any source Title: ${existingByTitle.length} (expected 0)`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Dry run failed:", err);
  process.exit(1);
});
