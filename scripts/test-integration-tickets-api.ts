/**
 * Focused tests for the External Integrations feature: POST
 * /api/integrations/tickets, the ExternalIntegration API-key auth path, and
 * the shared lib/services/ticket-creation-service.ts persistence layer.
 *
 * Calls the real route handler function directly (constructing a
 * NextRequest) rather than requiring a running dev server — the endpoint is
 * Bearer-token authenticated, not session-cookie authenticated, so there's
 * no browser/cookie state to fake, unlike most of this app's other routes.
 *
 * Usage: npx tsx scripts/test-integration-tickets-api.ts
 * Requires a reachable DATABASE_URL and INTEGRATION_KEY_PEPPER — reports
 * clearly and exits if either is missing.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { POST as integrationTicketsPOST } from "@/app/api/integrations/tickets/route";
import { generateIntegrationKey } from "@/lib/services/integration-key-service";
import {
  ensureStatusForDepartment,
  ensureCategoryForDepartment,
  ensurePriorityForDepartment,
  STARTER_STATUSES,
} from "@/lib/services/config-starter-data";

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

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const ENDPOINT_URL = "http://localhost/api/integrations/tickets";

async function callEndpoint(token: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const req = new NextRequest(ENDPOINT_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const res = await integrationTicketsPOST(req);
  const json = await res.json();
  return { status: res.status, json };
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  if (!process.env.INTEGRATION_KEY_PEPPER) {
    console.log("INTEGRATION_KEY_PEPPER is not set — skipping (required to hash/verify integration keys).");
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const userEmails: string[] = [];
  const integrationIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\nSetting up departments and config...\n");

    const deptA = await prisma.department.create({
      data: { name: `Integration Test Dept A ${RUN_ID}`, slug: `int-test-a-${RUN_ID}` },
    });
    departmentIds.push(deptA.id);
    const statusA = await ensureStatusForDepartment(prisma, deptA.id, STARTER_STATUSES[0]);
    const categoryA = await ensureCategoryForDepartment(prisma, deptA.id, { name: "Hardware", description: null, color: "#6366f1" });
    const priorityA = await ensurePriorityForDepartment(prisma, deptA.id, { name: "High", level: 3, color: "#f97316" });
    const subDeptA = await prisma.subDepartment.create({ data: { name: `Sub A ${RUN_ID}`, departmentId: deptA.id } });

    const deptB = await prisma.department.create({
      data: { name: `Integration Test Dept B ${RUN_ID}`, slug: `int-test-b-${RUN_ID}` },
    });
    departmentIds.push(deptB.id);
    await ensureStatusForDepartment(prisma, deptB.id, STARTER_STATUSES[0]);
    const categoryB = await ensureCategoryForDepartment(prisma, deptB.id, { name: "Software", description: null, color: "#8b5cf6" });
    const priorityB = await ensurePriorityForDepartment(prisma, deptB.id, { name: "High", level: 3, color: "#f97316" });

    // A third department with NO default ticket status configured — the
    // "configuration_required" case.
    const deptC = await prisma.department.create({
      data: { name: `Integration Test Dept C ${RUN_ID}`, slug: `int-test-c-${RUN_ID}` },
    });
    departmentIds.push(deptC.id);

    console.log("\nCreating integrations...\n");
    const key1 = generateIntegrationKey();
    const integration1 = await prisma.externalIntegration.create({
      data: {
        name: `Test Integration ${RUN_ID}`,
        slug: `test-integration-${RUN_ID}`,
        departmentId: deptA.id,
        apiKeyPrefix: key1.keyPrefix,
        apiKeyHash: key1.keyHash,
        baseUrl: "https://app.example.com",
      },
    });
    integrationIds.push(integration1.id);

    const keyDisabled = generateIntegrationKey();
    const integrationDisabled = await prisma.externalIntegration.create({
      data: {
        name: `Disabled Integration ${RUN_ID}`,
        slug: `disabled-integration-${RUN_ID}`,
        departmentId: deptA.id,
        apiKeyPrefix: keyDisabled.keyPrefix,
        apiKeyHash: keyDisabled.keyHash,
        isActive: false,
      },
    });
    integrationIds.push(integrationDisabled.id);

    const keyC = generateIntegrationKey();
    const integrationC = await prisma.externalIntegration.create({
      data: {
        name: `Unconfigured Dept Integration ${RUN_ID}`,
        slug: `unconfigured-integration-${RUN_ID}`,
        departmentId: deptC.id,
        apiKeyPrefix: keyC.keyPrefix,
        apiKeyHash: keyC.keyHash,
      },
    });
    integrationIds.push(integrationC.id);

    // ── Auth ────────────────────────────────────────────────────────────
    console.log("\nTesting authentication...\n");
    {
      const { status, json } = await callEndpoint(null, {});
      check("Missing Authorization header -> 401 invalid_api_key", status === 401 && json.code === "invalid_api_key");
    }
    {
      const { status, json } = await callEndpoint("not-a-real-key", {});
      check("Malformed/unknown key -> 401 invalid_api_key", status === 401 && json.code === "invalid_api_key");
    }
    {
      const { status, json } = await callEndpoint(keyDisabled.rawKey, {
        externalReferenceId: `disabled-${RUN_ID}`,
        requesterEmail: `disabled-test-${RUN_ID}@example.com`,
        title: "Should be rejected",
        description: "Disabled integration should never create a ticket.",
      });
      check("Disabled integration's key -> 403 integration_disabled", status === 403 && json.code === "integration_disabled");
    }

    // ── Happy path: create ─────────────────────────────────────────────
    console.log("\nTesting successful ticket creation...\n");
    const requesterEmail = `int-requester-${RUN_ID}@example.com`;
    userEmails.push(requesterEmail);
    let firstTicketId = "";
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-1`,
        requesterEmail: `  ${requesterEmail.toUpperCase()}  `,
        requesterName: "Integration Test User",
        title: "Vehicle application error",
        description: "The user received an error while opening the record.",
        sourceUrl: "https://app.example.com/vehicles/99114",
        metadata: { vehicleId: 99114, plate: "ABC1234" },
      });
      check("Valid request -> 201 created:true", status === 201 && json.success === true && json.created === true);
      check("Response has ticket id/ticketNumber/url", !!json.ticket?.id && !!json.ticket?.ticketNumber && json.ticket?.url === `/tickets/${json.ticket.id}`);
      firstTicketId = json.ticket?.id;
      if (firstTicketId) ticketIds.push(firstTicketId);
    }

    const ticket = firstTicketId
      ? await prisma.ticket.findUnique({
          where: { id: firstTicketId },
          include: { messages: true, history: true, requester: true },
        })
      : null;
    check("Ticket persisted with source: API", ticket?.source === "API");
    check("Ticket.integrationId set to the calling integration", ticket?.integrationId === integration1.id);
    check("Ticket.externalReferenceId stored as sent", ticket?.externalReferenceId === `ref-${RUN_ID}-1`);
    check("Ticket.departmentId is the integration's department (never client-chosen)", ticket?.departmentId === deptA.id);
    check("Ticket.statusId resolved to the department's default status", ticket?.statusId === statusA.id);
    check("Ticket has exactly one initial TicketMessage (direction INBOUND)", ticket?.messages.length === 1 && ticket.messages[0].direction === "INBOUND");
    check("Ticket has exactly one initial TicketHistory row (type CREATED)", ticket?.history.length === 1 && ticket.history[0].type === "CREATED");
    check("TicketHistory.changedById is null for an integration-created ticket", ticket?.history[0]?.changedById === null);
    check("TicketHistory.description names the integration", !!ticket?.history[0]?.description?.includes(integration1.name));
    check("TicketHistory.newValue is \"API\"", ticket?.history[0]?.newValue === "API");

    // ── Requester resolution ───────────────────────────────────────────
    console.log("\nTesting requester resolution...\n");
    check("requesterEmail normalized to lowercase/trimmed", ticket?.requester.email === requesterEmail);
    check("New requester created with default (unprivileged) role USER", ticket?.requester.role === "USER");
    check("New requester is active", ticket?.requester.isActive === true);
    const requesterCountAfterFirst = await prisma.user.count({ where: { email: requesterEmail } });
    check("Exactly one User row for the normalized email", requesterCountAfterFirst === 1);

    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-2`,
        requesterEmail,
        title: "A second, unrelated ticket",
        description: "Same requester, different externalReferenceId.",
      });
      check("Second call with same requesterEmail, new referenceId -> 201 created:true", status === 201 && json.created === true);
      if (json.ticket?.id) ticketIds.push(json.ticket.id);
      const secondTicket = json.ticket?.id ? await prisma.ticket.findUnique({ where: { id: json.ticket.id } }) : null;
      check("Reuses the same requesterId (no duplicate User)", secondTicket?.requesterId === ticket?.requesterId);
    }
    const requesterCountFinal = await prisma.user.count({ where: { email: requesterEmail } });
    check("Still exactly one User row after a second ticket from the same requester", requesterCountFinal === 1);

    // ── Idempotency (sequential replay) ────────────────────────────────
    console.log("\nTesting idempotent replay...\n");
    {
      // A genuine replay: byte-identical payload (mirroring exactly what a
      // retried HTTP call from the same caller would send) must return the
      // original ticket unchanged, never mutate it.
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-1`,
        requesterEmail: `  ${requesterEmail.toUpperCase()}  `,
        requesterName: "Integration Test User",
        title: "Vehicle application error",
        description: "The user received an error while opening the record.",
        sourceUrl: "https://app.example.com/vehicles/99114",
        metadata: { vehicleId: 99114, plate: "ABC1234" },
      });
      check("Identical replay of the same externalReferenceId -> 200 created:false", status === 200 && json.created === false);
      check("Replay returns the original ticket id", json.ticket?.id === firstTicketId);
    }
    {
      // A conflicting replay: same externalReferenceId, but a materially
      // different title/description — the safe policy is to reject this
      // loudly (409) rather than silently keep serving the original ticket
      // as if the new payload had been accepted, and never mutate the
      // stored ticket either way.
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-1`,
        requesterEmail,
        title: "Vehicle application error (a completely different title)",
        description: "This description does not match the original request at all.",
      });
      check("Conflicting replay (different title/description) -> 409 idempotency_conflict", status === 409 && json.code === "idempotency_conflict");
      check("Conflict response names the mismatched fields", json.fieldErrors?.title !== undefined && json.fieldErrors?.description !== undefined);
    }
    const unchangedTicket = await prisma.ticket.findUnique({ where: { id: firstTicketId }, select: { title: true, description: true } });
    check("The original ticket's title was never mutated by the conflicting replay", unchangedTicket?.title === "Vehicle application error");
    const messageCountAfterReplay = await prisma.ticketMessage.count({ where: { ticketId: firstTicketId } });
    const historyCountAfterReplay = await prisma.ticketHistory.count({ where: { ticketId: firstTicketId } });
    check("No second TicketMessage created on replay", messageCountAfterReplay === 1);
    check("No second TicketHistory row created on replay", historyCountAfterReplay === 1);

    // ── Concurrent duplicate requests (the real race) ──────────────────
    console.log("\nTesting concurrent duplicate requests...\n");
    {
      const raceRefId = `ref-${RUN_ID}-race`;
      const raceBody = {
        externalReferenceId: raceRefId,
        requesterEmail: `race-${RUN_ID}@example.com`,
        title: "Concurrent creation race",
        description: "Two simultaneous requests for the same externalReferenceId.",
      };
      userEmails.push(raceBody.requesterEmail);
      const [r1, r2] = await Promise.all([callEndpoint(key1.rawKey, raceBody), callEndpoint(key1.rawKey, raceBody)]);
      const statuses = [r1.status, r2.status].sort();
      check("One request gets 201, the other gets 200 (no double-201)", statuses[0] === 200 && statuses[1] === 201);
      const ids = [r1.json.ticket?.id, r2.json.ticket?.id];
      check("Both responses reference the same single ticket", ids[0] && ids[0] === ids[1]);
      if (ids[0]) ticketIds.push(ids[0]);
      const raceTicketCount = await prisma.ticket.count({
        where: { integrationId: integration1.id, externalReferenceId: raceRefId },
      });
      check("Exactly one Ticket row exists for the race's externalReferenceId", raceTicketCount === 1);
    }

    // ── Payload cannot override server-resolved fields ─────────────────
    console.log("\nTesting payload cannot override department/source/status/requesterId...\n");
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-override-attempt`,
        requesterEmail,
        title: "Attempting to override server fields",
        description: "This request tries to sneak in extra fields.",
        departmentId: deptB.id,
        requesterId: "some-other-user-id",
        statusId: "some-other-status-id",
        assignedAgentId: "some-agent-id",
        source: "WEB",
      });
      check("Unknown/forbidden fields in body -> 422 validation_failed (schema is .strict())", status === 422 && json.code === "validation_failed");
    }

    // ── Category / priority / subdepartment department-ownership ───────
    console.log("\nTesting category/priority/subdepartment department ownership...\n");
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-bad-category`,
        requesterEmail,
        title: "Category from a different department",
        description: "categoryB does not belong to deptA.",
        categoryId: categoryB.id,
      });
      check("categoryId from a different department -> 422 category_department_mismatch", status === 422 && json.code === "category_department_mismatch");
    }
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-bad-priority`,
        requesterEmail,
        title: "Priority from a different department",
        description: "priorityB does not belong to deptA.",
        priorityId: priorityB.id,
      });
      check("priorityId from a different department -> 422 priority_department_mismatch", status === 422 && json.code === "priority_department_mismatch");
    }
    {
      const otherSubDept = await prisma.subDepartment.create({ data: { name: `Sub B ${RUN_ID}`, departmentId: deptB.id } });
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-bad-subdept`,
        requesterEmail,
        title: "SubDepartment from a different department",
        description: "This subDepartment belongs to deptB, not deptA.",
        subDepartmentId: otherSubDept.id,
      });
      check("subDepartmentId from a different department -> 422 subdepartment_department_mismatch", status === 422 && json.code === "subdepartment_department_mismatch");
    }
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-good-config`,
        requesterEmail,
        title: "Valid category, priority and subdepartment",
        description: "All three belong to the integration's own department.",
        categoryId: categoryA.id,
        priorityId: priorityA.id,
        subDepartmentId: subDeptA.id,
      });
      check("Own-department categoryId/priorityId/subDepartmentId accepted -> 201", status === 201);
      if (json.ticket?.id) {
        ticketIds.push(json.ticket.id);
        const created = await prisma.ticket.findUnique({ where: { id: json.ticket.id } });
        check("Ticket uses the requested categoryId/priorityId/subDepartmentId", created?.categoryId === categoryA.id && created?.priorityId === priorityA.id && created?.subDepartmentId === subDeptA.id);
      }
    }

    // ── sourceUrl origin validation ─────────────────────────────────────
    console.log("\nTesting sourceUrl origin validation...\n");
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-bad-origin`,
        requesterEmail,
        title: "sourceUrl on the wrong origin",
        description: "integration1.baseUrl is https://app.example.com.",
        sourceUrl: "https://evil.example.com/phish",
      });
      check("sourceUrl on a different origin than baseUrl -> 422 source_url_origin_mismatch", status === 422 && json.code === "source_url_origin_mismatch");
    }
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-subdomain-origin`,
        requesterEmail,
        title: "sourceUrl on a lookalike subdomain",
        description: "startsWith would wrongly accept this; real origin parsing must not.",
        sourceUrl: "https://app.example.com.evil.com/phish",
      });
      check("Lookalike-subdomain sourceUrl rejected (real origin parsing, not startsWith)", status === 422 && json.code === "source_url_origin_mismatch");
    }

    // ── metadata validation ──────────────────────────────────────────────
    console.log("\nTesting metadata validation...\n");
    {
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-metadata-array`,
        requesterEmail,
        title: "metadata as an array",
        description: "Arrays must be rejected, only plain objects allowed.",
        metadata: [1, 2, 3],
      });
      check("Array metadata rejected -> 422 validation_failed", status === 422 && json.code === "validation_failed");
    }
    {
      const oversized: Record<string, string> = {};
      oversized.blob = "x".repeat(11 * 1024);
      const { status, json } = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-metadata-oversized`,
        requesterEmail,
        title: "Oversized metadata",
        description: "Serialized metadata over the 10KB cap must be rejected.",
        metadata: oversized,
      });
      check("Oversized metadata rejected -> 422 validation_failed", status === 422 && json.code === "validation_failed");
    }

    // ── configuration_required ──────────────────────────────────────────
    console.log("\nTesting configuration_required...\n");
    {
      const { status, json } = await callEndpoint(keyC.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-no-config`,
        requesterEmail: `unconfigured-${RUN_ID}@example.com`,
        title: "Department with no default status",
        description: "deptC has no default TicketStatus configured.",
      });
      userEmails.push(`unconfigured-${RUN_ID}@example.com`);
      check("Missing department default status -> 422 configuration_required (never 500)", status === 422 && json.code === "configuration_required");
    }

    // ── API key rotation invalidates the previous key ───────────────────
    console.log("\nTesting API key rotation...\n");
    {
      const key1b = generateIntegrationKey();
      await prisma.externalIntegration.update({
        where: { id: integration1.id },
        data: { apiKeyPrefix: key1b.keyPrefix, apiKeyHash: key1b.keyHash },
      });

      const oldKeyResult = await callEndpoint(key1.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-after-rotation`,
        requesterEmail,
        title: "Using the old key after rotation",
        description: "This must fail — the old key should no longer verify.",
      });
      check("Old key rejected after rotation -> 401 invalid_api_key", oldKeyResult.status === 401 && oldKeyResult.json.code === "invalid_api_key");

      const newKeyResult = await callEndpoint(key1b.rawKey, {
        externalReferenceId: `ref-${RUN_ID}-after-rotation`,
        requesterEmail,
        title: "Using the new key after rotation",
        description: "This must succeed — the new key should verify.",
      });
      check("New key works immediately after rotation -> 201", newKeyResult.status === 201);
      if (newKeyResult.json.ticket?.id) ticketIds.push(newKeyResult.json.ticket.id);
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      console.log("Prisma error — the migration may not be applied yet:", err.code, err.message);
    } else {
      console.log("Unexpected error:", err instanceof Error ? err.stack : err);
    }
    failed++;
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["integrations", () => prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } })],
      ["users", () => (userEmails.length > 0 ? prisma.user.deleteMany({ where: { email: { in: userEmails } } }) : Promise.resolve())],
      ["subDepartments", () => prisma.subDepartment.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
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

  printSummaryAndExit();
}

main();
