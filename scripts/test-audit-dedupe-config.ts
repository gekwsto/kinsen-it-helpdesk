/**
 * Tests scripts/audit-and-dedupe-config.ts's core logic (`computeDedupePlan`/
 * `applyDedupePlan`) directly against deliberately-duplicated fixtures.
 *
 * Important: after the 20260726090000_add_global_name_uniqueness migration,
 * it is no longer POSSIBLE to insert two global (departmentId: null) rows
 * with the same normalized name at all — the partial unique index rejects
 * it, which is exactly the point of that migration. So this test creates its
 * duplicate fixtures inside a real (non-null) test DEPARTMENT instead —
 * the pre-existing `@@unique([departmentId, name])` compound constraint is
 * case-SENSITIVE exact-match only, so two differently-cased/whitespaced
 * names (e.g. "Test Category X" vs "test category x ") can still coexist at
 * the DB level, letting this test create realistic near-duplicate fixtures.
 * `computeDedupePlan`'s grouping query (`GROUP BY departmentId,
 * lower(btrim(name))`) treats `departmentId` as an opaque key throughout —
 * it does not special-case null vs. a real id anywhere — so exercising it
 * against a real department id fully validates the same logic that runs
 * against global (null) groups in production.
 *
 * Requires a reachable DATABASE_URL — exits cleanly if unavailable.
 *
 * Usage: npx tsx scripts/test-audit-dedupe-config.ts
 */
import { prisma } from "@/lib/prisma";
import { computeDedupePlan, applyDedupePlan } from "@/scripts/audit-and-dedupe-config";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const RUN_ID = Date.now();

