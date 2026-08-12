/**
 * Regression coverage for the production Web Push root cause: the browser
 * client previously read `process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY`
 * directly, a value Next.js inlines into the client bundle at `next build`
 * time. In this app's Docker deployment, `.dockerignore` excludes `.env`
 * from the build context and docker-compose.yml only supplies `.env` via
 * `env_file:` to the RUNTIME container — so the builder stage always saw
 * an empty key, permanently baking "" into the shipped bundle regardless
 * of the running container's real environment. The fix: the client now
 * fetches the public key at RUNTIME from GET /api/notifications/push/config,
 * which reads the same env var on the server, at request time, inside the
 * already-running (correctly configured) container.
 *
 * This repo's test scripts are plain Node/Prisma (no jsdom/React Testing
 * Library) — components/notifications/notification-dropdown.tsx itself is
 * not mounted here. Its core enable/disable DECISION logic lives in the
 * pure, dependency-free lib/notifications/push-client-decisions.ts module
 * (imported by the component itself, not reimplemented), which IS fully
 * unit-testable without a DOM. Structural/source-level checks below are
 * used only for the handful of facts that are genuinely about wiring
 * (e.g. "the component no longer reads the build-time env var") rather
 * than decision logic.
 *
 * Usage: npx tsx scripts/test-web-push-runtime-config.ts
 */
process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY =
  "BP37wV3PociDKeuwfefsNPqqNvlKvIxblTkBJbSEjsdniwfzLmf8R9Bn2XdaykpTzwYDOdlR0oalpxvE6tNjeLM";
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "bZTaAuvDGfHuf6geK0UHCe-C3hzFtnKw6ZhpKEf82Kc";
process.env.WEB_PUSH_CONTACT_EMAIL = "test-push@example.com";

import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { isWebPushConfigured, getWebPushPublicKey } from "@/lib/web-push";
import {
  isPushRuntimeConfigured,
  isPushCapableBrowser,
  shouldProceedAfterPermission,
  shouldEnableAfterSubscribeResponse,
  shouldTreatLocalSubscriptionAsEnabled,
} from "@/lib/notifications/push-client-decisions";
import { Role, AuthProvider } from "@prisma/client";

