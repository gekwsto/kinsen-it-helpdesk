/**
 * Independent verification that email identity is protected DATABASE-WIDE,
 * not just inside the new integration endpoint's own code path — this was
 * a real gap found during a hardening audit: resolveOrCreateRequester()
 * normalized correctly, but the inbound-email pipeline, the NextAuth
 * Microsoft-login adapter, and (partially) the credentials-login lookup
 * did not, so "User@Example.com" and "user@example.com" could become two
 * different User rows depending on which code path created them first.
 *
 * Covers: the functional unique index on lower(email) actually enforces at
 * the DB level; every live User-creation/lookup path normalizes
 * consistently; a request through one path finds a user created via a
 * different path when the email differs only by case; the wrapped
 * NextAuth adapter's createUser/getUserByEmail normalize.
 *
 * Usage: npx tsx scripts/test-email-canonicalization.ts
 */
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/services/email-identity";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
import { adminLoginSchema, createUserSchema, updateUserRoleSchema } from "@/lib/validations";
import type { ParsedEmail } from "@/lib/email-ticket-parser";
import { matchDepartmentForRecipients, createPendingTicketFromEmail } from "@/lib/services/pending-ticket-service";

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

const RUN_ID = Date.now();

function makeParsedEmail(overrides: Partial<ParsedEmail>): ParsedEmail {
  const now = new Date();
  return {
    subject: "Test Subject",
    fromEmail: `test-${RUN_ID}@example.com`,
    fromName: "Test Sender",
    bodyHtml: "<p>Test body</p>",
    bodyText: "Test body",
    attachments: [],
    messageId: `msg-${RUN_ID}-${Math.random().toString(36).slice(2)}@test.local`,
    conversationId: `conv-${RUN_ID}`,
    receivedAt: now,
    existingTicketNumber: null,
    internetMessageHeaders: [],
    toEmails: [],
    ...overrides,
  };
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userEmails: string[] = [];
  const pendingTicketIds: string[] = [];

  try {
    // ── normalizeEmail pure function ─────────────────────────────────────
    console.log("\nnormalizeEmail...\n");
    check("Trims and lowercases", normalizeEmail("  User@Example.COM  ") === "user@example.com");
    check("Already-canonical input is unchanged", normalizeEmail("user@example.com") === "user@example.com");

    // ── DB-level enforcement ─────────────────────────────────────────────
    console.log("\nDatabase-level case-insensitive uniqueness...\n");
    const mixedCaseEmail = `CanonTest${RUN_ID}@Example.com`;
    const lowerCaseEmail = mixedCaseEmail.toLowerCase();
    userEmails.push(lowerCaseEmail);
    const directInsert = await prisma.user.create({ data: { email: mixedCaseEmail } });
    let dbRejected = false;
    try {
      await prisma.user.create({ data: { email: lowerCaseEmail } });
    } catch (err: any) {
      dbRejected = err.code === "P2002";
    }
    check("A raw case-variant duplicate INSERT is rejected at the DB level (functional unique index)", dbRejected);
    await prisma.user.delete({ where: { id: directInsert.id } });

    // ── resolveOrCreateRequester (integration path) ──────────────────────
    console.log("\nresolveOrCreateRequester (integration requester resolution)...\n");
    const email1 = `cross-path-${RUN_ID}@example.com`;
    userEmails.push(email1);
    const fromIntegration = await resolveOrCreateRequester(`  ${email1.toUpperCase()}  `, "Integration Created");
    check("Stored email is normalized (lowercase, trimmed)", fromIntegration.email === email1);

    // ── Same person, resolved via the inbound-email pending-ticket path ──
    console.log("\nCross-path identity: inbound email finds the SAME user the integration created...\n");
    const dept = await prisma.department.create({ data: { name: `Canon Test Dept ${RUN_ID}`, slug: `canon-test-dept-${RUN_ID}` } });
    const parsed = makeParsedEmail({ fromEmail: email1.toUpperCase(), toEmails: [] });
    const pending = await createPendingTicketFromEmail(parsed, { id: dept.id });
    pendingTicketIds.push(pending.id);
    const pendingRow = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { requesterId: true } });
    check(
      "Inbound email (different case) resolves to the SAME User the integration path created — no duplicate",
      pendingRow?.requesterId === fromIntegration.id
    );
    const userCountForEmail1 = await prisma.user.count({ where: { email: email1 } });
    check("Exactly one User row exists for this email after both paths ran", userCountForEmail1 === 1);

    // ── Zod-level normalization on every known User create/lookup schema ──
    console.log("\nSchema-level email normalization (admin create/edit/login)...\n");
    const createParsed = createUserSchema.safeParse({ name: "Test", email: "  Mixed.Case@Example.COM  ", password: "password123", departmentMemberships: [] });
    check("createUserSchema normalizes email", createParsed.success && createParsed.data.email === "mixed.case@example.com");

    const updateParsed = updateUserRoleSchema.safeParse({ role: "USER", email: "  Mixed.Case@Example.COM  " });
    check("updateUserRoleSchema normalizes email", updateParsed.success && updateParsed.data.email === "mixed.case@example.com");

    const loginParsed = adminLoginSchema.safeParse({ email: "  Mixed.Case@Example.COM  ", password: "x" });
    check("adminLoginSchema normalizes email (credentials login lookup)", loginParsed.success && loginParsed.data.email === "mixed.case@example.com");

    // ── Wrapped NextAuth adapter (the exact object lib/auth.ts wires up) ──
    console.log("\nWrapped NextAuth PrismaAdapter (Microsoft login path)...\n");
    const { withNormalizedEmail } = await import("@/lib/auth");
    const { PrismaAdapter } = await import("@auth/prisma-adapter");
    const wrappedAdapter = withNormalizedEmail(PrismaAdapter(prisma));

    const email2 = `msft-${RUN_ID}@example.com`;
    userEmails.push(email2);
    const seedUser = await resolveOrCreateRequester(email2, "Seed User");

    const foundByMixedCase = await wrappedAdapter.getUserByEmail!(email2.toUpperCase());
    check("wrapped adapter.getUserByEmail(MIXED CASE) finds the existing user", foundByMixedCase?.id === seedUser.id);

    const email3 = `msft-new-${RUN_ID}@example.com`;
    userEmails.push(email3);
    const createdViaAdapter = await wrappedAdapter.createUser!({
      email: `  ${email3.toUpperCase()}  `,
      emailVerified: null,
    } as any);
    check("wrapped adapter.createUser normalizes the stored email", createdViaAdapter.email === email3);

    let secondCreateRejected = false;
    try {
      await wrappedAdapter.createUser!({ email: email3.toLowerCase(), emailVerified: null } as any);
    } catch (err: any) {
      secondCreateRejected = err.code === "P2002";
    }
    check("A second createUser call for the same (normalized) email is rejected, not silently duplicated", secondCreateRejected);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
      await prisma.user.deleteMany({ where: { email: { in: userEmails } } });
      await prisma.department.deleteMany({ where: { slug: `canon-test-dept-${RUN_ID}` } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
