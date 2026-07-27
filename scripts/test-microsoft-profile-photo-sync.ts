/**
 * Regression test for the Microsoft profile-photo sync bug: only a
 * brand-new user's very first Microsoft login ever got their photo saved —
 * every returning user's photo was silently discarded, forever, on every
 * login. Root cause: the built-in `next-auth`/`@auth/core` MicrosoftEntraID
 * provider fetches the photo INSIDE its own `profile()` callback and Auth.js
 * only ever persists that field via `createUser` (brand-new user); no other
 * code path ever wrote it. The fix is lib/services/microsoft-profile-photo-service.ts
 * (syncMicrosoftProfilePhoto), called uniformly for every Microsoft sign-in
 * from handleMicrosoftJwtSignIn — this test exercises that function and its
 * integration into handleMicrosoftJwtSignIn directly against a real database.
 *
 * Mocks `fetch` to serve BOTH Graph endpoints handleMicrosoftJwtSignIn's
 * flow calls in one sign-in: GET /me (department/jobTitle sync) and
 * GET /me/photos/48x48/$value (photo sync) — differentiated by URL.
 *
 * Usage: npx tsx scripts/test-microsoft-profile-photo-sync.ts
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * one isn't configured/reachable, rather than failing confusingly.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, AvatarSource } from "@prisma/client";
import { handleMicrosoftJwtSignIn, SYNC_ELIGIBLE_USER_SELECT } from "@/lib/services/microsoft-department-sync-service";
import { syncMicrosoftProfilePhoto } from "@/lib/services/microsoft-profile-photo-service";

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
const testUserIds: string[] = [];

const SAMPLE_JPEG_BASE64_A = Buffer.from("fake-jpeg-bytes-A").toString("base64");
const SAMPLE_JPEG_BASE64_B = Buffer.from("fake-jpeg-bytes-B-different").toString("base64");

type PhotoMockMode =
  | { kind: "ok"; base64: string; etag: string }
  | { kind: "not_modified" }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "rate_limited" }
  | { kind: "server_error" }
  | { kind: "network_error" }
  | { kind: "timeout" };

/** Mocks global fetch for BOTH /me (department sync) and /me/photos/.../$value (photo sync), routed by URL. */
function mockGraph(photoMode: PhotoMockMode, meDepartment: string | null = null, meOid = `test-photo-oid-${RUN_ID}`) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url.includes("/me/photos/")) {
      switch (photoMode.kind) {
        case "ok":
          return new Response(Buffer.from(photoMode.base64, "base64"), {
            status: 200,
            headers: { "content-type": "image/jpeg", etag: photoMode.etag },
          });
        case "not_modified":
          return new Response(null, { status: 304 });
        case "not_found":
          return new Response("Not Found", { status: 404 });
        case "unauthorized":
          return new Response("Unauthorized", { status: 401 });
        case "forbidden":
          return new Response("Forbidden", { status: 403 });
        case "rate_limited":
          return new Response("Too Many Requests", { status: 429 });
        case "server_error":
          return new Response("Server Error", { status: 500 });
        case "network_error":
          throw new TypeError("simulated network failure");
        case "timeout":
          // AbortSignal.timeout() will fire independently of this promise —
          // simulate by never resolving within the test's patience; instead
          // we throw the same DOMException flavor a real timeout produces.
          throw new DOMException("The operation was aborted.", "TimeoutError");
      }
    }

    // GET /me — department/jobTitle sync
    return new Response(
      JSON.stringify({ id: meOid, displayName: "Test Photo User", mail: null, userPrincipalName: null, department: meDepartment, jobTitle: null }),
      { status: 200 }
    );
  }) as typeof fetch;
}

