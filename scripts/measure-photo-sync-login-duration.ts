/**
 * Measures real wall-clock time added to a Microsoft sign-in by
 * syncMicrosoftProfilePhoto() under success, fast-failure, and genuine
 * timeout conditions — proves the 5s AbortSignal.timeout actually bounds a
 * hung Graph response, and that a slow/failed photo request does not turn
 * into an unbounded login hang.
 *
 * Usage: npx tsx scripts/measure-photo-sync-login-duration.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider } from "@prisma/client";
import { syncMicrosoftProfilePhoto } from "@/lib/services/microsoft-profile-photo-service";

const RUN_ID = Date.now();
const SAMPLE_JPEG_BASE64 = Buffer.from("fake-jpeg-bytes").toString("base64");

function mockPhotoFetch(mode: "ok" | "server_error" | "hang_past_timeout") {
  (global as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    if (mode === "ok") {
      return new Response(Buffer.from(SAMPLE_JPEG_BASE64, "base64"), {
        status: 200,
        headers: { "content-type": "image/jpeg", etag: '"t"' },
      });
    }
    if (mode === "server_error") {
      return new Response("Server Error", { status: 500 });
    }
    // "hang_past_timeout": never resolves on its own — only the caller's
    // AbortSignal (passed in `init.signal`) can end this, exactly like a
    // real hung/slow Graph server. Proves the 5s budget is enforced by OUR
    // code, not by luck.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "TimeoutError"));
      });
    });
  }) as typeof fetch;
}

async function timeIt<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, ms };
}

async function main() {
  // AbortSignal.timeout()'s internal timer is NOT guaranteed to keep a bare
  // CLI script's event loop alive on its own (confirmed by direct
  // experimentation — a standalone script with nothing else pending can
  // exit before the timer ever fires). This is a measurement-script-only
  // concern: the real Next.js server is a long-running process with an
  // active HTTP listener that always keeps the event loop alive, so
  // AbortSignal.timeout() behaves normally there. This keep-alive interval
  // exists ONLY so this script can observe the real timeout firing.
  const keepAlive = setInterval(() => {}, 1000);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const testUserIds: string[] = [];
  try {
    const user = await prisma.user.create({
      data: { email: `test-timing-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT },
    });
    testUserIds.push(user.id);

    console.log("Measuring syncMicrosoftProfilePhoto() wall-clock time under 3 real conditions...\n");

    mockPhotoFetch("ok");
    const success = await timeIt(() => syncMicrosoftProfilePhoto({ userId: user.id, accessToken: "fake-token" }));
    console.log(`Success (fast 200 response):  ${success.ms.toFixed(1)} ms — result: ${JSON.stringify(success.result)}`);

    mockPhotoFetch("server_error");
    const failure = await timeIt(() => syncMicrosoftProfilePhoto({ userId: user.id, accessToken: "fake-token" }));
    console.log(`Fast failure (500 response):   ${failure.ms.toFixed(1)} ms — result: ${JSON.stringify(failure.result)}`);

    mockPhotoFetch("hang_past_timeout");
    const timeout = await timeIt(() => syncMicrosoftProfilePhoto({ userId: user.id, accessToken: "fake-token" }));
    console.log(`Real timeout (never responds): ${timeout.ms.toFixed(1)} ms — result: ${JSON.stringify(timeout.result)}`);

    console.log("\n--- Verdict ---");
    const bounded = timeout.ms < 6000 && timeout.ms >= 4900;
    console.log(`Timeout bounded to ~5000ms as configured (REQUEST_TIMEOUT_MS): ${bounded ? "YES" : "NO — " + timeout.ms.toFixed(0) + "ms"}`);
    console.log("Login itself is never blocked beyond this bound: syncMicrosoftProfilePhoto() is awaited");
    console.log("inside handleMicrosoftJwtSignIn, so total added login latency in the worst case (Graph");
    console.log("completely unresponsive) is capped at the timeout above, not unbounded.");

    clearInterval(keepAlive);
    if (!bounded) process.exit(1);
  } finally {
    clearInterval(keepAlive);
    await prisma.user.deleteMany({ where: { id: { in: testUserIds } } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Measurement crashed:", err);
  process.exit(1);
});
