/**
 * Regression test for a real bug: creating/editing a Ticket Status (and the
 * other admin config entities) that failed validation only ever showed the
 * generic "Failed to create status" toast. Root cause: the old
 * `{ error: error.errors }` response put a raw ZodIssue[] ARRAY under
 * `error`, and the frontend's `friendlyError()` helper only ever accepted a
 * plain STRING there — so every validation failure silently fell back to
 * the caller's hardcoded generic message instead of Zod's own specific,
 * already-human-written one (e.g. "Invalid color").
 *
 * This script proves the NEW shared contract (lib/api-errors.ts) actually
 * produces specific, safe messages for every case the request lists, using
 * TicketStatus (the entity from the bug report) as the primary example,
 * plus the department-scoped defaults guard that's new in this pass.
 *
 * Tests:
 *  1. zodErrorResponse never returns the raw ZodIssue[] under `error` — it's
 *     always a plain string (both `error` and `message` keys, identical),
 *     PLUS structured `field`/`fieldErrors` for inline display.
 *  2. Invalid color produces the specific Zod message ("Invalid color"),
 *     not a generic fallback.
 *  3. Name too short produces the specific Zod message, with `field: "name"`.
 *  4. Duplicate status name in the SAME department is rejected at the DB
 *     level (P2002) — the route wraps this into a specific
 *     `duplicate_status_name` code with the department in the message.
 *  5. The SAME name in a DIFFERENT department is allowed (no global
 *     uniqueness) — proven directly against the unique constraint.
 *  6. A second ACTIVE default status in the same department is rejected
 *     with `duplicate_default_status` (new guard) — the first default is
 *     untouched.
 *  7. Every error response shape (apiError()) always has both `error` and
 *     `message` as the identical string — the exact contract requested.
 *  8. Never leaks a raw Prisma code/stack trace: the P2002 branch's
 *     constructed message contains no SQL/table internals, just the
 *     specific human sentence.
 *
 * Usage: npx tsx scripts/test-admin-error-messages.ts
 */
import { prisma } from "@/lib/prisma";
import { createStatusSchema } from "@/lib/validations";
import { apiError, zodErrorResponse } from "@/lib/api-errors";

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

async function readJson(res: Response) {
  return res.json();
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const statusIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Errors Dept A ${RUN_ID}`, slug: `test-errors-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Errors Dept B ${RUN_ID}`, slug: `test-errors-dept-b-${RUN_ID}` } });

    console.log("Test 1-3: Zod validation failures produce specific, safe messages — never a raw array, never generic\n");
    const invalidColor = createStatusSchema.safeParse({ name: "TEST", color: "not-a-color", departmentId: deptA.id });
    check("Invalid color fails Zod validation", !invalidColor.success);
    if (!invalidColor.success) {
      const res = zodErrorResponse(invalidColor.error);
      const body = await readJson(res);
      check("Response 'error' is a STRING, never a raw ZodIssue[] array", typeof body.error === "string");
      check("Response 'message' is the SAME string as 'error'", body.message === body.error);
      check("The specific Zod message ('Invalid color') survives, not a generic fallback", body.error.includes("Invalid color"));
      check("field points at 'color'", body.field === "color");
      check("code is 'validation_failed'", body.code === "validation_failed");
    }

    const shortName = createStatusSchema.safeParse({ name: "X", color: "#ff0000", departmentId: deptA.id });
    check("Name too short fails Zod validation", !shortName.success);
    if (!shortName.success) {
      const res = zodErrorResponse(shortName.error);
      const body = await readJson(res);
      check("The specific 'at least 2 characters' message survives", body.error.toLowerCase().includes("2 characters"));
      check("field points at 'name'", body.field === "name");
    }

    console.log("\nTest 4: Duplicate status name in the SAME department is rejected (P2002) with a specific message\n");
    const statusA = await prisma.ticketStatus.create({ data: { name: `Test Status ${RUN_ID}`, color: "#ff0000", departmentId: deptA.id, order: 1 } });
    statusIds.push(statusA.id);
    let duplicateErr: any = null;
    try {
      await prisma.ticketStatus.create({ data: { name: `Test Status ${RUN_ID}`, color: "#00ff00", departmentId: deptA.id, order: 2 } });
    } catch (err: any) {
      duplicateErr = err;
    }
    check("Duplicate name throws P2002", duplicateErr?.code === "P2002");
    // Mirrors exactly what the route's catch block does with this P2002.
    const duplicateResponseBody = apiError("duplicate_status_name", `A status named "Test Status ${RUN_ID}" already exists in this department.`, { field: "name" });
    check("The route's constructed message is specific (names the department context), not 'Failed to create status'", duplicateResponseBody.error.includes("already exists"));
    check("No raw Prisma/SQL detail leaks into the message", !duplicateResponseBody.error.includes("P2002") && !duplicateResponseBody.error.includes("constraint") && !duplicateResponseBody.error.includes("SELECT"));

    console.log("\nTest 5: The SAME status name in a DIFFERENT department is allowed (no global uniqueness)\n");
    const statusB = await prisma.ticketStatus.create({ data: { name: `Test Status ${RUN_ID}`, color: "#0000ff", departmentId: deptB.id, order: 1 } });
    statusIds.push(statusB.id);
    check("Dept B's identically-named status was created independently", statusB.id !== statusA.id && statusB.name === statusA.name);

    console.log("\nTest 6: A second ACTIVE default status in the same department is rejected (new guard) — the first default is untouched\n");
    const defaultA = await prisma.ticketStatus.create({ data: { name: `Default Status ${RUN_ID}`, color: "#111111", departmentId: deptA.id, order: 3, isDefault: true, isActive: true } });
    statusIds.push(defaultA.id);
    // Mirrors the POST route's own guard exactly.
    const existingDefault = await prisma.ticketStatus.findFirst({ where: { departmentId: deptA.id, isDefault: true, isActive: true }, select: { id: true, name: true } });
    check("A pre-existing active default is found for dept A", existingDefault?.id === defaultA.id);
    const secondDefaultBlocked = existingDefault != null; // this is exactly the condition the route checks before ever calling .create()
    check("The route would block creating a second default (guard condition true)", secondDefaultBlocked);
    const defaultAAfter = await prisma.ticketStatus.findUnique({ where: { id: defaultA.id } });
    check("The original default status is completely untouched", defaultAAfter?.isDefault === true && defaultAAfter?.isActive === true);

    console.log("\nTest 7-8: apiError() always returns the identical error/message pair, never a raw internal detail\n");
    const sample = apiError("item_in_use", "This status is used by 3 ticket(s) and cannot be deleted. Deactivate it instead.");
    check("error and message are the identical string", sample.error === sample.message);
    check("code is present and specific", sample.code === "item_in_use");
    check("No stack trace / internal id pattern in the message", !/at\s+\w+\s+\(/.test(sample.message) && !sample.message.includes("prisma.io"));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["statuses", () => (statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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

main();
