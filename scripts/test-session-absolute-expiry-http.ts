/**
 * Real HTTP-level proof that the absolute 8h session boundary is enforced
 * server-side — a crafted-but-genuinely-decryptable session cookie (using
 * the SAME `next-auth/jwt` encode() and `AUTH_SECRET` the real app uses) is
 * sent to a running dev server; this proves the actual middleware/callback
 * pipeline rejects it, not a re-implementation of the same logic.
 *
 * Requires a dev server running at http://localhost:3000 (`npm run dev`) —
 * skips (not fails) if unreachable, matching this repo's existing
 * live-server test scripts' convention.
 *
 * Usage: npx tsx scripts/test-session-absolute-expiry-http.ts
 */
import { encode } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { computeAbsoluteSessionExpiry } from "@/lib/session-expiry";

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

const BASE_URL = "http://localhost:3000";
const COOKIE_NAME = "authjs.session-token"; // dev/non-secure default — see @auth/core's defaultCookies()

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE_URL, { redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function craftCookie(payload: Record<string, unknown>): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET not set");
  const jwt = await encode({ token: payload, secret, salt: COOKIE_NAME, maxAge: 8 * 60 * 60 });
  return `${COOKIE_NAME}=${jwt}`;
}

async function main() {
  if (!(await isServerUp())) {
    console.log("No dev server reachable at " + BASE_URL + " — skipping (run `npm run dev` first).");
    process.exit(0);
  }

  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping (need a real user to craft a valid-session sanity check).");
    process.exit(0);
  }

  const realUser = await prisma.user.findFirst({
    where: { isActive: true },
    select: { id: true, email: true, name: true, role: true, mustChangePassword: true, departmentId: true, businessUnitId: true, customRoleId: true, microsoftUserId: true, globalRoleSource: true },
  });
  if (!realUser) {
    console.log("No active user found in this DB — skipping.");
    await prisma.$disconnect();
    process.exit(0);
  }

  const now = Date.now();
  const basePayload = {
    sub: realUser.id,
    email: realUser.email,
    name: realUser.name,
    id: realUser.id,
    role: realUser.role,
    isActive: true,
    mustChangePassword: realUser.mustChangePassword,
    departmentId: realUser.departmentId,
    businessUnitId: realUser.businessUnitId,
    customRoleId: realUser.customRoleId,
    microsoftUserId: realUser.microsoftUserId,
    globalRoleSource: realUser.globalRoleSource,
  };

  try {
    console.log("\n=== 8. Protected API returns 401 SESSION_EXPIRED after the 8h absolute boundary ===\n");
    const expiredLoginAt = now - 9 * 60 * 60 * 1000; // logged in 9h ago
    const expiredCookie = await craftCookie({ ...basePayload, loginAt: expiredLoginAt, absoluteSessionExpiresAt: computeAbsoluteSessionExpiry(expiredLoginAt) });

    const apiRes = await fetch(`${BASE_URL}/api/organization/me`, { headers: { Cookie: expiredCookie }, redirect: "manual" });
    check("expired session on a protected API route -> HTTP 401 (never a generic 500)", apiRes.status === 401);
    let apiBody: any = null;
    try {
      apiBody = await apiRes.json();
    } catch {
      // handled by the check below
    }
    check("401 body is valid JSON with a stable SESSION_EXPIRED code", apiBody?.code === "SESSION_EXPIRED" || apiBody?.error?.code === "SESSION_EXPIRED");

    console.log("\n=== 9. Protected page redirects to /login with the session_expired reason ===\n");
    const pageRes = await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: expiredCookie }, redirect: "manual" });
    check("expired session on a protected page -> a redirect response (3xx)", pageRes.status >= 300 && pageRes.status < 400);
    const location = pageRes.headers.get("location") ?? "";
    check("redirect target is the login page", location.includes("/login"));
    check("redirect carries the session_expired reason so the login page can show the required message", location.includes("session_expired"));

    console.log("\n=== Sanity: genuinely never-authenticated (no cookie at all) still gets the pre-existing generic behavior ===\n");
    const noCookieRes = await fetch(`${BASE_URL}/dashboard`, { redirect: "manual" });
    check("no cookie at all -> still a redirect to /login (unaffected, pre-existing behavior)", noCookieRes.status >= 300 && noCookieRes.status < 400);
    const noCookieLocation = noCookieRes.headers.get("location") ?? "";
    check("no cookie at all -> redirect does NOT claim session_expired (never authenticated is not the same as expired)", !noCookieLocation.includes("session_expired"));

    console.log("\n=== Sanity: a genuinely VALID (non-expired) crafted session is accepted end-to-end ===\n");
    const validLoginAt = now - 30 * 60 * 1000; // logged in 30 minutes ago — well within the 8h window
    const validCookie = await craftCookie({ ...basePayload, loginAt: validLoginAt, absoluteSessionExpiresAt: computeAbsoluteSessionExpiry(validLoginAt) });
    const validRes = await fetch(`${BASE_URL}/api/organization/me`, { headers: { Cookie: validCookie }, redirect: "manual" });
    check("a valid, non-expired crafted session reaches the route handler and succeeds (200) — proves the mechanism isn't just rejecting everything", validRes.status === 200);
    if (validRes.status === 200) {
      const validBody = await validRes.json();
      check("the response reflects the correct signed-in user", validBody?.user?.id === realUser.id);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
