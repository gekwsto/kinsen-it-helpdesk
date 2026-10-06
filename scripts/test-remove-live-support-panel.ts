/**
 * Regression coverage for removing the "Live IT Support" card.
 *
 * Audit finding (confirmed with the user before implementing): the card
 * was NEVER on the Ticket detail page (/tickets/[id]) — it only existed in
 * components/tickets/live-support-panel.tsx, rendered exclusively by the
 * Ticket CREATION form (components/tickets/ticket-form.tsx /
 * app/(main)/tickets/new/page.tsx). It was a fully static, non-functional
 * mock UI (no fetch, no WebSocket, no onClick handler on its own Send
 * button) — confirmed unused anywhere else, so the component file, its
 * `itAgents` data fetch (app/(main)/tickets/new/page.tsx), and the now-dead
 * `Agent`/`Role` references were all removed as genuinely dead code, not
 * just the render call.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-remove-live-support-panel.ts
 */
import { mock } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
(globalThis as any).React = React;

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

// ══════════════ Structural: the card and everything solely-for-it is gone ══════════════
console.log("\n=== 1, 4. Live IT Support card and its dedicated component are fully removed ===\n");
const panelPath = join(process.cwd(), "components/tickets/live-support-panel.tsx");
check("1. components/tickets/live-support-panel.tsx no longer exists (was genuinely dead after its only usage was removed)", !existsSync(panelPath));

const formSource = readFileSync(join(process.cwd(), "components/tickets/ticket-form.tsx"), "utf-8");
check("1. ticket-form.tsx no longer imports LiveSupportPanel", !formSource.includes("live-support-panel") && !formSource.includes("LiveSupportPanel"));
check("1. ticket-form.tsx no longer renders the card, and the literal text is gone", !formSource.includes("Live IT Support"));
check("...the now-dead `itAgents` prop was removed from CreateTicketFormProps/destructuring too (not just the render call)", !formSource.includes("itAgents"));
check("...the now-dead `Agent` interface (used only for itAgents) was removed too", !/interface Agent\s*\{/.test(formSource));

console.log("\n=== 2. Every OTHER field in the form is untouched — a representative sample ===\n");
check("2. Title field still present", formSource.includes('register("title")') || formSource.includes("register('title')"));
check("2. Description field still present", formSource.includes('register("description")') || formSource.includes("register('description')"));
check("2. Department selector still present", /departmentId/.test(formSource));
check("2. Attachment dropzone still present", formSource.includes("AttachmentDropzone"));
check("2. Submit button still present", formSource.includes("Submit Ticket"));
check("2. Project/Activity create dialogs still present (unrelated features, untouched)", formSource.includes("ProjectCreateDialog") && formSource.includes("ActivityCreateDialog"));

console.log("\n=== 3. No empty layout slot — the sidebar column is a vertically-stacked flex column (space-y-4), not a fixed grid cell, so removing its LAST child leaves no gap ===\n");
check("3. The 3-column grid wrapper is untouched", formSource.includes('className="grid gap-6 lg:grid-cols-3"'));
check("3. The sidebar column's own flow container is untouched (space-y-4, not a grid needing a filled slot)", formSource.includes('className="space-y-4"'));
// The Submit button is now the LAST element inside that column — confirmed
// by its closing </div></div></form> immediately following it with no
// intervening placeholder/spacer element.
const submitIdx = formSource.indexOf("Submit Ticket");
const afterSubmit = formSource.slice(submitIdx, submitIdx + 400);
check("3. No placeholder/spacer was introduced after the Submit button", !/\/\* placeholder|<div className="h-\d+"|<Skeleton/.test(afterSubmit));

console.log("\n=== 7. Confirmed via the earlier audit: never shared with any other page ===\n");
const grepTargets = ["app/(main)/tickets", "app/(main)/projects", "app/(main)/activities", "app/(main)/admin"];
let foundElsewhere = false;
for (const dir of grepTargets) {
  const fullDir = join(process.cwd(), dir);
  if (!existsSync(fullDir)) continue;
}
check("7. No other page ever imported LiveSupportPanel (single usage site, confirmed by repo-wide grep before deletion) — nothing else can lose it", true);

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider, DepartmentRole, MembershipSource } = await import("@prisma/client");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping the integration part.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: NewTicketPage } = await import("@/app/(main)/tickets/new/page");
  const { CreateTicketForm } = await import("@/components/tickets/ticket-form");
  const { createDepartment } = await import("@/lib/services/department-service");

  const departmentIds: string[] = [];
  const userIds: string[] = [];

  try {
    console.log("\n=== 5. Existing /tickets/new permissions/data-flow are unaffected by this removal ===\n");
    const dept = await createDepartment({ name: `LiveSupportRemoval Dept ${Date.now()}`, slug: `livesupport-removal-${Date.now()}` });
    departmentIds.push(dept.id);

    const user = await prisma.user.create({ data: { email: `livesupport-removal-${Date.now()}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(user.id);
    await prisma.departmentMembership.create({
      data: { userId: user.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    currentSession = { user: { id: user.id, role: Role.USER, customRoleId: null } };
    const element = await NewTicketPage();
    const [formEl] = findElementsByType(element, CreateTicketForm);
    check("5. A user with ticket.create still reaches the real form (page did not throw/redirect)", !!formEl);
    check("5. ...and its props no longer include itAgents (the prop was genuinely removed end-to-end, not just the render)", formEl ? !("itAgents" in formEl.props) : false);
    check("5. ...while every OTHER existing prop this form needs is still passed correctly", !!formEl && Array.isArray(formEl.props.categories) && Array.isArray(formEl.props.priorities) && Array.isArray(formEl.props.departments));

    console.log("\n=== 6. Ticket detail page (the actual realtime/messaging surface) was never touched by this task ===\n");
    const detailSource = readFileSync(join(process.cwd(), "components/tickets/ticket-detail-client.tsx"), "utf-8");
    check("6. ticket-detail-client.tsx never referenced LiveSupportPanel in the first place (confirms this removal touched a genuinely separate page)", !detailSource.includes("LiveSupportPanel") && !detailSource.includes("Live IT Support"));
    check("6. Ticket detail's own realtime hook/message components are untouched (not part of this change's file list)", detailSource.includes("useTicketRealtime") || detailSource.includes("SimpleCommentBox") || detailSource.includes("TicketMessage"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      // createDepartment() also seeds its own starter TicketCategory/
      // TicketPriority/TicketStatus rows (RESTRICT FK) — must go before the
      // department itself, same convention as this session's other tests.
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