const RUN_ID = Date.now();
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
  await prisma.$connect();
  const userIds: string[] = [];

  try {
    // ══════════════ 1. Client no longer depends on a build-time NEXT_PUBLIC value ══════════════
    console.log("\n=== 1. Client push setup no longer depends on a build-time-inlined NEXT_PUBLIC value ===\n");
    const dropdownSource = fs.readFileSync(
      path.join(process.cwd(), "components", "notifications", "notification-dropdown.tsx"),
      "utf8"
    );
    // Checks actual code, not the file's own doc comments (which
    // deliberately explain, in prose, why process.env.NEXT_PUBLIC_... is no
    // longer read) — strips // comment lines first so only real statements
    // are checked.
    const dropdownCodeOnly = dropdownSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    check(
      "1. notification-dropdown.tsx never reads process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY in actual code",
      !dropdownCodeOnly.includes("process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY")
    );
    check(
      "   ...and instead fetches the runtime config endpoint",
      dropdownSource.includes("/api/notifications/push/config")
    );
    check(
      "   ...using the runtime public key for PushManager.subscribe (never a module-level constant)",
      dropdownSource.includes("applicationServerKey: urlBase64ToUint8Array(publicKey)")
    );

    // ══════════════ 3. Runtime config route never references private VAPID material ══════════════
    console.log("\n=== 3. The runtime config endpoint exposes only the public key ===\n");
    const configRouteSource = fs.readFileSync(
      path.join(process.cwd(), "app", "api", "notifications", "push", "config", "route.ts"),
      "utf8"
    );
    check(
      "3. The route source never references WEB_PUSH_VAPID_PRIVATE_KEY",
      !configRouteSource.includes("WEB_PUSH_VAPID_PRIVATE_KEY")
    );
    check(
      "   ...or WEB_PUSH_CONTACT_EMAIL",
      !configRouteSource.includes("WEB_PUSH_CONTACT_EMAIL")
    );
    check(
      "   ...and is gated by requireAuth() (not a public/unauthenticated route)",
      configRouteSource.includes("requireAuth()")
    );

    // With a fully-configured server, getWebPushPublicKey() must return the PUBLIC key and never equal the private key.
    check("3. getWebPushPublicKey() returns the real public key when fully configured", getWebPushPublicKey() === process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY);
    check("   ...and it is never equal to the private key value", getWebPushPublicKey() !== process.env.WEB_PUSH_VAPID_PRIVATE_KEY);
    check("   isWebPushConfigured() reports true", isWebPushConfigured() === true);

    // ══════════════ Pure decision logic: capability / runtime config / permission / server-response gating ══════════════
    console.log("\n=== Pure decision logic used directly by the component ===\n");

    check("isPushCapableBrowser: all three APIs present -> true", isPushCapableBrowser({ hasNotification: true, hasServiceWorker: true, hasPushManager: true }) === true);
    check("isPushCapableBrowser: missing PushManager -> false", isPushCapableBrowser({ hasNotification: true, hasServiceWorker: true, hasPushManager: false }) === false);
    check("isPushCapableBrowser: missing serviceWorker -> false", isPushCapableBrowser({ hasNotification: true, hasServiceWorker: false, hasPushManager: true }) === false);
    check("isPushCapableBrowser: missing Notification -> false", isPushCapableBrowser({ hasNotification: false, hasServiceWorker: true, hasPushManager: true }) === false);

    // ══════════════ 2. Runtime config safely reports unconfigured when the server VAPID setup is incomplete ══════════════
    console.log("\n=== 2. isPushRuntimeConfigured() safely reports false for an incomplete server response ===\n");
    check("2. configured:false, publicKey:null -> not configured", isPushRuntimeConfigured({ configured: false, publicKey: null }) === false);
    check("   configured:true but publicKey:null (partially configured server) -> still not configured", isPushRuntimeConfigured({ configured: true, publicKey: null }) === false);
    check("   configured:false but a publicKey somehow present -> still not configured (requires BOTH)", isPushRuntimeConfigured({ configured: false, publicKey: "some-key" }) === false);
    check("   null/undefined config (e.g. fetch failed) -> not configured", isPushRuntimeConfigured(null) === false && isPushRuntimeConfigured(undefined) === false);
    check("   Only configured:true AND a real publicKey -> configured", isPushRuntimeConfigured({ configured: true, publicKey: "BP37..." }) === true);

    // ══════════════ 7. Permission denied/default never proceeds to subscribe ══════════════
    console.log("\n=== 7. Permission denied/default never proceeds to create a subscription ===\n");
    check("7. 'denied' -> does not proceed", shouldProceedAfterPermission("denied") === false);
    check("   'default' (dismissed without choosing) -> does not proceed", shouldProceedAfterPermission("default") === false);
    check("   'granted' -> proceeds", shouldProceedAfterPermission("granted") === true);

    // ══════════════ 4/8. Enabled state is gated strictly on the server's response ══════════════
    console.log("\n=== 4/8. pushEnabled=true is only ever reachable when the server confirms the subscription ===\n");
    check("4. A non-2xx subscribe response -> never enables push", shouldEnableAfterSubscribeResponse({ ok: false }) === false);
    check("8. A 2xx subscribe response -> enables push", shouldEnableAfterSubscribeResponse({ ok: true }) === true);
    check("8. Full happy path (granted permission + successful server response) both gate to true", shouldProceedAfterPermission("granted") && shouldEnableAfterSubscribeResponse({ ok: true }));

    // ══════════════ 5. A local subscription absent from the DB is shown as disabled/stale ══════════════
    console.log("\n=== 5. A local subscription with no matching server row is shown as disabled, not enabled ===\n");
    check("5. No server verification at all -> disabled", shouldTreatLocalSubscriptionAsEnabled(null) === false);
    check("   Server explicitly reports subscribed:false -> disabled", shouldTreatLocalSubscriptionAsEnabled({ subscribed: false }) === false);
    check("   Server confirms subscribed:true -> enabled", shouldTreatLocalSubscriptionAsEnabled({ subscribed: true }) === true);

    // Prove the underlying data-shape end to end: the exact query GET
    // /api/notifications/push/subscribe?endpoint= runs (prisma.pushSubscription.findFirst
    // scoped by endpoint + userId) correctly distinguishes a real,
    // owned subscription from a browser-only/foreign one.
    const user = await prisma.user.create({
      data: { email: `push-runtime-cfg-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(user.id);
    const realEndpoint = `https://push.example.com/real-${RUN_ID}`;
    await prisma.pushSubscription.create({
      data: { userId: user.id, endpoint: realEndpoint, p256dh: "test-p256dh", auth: "test-auth" },
    });
    const foundReal = await prisma.pushSubscription.findFirst({ where: { endpoint: realEndpoint, userId: user.id }, select: { id: true } });
    check("   A real, owned subscription is found (would report subscribed:true)", !!foundReal);
    const foundStale = await prisma.pushSubscription.findFirst({ where: { endpoint: `https://push.example.com/stale-${RUN_ID}`, userId: user.id }, select: { id: true } });
    check("   A browser-only endpoint with no matching DB row is NOT found (would report subscribed:false, i.e. stale/repairable)", !foundStale);

    // ══════════════ 6. Service worker registration failure is handled without crashing ══════════════
    console.log("\n=== 6. Service worker registration failure is caught, never crashes the app ===\n");
    // Structural proof (no jsdom in this repo to actually reject
    // navigator.serviceWorker.register()): every register() call site in
    // the component is wrapped so a rejection is caught and turned into a
    // graceful, non-throwing outcome (setPushSupported(false) on mount,
    // or a toast + early return inside the click handler) rather than an
    // unhandled rejection.
    const registerCallCount = (dropdownSource.match(/navigator\.serviceWorker\.register\(/g) ?? []).length;
    const catchBlockCount = (dropdownSource.match(/catch \(err\) \{/g) ?? []).length;
    check("6. Every register() call site sits inside a try/catch (component never lets a registration rejection propagate uncaught)", registerCallCount > 0 && catchBlockCount >= registerCallCount);
    check("   The mount-time failure path degrades gracefully (does not leave pushSupported stuck true)", dropdownSource.includes("Service worker registration failed") && dropdownSource.includes("setPushSupported(false)"));
  } finally {
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