async function createTestUser(data: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `test-photo-sync-${RUN_ID}-${testUserIds.length}@kinsen.gr`,
      authProvider: AuthProvider.MICROSOFT,
      ...data,
    },
  });
  testUserIds.push(user.id);
  return user;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  try {
    console.log("Test 1: brand-new user (no prior image) — photo syncs on this same login\n");
    const newUser = await createTestUser();
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_A, etag: '"etag-a"' });
    const preSync1 = await prisma.user.findUnique({ where: { id: newUser.id }, select: SYNC_ELIGIBLE_USER_SELECT });
    const result1 = await handleMicrosoftJwtSignIn({
      dbUser: preSync1!,
      accessToken: "fake-token",
      oid: `test-photo-oid-${RUN_ID}-1`,
      providerAccountId: `test-photo-oid-${RUN_ID}-1`,
      userEmail: newUser.email,
      userName: "Test Photo User",
    });
    check("new user's image is set from the Graph photo", result1.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);
    const newUserRow = await prisma.user.findUnique({ where: { id: newUser.id } });
    check("avatarSource is MICROSOFT", newUserRow?.avatarSource === AvatarSource.MICROSOFT);
    check("microsoftPhotoEtag stored", newUserRow?.microsoftPhotoEtag === '"etag-a"');
    check("microsoftPhotoUpdatedAt stored", newUserRow?.microsoftPhotoUpdatedAt != null);

    console.log("\nTest 2: existing user with NO photo does a (2nd) Microsoft login — this is the exact reported bug\n");
    const existingNoPhoto = await createTestUser();
    // Simulate "already existed" by NOT going through create — just call
    // handleMicrosoftJwtSignIn again as a returning-user login would.
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_A, etag: '"etag-a"' });
    const preSync2 = await prisma.user.findUnique({ where: { id: existingNoPhoto.id }, select: SYNC_ELIGIBLE_USER_SELECT });
    check("sanity: user starts with no image", preSync2?.image == null);
    const result2 = await handleMicrosoftJwtSignIn({
      dbUser: preSync2!,
      accessToken: "fake-token",
      oid: `test-photo-oid-${RUN_ID}-2`,
      providerAccountId: `test-photo-oid-${RUN_ID}-2`,
      userEmail: existingNoPhoto.email,
      userName: "Test Photo User",
    });
    check("EXISTING user now has the photo after a Microsoft login (the bug is fixed)", result2.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);

    console.log("\nTest 3: existing Microsoft-linked user with an OLD Microsoft photo gets the NEW one\n");
    const existingOldPhoto = await createTestUser({
      image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`,
      avatarSource: AvatarSource.MICROSOFT,
      microsoftPhotoEtag: '"etag-a"',
      microsoftPhotoUpdatedAt: new Date(Date.now() - 60_000),
    });
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_B, etag: '"etag-b"' });
    const photoResult3 = await syncMicrosoftProfilePhoto({ userId: existingOldPhoto.id, accessToken: "fake-token" });
    check("update reported as synced", photoResult3.ok === true && photoResult3.updated === true);
    const row3 = await prisma.user.findUnique({ where: { id: existingOldPhoto.id } });
    check("image updated to the NEW photo", row3?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_B}`);
    check("etag updated", row3?.microsoftPhotoEtag === '"etag-b"');

    console.log("\nTest 4: existing user with a MANUALLY-set avatar is NEVER overwritten\n");
    const manualAvatarUser = await createTestUser({
      image: "data:image/png;base64,manual-upload-data",
      avatarSource: AvatarSource.MANUAL,
    });
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_B, etag: '"etag-b"' });
    const photoResult4 = await syncMicrosoftProfilePhoto({ userId: manualAvatarUser.id, accessToken: "fake-token" });
    check("sync reports protected_manual, no Graph fetch needed to decide", photoResult4.ok === true && !photoResult4.updated && photoResult4.reason === "protected_manual");
    const row4 = await prisma.user.findUnique({ where: { id: manualAvatarUser.id } });
    check("manual image completely untouched", row4?.image === "data:image/png;base64,manual-upload-data");
    check("avatarSource still MANUAL", row4?.avatarSource === AvatarSource.MANUAL);

    console.log("\nTest 5: Microsoft user with NO photo (Graph 404) — login continues, existing photo (if any) is kept\n");
    const noPhotoUser = await createTestUser({
      image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`,
      avatarSource: AvatarSource.MICROSOFT,
      microsoftPhotoEtag: '"etag-a"',
    });
    mockGraph({ kind: "not_found" });
    const photoResult5 = await syncMicrosoftProfilePhoto({ userId: noPhotoUser.id, accessToken: "fake-token" });
    check("404 is reported as a non-error, no update", photoResult5.ok === true && !photoResult5.updated && photoResult5.reason === "not_found");
    const row5 = await prisma.user.findUnique({ where: { id: noPhotoUser.id } });
    check("existing photo is PRESERVED on 404, never deleted", row5?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);

    console.log("\nTest 6: Graph 401/403 — login continues, existing photo untouched\n");
    for (const kind of ["unauthorized", "forbidden"] as const) {
      const user = await createTestUser({ image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`, avatarSource: AvatarSource.MICROSOFT });
      mockGraph({ kind });
      const result = await syncMicrosoftProfilePhoto({ userId: user.id, accessToken: "fake-token" });
      check(`${kind}: reported as a typed failure, not thrown`, result.ok === false && result.reason === kind);
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      check(`${kind}: existing photo untouched`, row?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);
    }

    console.log("\nTest 7: Graph timeout / 500 / network error — login continues, existing photo untouched, no throw\n");
    for (const kind of ["server_error", "network_error", "timeout"] as const) {
      const user = await createTestUser({ image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`, avatarSource: AvatarSource.MICROSOFT });
      mockGraph({ kind });
      let threw = false;
      let result: Awaited<ReturnType<typeof syncMicrosoftProfilePhoto>> | undefined;
      try {
        result = await syncMicrosoftProfilePhoto({ userId: user.id, accessToken: "fake-token" });
      } catch {
        threw = true;
      }
      check(`${kind}: never throws`, threw === false);
      check(`${kind}: reported as a failure result`, result?.ok === false);
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      check(`${kind}: existing photo untouched`, row?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);
    }

    console.log("\nTest 8: login succeeds end-to-end even when ONLY the photo sync fails (500)\n");
    const survivesFailureUser = await createTestUser();
    mockGraph({ kind: "server_error" }); // /me still returns a normal 200 via the fallback branch above
    const preSync8 = await prisma.user.findUnique({ where: { id: survivesFailureUser.id }, select: SYNC_ELIGIBLE_USER_SELECT });
    let handleThrew = false;
    let resultAfterFailure: Awaited<ReturnType<typeof handleMicrosoftJwtSignIn>> | undefined;
    try {
      resultAfterFailure = await handleMicrosoftJwtSignIn({
        dbUser: preSync8!,
        accessToken: "fake-token",
        oid: `test-photo-oid-${RUN_ID}-8`,
        providerAccountId: `test-photo-oid-${RUN_ID}-8`,
        userEmail: survivesFailureUser.email,
        userName: "Test Photo User",
      });
    } catch {
      handleThrew = true;
    }
    check("handleMicrosoftJwtSignIn never throws when only the photo sync fails", handleThrew === false);
    check("sign-in still resolves a user (login not blocked)", resultAfterFailure?.id === survivesFailureUser.id);

    console.log("\nTest 9: ETag match on a 200 response is still treated as unchanged (no redundant write) even without a 304\n");
    const etagGuardUser = await createTestUser({
      image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`,
      avatarSource: AvatarSource.MICROSOFT,
      microsoftPhotoEtag: '"etag-a"',
    });
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_A, etag: '"etag-a"' }); // same etag, 200 not 304
    const etagGuardBefore = await prisma.user.findUnique({ where: { id: etagGuardUser.id } });
    const etagResult = await syncMicrosoftProfilePhoto({ userId: etagGuardUser.id, accessToken: "fake-token" });
    check("same-etag 200 response is treated as unchanged", etagResult.ok === true && !etagResult.updated);
    const etagGuardAfter = await prisma.user.findUnique({ where: { id: etagGuardUser.id } });
    check("microsoftPhotoUpdatedAt not bumped by a no-op sync", etagGuardAfter?.microsoftPhotoUpdatedAt?.getTime() === etagGuardBefore?.microsoftPhotoUpdatedAt?.getTime());

    console.log("\nTest 10: a 304 Not Modified short-circuits without downloading/writing anything\n");
    const notModifiedUser = await createTestUser({
      image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`,
      avatarSource: AvatarSource.MICROSOFT,
      microsoftPhotoEtag: '"etag-a"',
    });
    mockGraph({ kind: "not_modified" });
    const notModifiedResult = await syncMicrosoftProfilePhoto({ userId: notModifiedUser.id, accessToken: "fake-token" });
    check("304 reported as not_modified, no update", notModifiedResult.ok === true && !notModifiedResult.updated && notModifiedResult.reason === "not_modified");

    console.log("\nTest 11: race guard — an OLDER (slower) fetch can never overwrite a NEWER photo already written\n");
    const raceUser = await createTestUser({
      image: `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_B}`,
      avatarSource: AvatarSource.MICROSOFT,
      microsoftPhotoEtag: '"etag-b"',
      // Simulates: a second, faster concurrent login already wrote a NEWER
      // photo with a timestamp in the future relative to when THIS (slower)
      // request's Graph fetch resolves.
      microsoftPhotoUpdatedAt: new Date(Date.now() + 60_000),
    });
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_A, etag: '"etag-a-stale"' });
    const raceResult = await syncMicrosoftProfilePhoto({ userId: raceUser.id, accessToken: "fake-token" });
    check("older/slower request is superseded, not applied", raceResult.ok === true && !raceResult.updated && raceResult.reason === "superseded");
    const raceRowAfter = await prisma.user.findUnique({ where: { id: raceUser.id } });
    check("the NEWER photo (B) survives, the stale request's photo (A) never landed", raceRowAfter?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_B}`);

    console.log("\nTest 12: calling the sync twice in a row for the same login (duplicate-callback simulation) is safe and idempotent\n");
    const duplicateCallUser = await createTestUser();
    mockGraph({ kind: "ok", base64: SAMPLE_JPEG_BASE64_A, etag: '"etag-a"' });
    const first = await syncMicrosoftProfilePhoto({ userId: duplicateCallUser.id, accessToken: "fake-token" });
    const second = await syncMicrosoftProfilePhoto({ userId: duplicateCallUser.id, accessToken: "fake-token" });
    check("first call synced", first.ok === true && first.updated === true);
    check("second call (same login's duplicate callback) is a safe no-op via ETag match", second.ok === true && second.updated === false);
    const dupRow = await prisma.user.findUnique({ where: { id: duplicateCallUser.id } });
    check("exactly one final image value, no corruption from the duplicate call", dupRow?.image === `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64_A}`);

    console.log("\nTest 13: no access token — safe no-op, never throws\n");
    const noTokenUser = await createTestUser();
    const noTokenResult = await syncMicrosoftProfilePhoto({ userId: noTokenUser.id, accessToken: undefined });
    check("no_token reported cleanly", noTokenResult.ok === false && noTokenResult.reason === "no_token");
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["users", () => (testUserIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: testUserIds } } }) : Promise.resolve())],
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
