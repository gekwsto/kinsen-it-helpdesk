/**
 * Deliberately blanks NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY /
 * WEB_PUSH_VAPID_PRIVATE_KEY / WEB_PUSH_CONTACT_EMAIL before importing
 * lib/web-push.ts — its VAPID_CONFIGURED check runs once at module load, so
 * this must be its own process/script (scripts/test-ticket-push-notifications.ts
 * sets real test VAPID values before import, which would make this
 * scenario unreachable in that file).
 *
 * Set to "" rather than `delete`d: this dev environment's own .env has real
 * local VAPID keys (see lib/web-push.ts's git history), and @prisma/client
 * loads .env itself as a side effect of `new PrismaClient()` — which
 * lib/web-push.ts transitively triggers via lib/prisma.ts, BEFORE its own
 * top-level VAPID_CONFIGURED check runs. A `delete`d var would simply be
 * silently repopulated by that reload; dotenv's own "never override an
 * already-present key" rule (keyed on presence, not truthiness) is what
 * makes an explicit "" stick. This is an artifact of THIS dev box's .env
 * contents, not a flaw in the application code being tested.
 *
 * Proves: missing VAPID configuration safely no-ops (never throws,
 * subscriptionCount stays 0), the boot-time diagnostic fires and never
 * contains anything that looks like a secret, and isWebPushConfigured()
 * correctly reports false.
 *
 * Usage: npx tsx scripts/test-web-push-vapid-diagnostics.ts
 */
process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY = "";
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "";
process.env.WEB_PUSH_CONTACT_EMAIL = "";

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

async function main() {
  const warnCalls: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args.map(String).join(" "));
  };

  const { isWebPushConfigured, sendPushNotificationsToUser } = await import("@/lib/web-push");

  console.warn = originalWarn;

  console.log("\n=== 19. Missing VAPID configuration safely no-ops, with clear secret-free diagnostics ===\n");
  check("19. isWebPushConfigured() reports false", isWebPushConfigured() === false);
  check("   A boot-time diagnostic warning was logged", warnCalls.length === 1);
  const message = warnCalls[0] ?? "";
  check("   The diagnostic mentions Web Push is disabled", message.includes("Web Push is disabled"));
  check("   The diagnostic never contains an actual key/email-looking value (only booleans)", !/mailto:/.test(message) && !/BP3|bZTa/.test(message));

  let threw = false;
  let result: Awaited<ReturnType<typeof sendPushNotificationsToUser>> | null = null;
  try {
    result = await sendPushNotificationsToUser("nonexistent-user-id", { title: "t", body: "b" });
  } catch {
    threw = true;
  }
  check("   sendPushNotificationsToUser does not throw when VAPID is unconfigured", !threw);
  check("   ...and reports zero subscriptions/sent/failed rather than attempting delivery", result?.subscriptionCount === 0 && result?.sentCount === 0 && result?.failedCount === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
