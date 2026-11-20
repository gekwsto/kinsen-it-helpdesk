/**
 * Focused tests for Entra ID (Microsoft Entra / Azure AD) requester
 * identity support in the integration ticket-creation endpoint:
 *   - lib/services/requester-resolution-service.ts's
 *     resolveOrCreateRequesterByEntraIdentity (oid-first resolution,
 *     tenant validation, conflict detection, race-safe linking/creation).
 *   - lib/validations.ts's createIntegrationTicketSchema's two new
 *     optional fields (requesterMicrosoftUserId/requesterTenantId).
 *   - app/api/integrations/tickets/route.ts's wiring of both.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-integration-entra-identity.ts
 * Requires a reachable DATABASE_URL, INTEGRATION_KEY_PEPPER, and
 * AUTH_MICROSOFT_ENTRA_ID_TENANT_ID (this app's own configured Entra
 * tenant — any non-empty value works for these tests, they never
 * actually call Entra/Graph).
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const TAG = `entra-${RUN_ID}`;

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider } = await import("@prisma/client");
  const { generateIntegrationKey } = await import("@/lib/services/integration-key-service");
  const { ensureStatusForDepartment, STARTER_STATUSES } = await import("@/lib/services/config-starter-data");
  const { POST: ticketsPOST } = await import("@/app/api/integrations/tickets/route");
  const {
    resolveOrCreateRequesterByEntraIdentity,
    EntraTenantMismatchError,
    EntraIdentityConflictError,
  } = await import("@/lib/services/requester-resolution-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  if (!process.env.INTEGRATION_KEY_PEPPER) {
    console.log("INTEGRATION_KEY_PEPPER is not set — skipping.");
    printSummaryAndExit();
    return;
  }
  const REAL_TENANT_ID = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
  if (!REAL_TENANT_ID) {
    console.log("AUTH_MICROSOFT_ENTRA_ID_TENANT_ID is not set — skipping (required to validate requesterTenantId).");
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const integrationIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  function ticketReq(token: string | null, body: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return new NextRequest("http://localhost/api/integrations/tickets", { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function callTickets(token: string | null, body: unknown) {
    const res = await ticketsPOST(ticketReq(token, body));
    const json = await res.json();
    return { status: res.status, json };
  }

  try {
    console.log("\nSetting up department/integration fixtures...\n");
    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);
    await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);

    const key1 = generateIntegrationKey();
    const integration1 = await prisma.externalIntegration.create({
      data: { name: `${TAG}-int-1`, slug: `${TAG}-int-1`, departmentId: dept.id, apiKeyPrefix: key1.keyPrefix, apiKeyHash: key1.keyHash },
    });
    integrationIds.push(integration1.id);

    // ── Schema-level: requesterTenantId required alongside the oid ─────
    console.log("\nSchema validation...\n");
    {
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-no-tenant`,
        requesterEmail: `${TAG}-x@example.com`,
        title: "Missing tenant id",
        description: "oid supplied without a tenant id must be rejected at the schema level.",
        requesterMicrosoftUserId: "oid-without-tenant",
      });
      check("requesterMicrosoftUserId without requesterTenantId -> 422 validation_failed", status === 422 && json.code === "validation_failed");
    }

    // ── 1. Existing Entra user resolved by OID ──────────────────────────
    console.log("\n1. Existing user resolved by OID...\n");
    const oid1 = `${TAG}-oid-1`;
    const email1 = `${TAG}-user-1@example.com`;
    const existingByOid = await prisma.user.create({
      data: { email: email1, name: "Pre-existing Entra User", role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true, microsoftUserId: oid1 },
    });
    userIds.push(existingByOid.id);
    {
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-by-oid`,
        requesterEmail: email1,
        title: "Ticket resolved purely by oid",
        description: "The requester already exists, linked by oid.",
        requesterMicrosoftUserId: oid1,
        requesterTenantId: REAL_TENANT_ID,
      });
      check("Resolution by existing oid -> 201", status === 201);
      if (json.ticket?.id) ticketIds.push(json.ticket.id);
      const ticket = json.ticket?.id ? await prisma.ticket.findUnique({ where: { id: json.ticket.id } }) : null;
      check("Ticket's requesterId is the PRE-EXISTING user (no duplicate created)", ticket?.requesterId === existingByOid.id);
    }
    const countAfterOidResolution = await prisma.user.count({ where: { email: email1 } });
    check("Still exactly one User row for this email after oid resolution", countAfterOidResolution === 1);

    // ── 2. Existing user safely linked by email (no oid yet) ────────────
    console.log("\n2. Existing user linked by email (no prior oid)...\n");
    const email2 = `${TAG}-user-2@example.com`;
    const existingByEmailOnly = await prisma.user.create({
      data: { email: email2, name: "Credentials User", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: true },
    });
    userIds.push(existingByEmailOnly.id);
    const oid2 = `${TAG}-oid-2`;
    {
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-link-by-email`,
        requesterEmail: email2,
        title: "Ticket that links a new oid to an existing email-only user",
        description: "The user exists by email, with no Entra oid linked yet.",
        requesterMicrosoftUserId: oid2,
        requesterTenantId: REAL_TENANT_ID,
      });
      check("Resolution by email, linking a new oid -> 201", status === 201);
      if (json.ticket?.id) ticketIds.push(json.ticket.id);
      const ticket = json.ticket?.id ? await prisma.ticket.findUnique({ where: { id: json.ticket.id } }) : null;
      check("Ticket's requesterId is the PRE-EXISTING (now-linked) user", ticket?.requesterId === existingByEmailOnly.id);
    }
    const linkedUser = await prisma.user.findUnique({ where: { id: existingByEmailOnly.id } });
    check("The existing user's microsoftUserId is now linked to the supplied oid", linkedUser?.microsoftUserId === oid2);
    const countAfterLink = await prisma.user.count({ where: { email: email2 } });
    check("Still exactly one User row for this email after linking", countAfterLink === 1);

    // ── 3. New user creation (neither oid nor email known) ──────────────
    console.log("\n3. New user creation via Entra identity...\n");
    const oid3 = `${TAG}-oid-3`;
    const email3 = `${TAG}-user-3@example.com`;
    {
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-new-user`,
        requesterEmail: email3,
        requesterName: "Brand New Entra User",
        title: "Ticket from a brand-new Entra-identified requester",
        description: "Neither this oid nor this email exist locally yet.",
        requesterMicrosoftUserId: oid3,
        requesterTenantId: REAL_TENANT_ID,
      });
      check("Resolution with no local match -> 201 (creates a new user)", status === 201);
      if (json.ticket?.id) ticketIds.push(json.ticket.id);
      const ticket = json.ticket?.id ? await prisma.ticket.findUnique({ where: { id: json.ticket.id }, include: { requester: true } }) : null;
      check("New user has the supplied email, name and oid", ticket?.requester.email === email3 && ticket?.requester.name === "Brand New Entra User" && ticket?.requester.microsoftUserId === oid3);
      check("New user got the default (unprivileged) role", ticket?.requester.role === "USER");
      if (ticket?.requesterId) userIds.push(ticket.requesterId);
    }

    // ── 4. Email/OID conflict rejection ──────────────────────────────────
    console.log("\n4a. oid resolves to a DIFFERENT email than supplied...\n");
    {
      // existingByOid (step 1) is linked to oid1/email1 — reuse oid1 with a DIFFERENT email.
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-oid-email-conflict`,
        requesterEmail: `${TAG}-a-totally-different-email@example.com`,
        title: "oid/email conflict",
        description: "This oid is already linked to a different email.",
        requesterMicrosoftUserId: oid1,
        requesterTenantId: REAL_TENANT_ID,
      });
      check("oid linked to a different email -> 409 requester_identity_conflict", status === 409 && json.code === "requester_identity_conflict");
      const ticketCount = await prisma.ticket.count({ where: { externalReferenceId: `${TAG}-ref-oid-email-conflict` } });
      check("No ticket was created by the conflicting request", ticketCount === 0);
    }
    console.log("\n4b. email resolves to a DIFFERENT oid than supplied...\n");
    {
      // email2 (step 2) is now linked to oid2 — reuse email2 with a DIFFERENT oid.
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-email-oid-conflict`,
        requesterEmail: email2,
        title: "email/oid conflict",
        description: "This email is already linked to a different oid.",
        requesterMicrosoftUserId: `${TAG}-some-other-oid`,
        requesterTenantId: REAL_TENANT_ID,
      });
      check("email linked to a different oid -> 409 requester_identity_conflict", status === 409 && json.code === "requester_identity_conflict");
      const ticketCount = await prisma.ticket.count({ where: { externalReferenceId: `${TAG}-ref-email-oid-conflict` } });
      check("No ticket was created by the conflicting request", ticketCount === 0);
      const unchangedLink = await prisma.user.findUnique({ where: { id: existingByEmailOnly.id } });
      check("The existing link (email2 -> oid2) was never overwritten", unchangedLink?.microsoftUserId === oid2);
    }

    // ── 5. Tenant mismatch rejection ─────────────────────────────────────
    console.log("\n5. Tenant mismatch rejection...\n");
    {
      const { status, json } = await callTickets(key1.rawKey, {
        externalReferenceId: `${TAG}-ref-tenant-mismatch`,
        requesterEmail: `${TAG}-tenant-mismatch@example.com`,
        title: "Wrong tenant",
        description: "requesterTenantId does not match this server's configured tenant.",
        requesterMicrosoftUserId: `${TAG}-some-oid`,
        requesterTenantId: "a-completely-different-tenant-id",
      });
      check("Mismatched requesterTenantId -> 422 tenant_mismatch", status === 422 && json.code === "tenant_mismatch");
      const ticketCount = await prisma.ticket.count({ where: { externalReferenceId: `${TAG}-ref-tenant-mismatch` } });
      check("No ticket was created on tenant mismatch", ticketCount === 0);
      const noUserCreated = await prisma.user.count({ where: { email: `${TAG}-tenant-mismatch@example.com` } });
      check("No user was created on tenant mismatch either", noUserCreated === 0);
    }

    // ── 6. Concurrent identity resolution ───────────────────────────────
    console.log("\n6a. Concurrent resolution of a brand-new oid+email (true race)...\n");
    {
      const raceOid = `${TAG}-oid-race-new`;
      const raceEmail = `${TAG}-race-new@example.com`;
      const identity = { microsoftUserId: raceOid, tenantId: REAL_TENANT_ID, rawEmail: raceEmail, rawName: "Race New User" };
      const [r1, r2] = await Promise.all([
        resolveOrCreateRequesterByEntraIdentity(identity),
        resolveOrCreateRequesterByEntraIdentity(identity),
      ]);
      check("Both concurrent calls resolve to the SAME user id", r1.id === r2.id);
      const count = await prisma.user.count({ where: { microsoftUserId: raceOid } });
      check("Exactly ONE User row exists for this oid (no duplicate from the race)", count === 1);
      userIds.push(r1.id);
    }
    console.log("\n6b. Concurrent linking of a new oid onto an EXISTING email-only user...\n");
    {
      const raceEmail = `${TAG}-race-link@example.com`;
      const raceOid = `${TAG}-oid-race-link`;
      const preExisting = await prisma.user.create({
        data: { email: raceEmail, name: "Race Link User", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: true },
      });
      userIds.push(preExisting.id);
      const identity = { microsoftUserId: raceOid, tenantId: REAL_TENANT_ID, rawEmail: raceEmail, rawName: null };
      const [r1, r2] = await Promise.all([
        resolveOrCreateRequesterByEntraIdentity(identity),
        resolveOrCreateRequesterByEntraIdentity(identity),
      ]);
      check("Both concurrent linking calls resolve to the SAME, pre-existing user id", r1.id === preExisting.id && r2.id === preExisting.id);
      const relinked = await prisma.user.findUnique({ where: { id: preExisting.id } });
      check("The user is linked to the race's oid exactly once (no corruption)", relinked?.microsoftUserId === raceOid);
      const count = await prisma.user.count({ where: { email: raceEmail } });
      check("Still exactly one User row for this email after the concurrent link", count === 1);
    }

    // ── 7. Existing integrations without Entra fields — direct service check ──
    console.log("\n7. resolveOrCreateRequesterByEntraIdentity error classes are distinguishable...\n");
    {
      let threw: unknown = null;
      try {
        await resolveOrCreateRequesterByEntraIdentity({ microsoftUserId: "x", tenantId: "wrong-tenant", rawEmail: "x@example.com", rawName: null });
      } catch (e) {
        threw = e;
      }
      check("Direct call also throws EntraTenantMismatchError for a wrong tenant", threw instanceof EntraTenantMismatchError);
    }
    {
      let threw: unknown = null;
      try {
        await resolveOrCreateRequesterByEntraIdentity({ microsoftUserId: oid1, tenantId: REAL_TENANT_ID, rawEmail: "not-the-right-email@example.com", rawName: null });
      } catch (e) {
        threw = e;
      }
      check("Direct call also throws EntraIdentityConflictError for an oid/email mismatch", threw instanceof EntraIdentityConflictError);
    }
  } catch (err) {
    console.log("Unexpected error:", err instanceof Error ? err.stack : err);
    failed++;
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["integrations", () => prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
    ];
    for (const [label, step] of steps) {
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