const CATEGORY_CONFIG = {
  label: "TicketCategory",
  table: "TicketCategory",
  model: "ticketCategory" as const,
  ticketFk: "categoryId" as const,
  mergeBooleanFields: ["isActive"],
  preserveIfEmptyFields: ["description", "color"],
};
const PRIORITY_CONFIG = {
  label: "TicketPriority",
  table: "TicketPriority",
  model: "ticketPriority" as const,
  ticketFk: "priorityId" as const,
  mergeBooleanFields: ["isActive"],
  preserveIfEmptyFields: ["color"],
};
const STATUS_CONFIG = {
  label: "TicketStatus",
  table: "TicketStatus",
  model: "ticketStatus" as const,
  ticketFk: "statusId" as const,
  mergeBooleanFields: ["isActive", "isDefault", "isClosed"],
  preserveIfEmptyFields: ["color"],
};
const CANCEL_REASON_CONFIG = {
  label: "TicketCancelReason",
  table: "TicketCancelReason",
  model: "ticketCancelReason" as const,
  ticketFk: "cancelReasonId" as const,
  mergeBooleanFields: ["isActive"],
  preserveIfEmptyFields: ["description"],
};

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let defaultStatusId: string | undefined;
  const priorityIds: string[] = [];
  const statusIds: string[] = [];
  const cancelReasonIds: string[] = [];
  const categoryIds: string[] = [];
  const ticketIds: string[] = [];
  const slaPolicyPriorityIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Dedupe Dept ${RUN_ID}`, slug: `test-dedupe-dept-${RUN_ID}` } });
    requester = await prisma.user.create({ data: { email: `test-dedupe-${RUN_ID}@kinsen.gr`, authProvider: "CREDENTIALS", role: "USER" } });
    const anyDefaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true }, select: { id: true } });
    defaultStatusId = anyDefaultStatus?.id;
    const anyPriority = await prisma.ticketPriority.findFirst({ select: { id: true } });

    // ── Priority: 2-member group, referenced-loser must still lose to a MORE-referenced canonical ──
    const priCanonical = await prisma.ticketPriority.create({
      data: { name: `Test Priority Dup ${RUN_ID}`, level: 5, color: "#111111", departmentId: dept.id, isActive: true },
    });
    const priLoser = await prisma.ticketPriority.create({
      data: { name: `test priority dup ${RUN_ID} `, level: 4, color: "", departmentId: dept.id, isActive: false },
    });
    priorityIds.push(priCanonical.id, priLoser.id);

    if (defaultStatusId) {
      for (let i = 0; i < 2; i++) {
        const t = await prisma.ticket.create({
          data: { title: `Test dedupe ticket ${RUN_ID}-${i}`, description: "x", requesterId: requester.id, statusId: defaultStatusId, priorityId: priCanonical.id, departmentId: dept.id },
        });
        ticketIds.push(t.id);
      }
      const tLoser = await prisma.ticket.create({
        data: { title: `Test dedupe ticket ${RUN_ID}-loser`, description: "x", requesterId: requester.id, statusId: defaultStatusId, priorityId: priLoser.id, departmentId: dept.id },
      });
      ticketIds.push(tLoser.id);
    }

    // Loser has an SlaPolicy, canonical does not -> should be ADOPTED (repointed), not discarded.
    const slaPolicy = await prisma.slaPolicy.create({ data: { priorityId: priLoser.id, firstResponseHours: 3, resolutionHours: 6 } });
    slaPolicyPriorityIds.push(priLoser.id); // will be re-pointed to canonical by apply

    console.log("Priority dedupe plan\n");
    const priorityPlan = await computeDedupePlan(PRIORITY_CONFIG);
    const priGroup = priorityPlan.find((p) => p.departmentId === dept!.id && p.normalizedName === `test priority dup ${RUN_ID}`.toLowerCase());
    check("Priority duplicate group detected", priGroup !== undefined);
    check("Canonical chosen = the one with more ticket references", priGroup?.canonicalId === priCanonical.id);
    check("Loser correctly identified", priGroup?.loserIds.includes(priLoser.id) === true);
    check("isActive merges true (canonical false, loser... wait canonical is active, loser inactive)", priGroup?.mergedFields.isActive === undefined || priGroup?.mergedFields.isActive === true);
    check("color preserved from loser since canonical's color is non-empty already (no merge expected)", priGroup?.mergedFields.color === undefined);
    check("SlaPolicy action recorded as adopt (canonical has none)", priGroup?.slaPolicyActions.some((a) => a.action === "adopt" && a.loserPriorityId === priLoser.id) === true);
    check("ticketRemapCount reflects the loser's 1 ticket", priGroup?.ticketRemapCount === 1);

    if (priGroup) {
      await applyDedupePlan(PRIORITY_CONFIG, [priGroup]);
    }

    const priLoserAfter = await prisma.ticketPriority.findUnique({ where: { id: priLoser.id } });
    check("Loser priority row is gone after apply", priLoserAfter === null);
    const remappedTicketsCount = await prisma.ticket.count({ where: { priorityId: priCanonical.id, departmentId: dept.id } });
    check("All 3 tickets now reference the canonical priority", remappedTicketsCount === 3);
    const canonicalPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: priCanonical.id } });
    check("Canonical priority adopted the loser's SlaPolicy (hours preserved)", canonicalPolicy?.firstResponseHours === 3 && canonicalPolicy?.resolutionHours === 6);
    slaPolicyPriorityIds.length = 0;
    slaPolicyPriorityIds.push(priCanonical.id);

    console.log("\nRunning the same plan computation again — must be idempotent (no groups left)\n");
    const priorityPlanAgain = await computeDedupePlan(PRIORITY_CONFIG);
    check(
      "No more duplicate groups for this department/name after apply",
      !priorityPlanAgain.some((p) => p.departmentId === dept!.id && p.normalizedName === `test priority dup ${RUN_ID}`.toLowerCase())
    );

    // ── Status: 3-member group + boolean flag merging (isDefault/isClosed) ──
    const statusA = await prisma.ticketStatus.create({ data: { name: `Test Status Dup ${RUN_ID}`, color: "#222", departmentId: dept.id, isActive: true, isDefault: false, isClosed: false, order: 0 } });
    const statusB = await prisma.ticketStatus.create({ data: { name: ` test status dup ${RUN_ID}`, color: "#333", departmentId: dept.id, isActive: true, isDefault: true, isClosed: false, order: 1 } });
    const statusC = await prisma.ticketStatus.create({ data: { name: `TEST STATUS DUP ${RUN_ID} `, color: "#444", departmentId: dept.id, isActive: false, isDefault: false, isClosed: true, order: 2 } });
    statusIds.push(statusA.id, statusB.id, statusC.id);

    console.log("\nStatus dedupe plan (3-member group)\n");
    const statusPlan = await computeDedupePlan(STATUS_CONFIG);
    const statusGroup = statusPlan.find((p) => p.departmentId === dept!.id && p.normalizedName === `test status dup ${RUN_ID}`.toLowerCase());
    check("3-member status duplicate group detected", statusGroup?.loserIds.length === 2);
    check("isDefault merged true onto canonical (statusB had it set)", statusGroup?.mergedFields.isDefault === true);
    check("isClosed merged true onto canonical (statusC had it set)", statusGroup?.mergedFields.isClosed === true);
    check("isActive merged true (statusA/B active, statusC inactive — any-active wins)", statusGroup?.mergedFields.isActive === undefined || statusGroup?.mergedFields.isActive === true);

    if (statusGroup) await applyDedupePlan(STATUS_CONFIG, [statusGroup]);
    const remainingStatuses = await prisma.ticketStatus.count({ where: { departmentId: dept.id, id: { in: [statusA.id, statusB.id, statusC.id] } } });
    check("Only 1 of the 3 status rows survives", remainingStatuses === 1);
    const survivingStatus = await prisma.ticketStatus.findFirst({ where: { departmentId: dept.id, id: { in: [statusA.id, statusB.id, statusC.id] } } });
    check("Surviving status has isDefault and isClosed both merged true", survivingStatus?.isDefault === true && survivingStatus?.isClosed === true);
    if (survivingStatus) statusIds.length = 0, statusIds.push(survivingStatus.id);

    // ── Cancel Reason: preserve-if-empty field merge ──
    const reasonCanonical = await prisma.ticketCancelReason.create({ data: { name: `Test Reason Dup ${RUN_ID}`, description: null, departmentId: dept.id, isActive: true } });
    const reasonLoser = await prisma.ticketCancelReason.create({ data: { name: `test reason dup ${RUN_ID} `, description: "Has a real description", departmentId: dept.id, isActive: true } });
    cancelReasonIds.push(reasonCanonical.id, reasonLoser.id);

    console.log("\nCancel Reason dedupe plan (preserve-if-empty field merge)\n");
    const reasonPlan = await computeDedupePlan(CANCEL_REASON_CONFIG);
    const reasonGroup = reasonPlan.find((p) => p.departmentId === dept!.id && p.normalizedName === `test reason dup ${RUN_ID}`.toLowerCase());
    check("Cancel reason duplicate group detected", reasonGroup !== undefined);
    check("description adopted from loser since canonical's was empty", reasonGroup?.mergedFields.description === "Has a real description");

    if (reasonGroup) await applyDedupePlan(CANCEL_REASON_CONFIG, [reasonGroup]);
    const survivingReason = await prisma.ticketCancelReason.findFirst({ where: { departmentId: dept.id, id: { in: [reasonCanonical.id, reasonLoser.id] } } });
    check("Surviving cancel reason kept the adopted description", survivingReason?.description === "Has a real description");
    if (survivingReason) cancelReasonIds.length = 0, cancelReasonIds.push(survivingReason.id);

    // ── Category: sanity check the same logic applies (no ticket refs at all) ──
    const catCanonical = await prisma.ticketCategory.create({ data: { name: `Test Category Dup ${RUN_ID}`, departmentId: dept.id, isActive: true } });
    const catLoser = await prisma.ticketCategory.create({ data: { name: ` test category dup ${RUN_ID}`, departmentId: dept.id, isActive: true } });
    categoryIds.push(catCanonical.id, catLoser.id);

    const categoryPlan = await computeDedupePlan(CATEGORY_CONFIG);
    const categoryGroup = categoryPlan.find((p) => p.departmentId === dept!.id && p.normalizedName === `test category dup ${RUN_ID}`.toLowerCase());
    check("Category duplicate group detected (0-reference tie-break by createdAt, oldest first)", categoryGroup?.canonicalId === catCanonical.id);

    if (categoryGroup) await applyDedupePlan(CATEGORY_CONFIG, [categoryGroup]);
    const remainingCategories = await prisma.ticketCategory.count({ where: { departmentId: dept.id, id: { in: [catCanonical.id, catLoser.id] } } });
    check("Only 1 of the 2 category rows survives", remainingCategories === 1);
    categoryIds.length = 0;
    categoryIds.push(catCanonical.id);

    console.log("\nFull idempotency: computing plans again for every entity finds nothing left\n");
    const finalPlans = await Promise.all([
      computeDedupePlan(CATEGORY_CONFIG),
      computeDedupePlan(PRIORITY_CONFIG),
      computeDedupePlan(STATUS_CONFIG),
      computeDedupePlan(CANCEL_REASON_CONFIG),
    ]);
    const anyLeftForThisDept = finalPlans.some((plan) => plan.some((item) => item.departmentId === dept!.id));
    check("No duplicate groups remain for this test department in any entity", !anyLeftForThisDept);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["slaPolicy", () => (slaPolicyPriorityIds.length > 0 ? prisma.slaPolicy.deleteMany({ where: { priorityId: { in: slaPolicyPriorityIds } } }) : Promise.resolve())],
      ["ticketPriority", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      ["ticketStatus", () => (statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve())],
      ["ticketCancelReason", () => (cancelReasonIds.length > 0 ? prisma.ticketCancelReason.deleteMany({ where: { id: { in: cancelReasonIds } } }) : Promise.resolve())],
      ["ticketCategory", () => (categoryIds.length > 0 ? prisma.ticketCategory.deleteMany({ where: { id: { in: categoryIds } } }) : Promise.resolve())],
      ["user", () => (requester ? prisma.user.delete({ where: { id: requester.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.delete({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
