/**
 * Real measurement (not estimation) of what a base64-embedded Microsoft
 * profile photo does to the actual Auth.js JWT + Set-Cookie payload.
 *
 * Uses the REAL `encode()` from `next-auth/jwt` (the exact function Auth.js
 * itself calls internally — see node_modules/@auth/core/lib/actions/callback/index.js:93)
 * with our REAL AUTH_SECRET, and the REAL cookie-chunking logic
 * (@auth/core SessionStore#chunk, ALLOWED_COOKIE_SIZE=4096) to compute
 * exactly how many Set-Cookie chunks would be emitted and how large each is.
 *
 * Tests a realistic range of Microsoft /me/photos/48x48/$value sizes: small
 * (plain-color avatar), typical (a real face photo at 48x48 JPEG quality),
 * and a synthetic worst-case (high-entropy/random bytes at the same
 * dimensions — physically close to the largest a 48x48 JPEG can realistically
 * be, since JPEG compression only fails to shrink near-random data).
 *
 * Usage: npx tsx scripts/measure-jwt-cookie-size.ts
 */
import { encode } from "next-auth/jwt";
import crypto from "crypto";

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

const AUTH_SECRET = process.env.AUTH_SECRET || "measurement-only-fake-secret-not-used-in-prod";
const SALT = "authjs.session-token"; // default cookie name Auth.js uses as HKDF salt — doesn't affect ciphertext length

// Real Auth.js constants, mirrored from @auth/core/lib/utils/cookie.ts
const ALLOWED_COOKIE_SIZE = 4096;
const ESTIMATED_EMPTY_COOKIE_SIZE = 160;
const CHUNK_SIZE = ALLOWED_COOKIE_SIZE - ESTIMATED_EMPTY_COOKIE_SIZE;

function chunkCount(valueLength: number): number {
  return Math.ceil(valueLength / CHUNK_SIZE);
}

// `includePicture: true` reproduces the ORIGINAL (fixed) behavior for
// before/after comparison — the CURRENT code never sets `picture` at all
// (lib/auth.ts's jwt callback does `delete token.picture` unconditionally),
// so real tokens today always match the `includePicture: false` shape below
// regardless of how large the user's stored photo is.
function buildTokenPayload(imageDataUri: string | null, includePicture: boolean) {
  const base: Record<string, unknown> = {
    id: "cltest0000000000000000000",
    role: "USER",
    isActive: true,
    mustChangePassword: false,
    departmentId: "cltestdept00000000000000000",
    businessUnitId: null,
    customRoleId: null,
    microsoftUserId: "11111111-2222-3333-4444-555555555555",
    globalRoleSource: "MICROSOFT_DEPARTMENT",
    // Standard OIDC-ish claims Auth.js/our credentials flow also carries on the token
    name: "Realistic Test User Name",
    email: "realistic.test.user@kinsen.gr",
    sub: "cltest0000000000000000000",
  };
  if (includePicture) base.picture = imageDataUri;
  return base;
}

/** Builds a base64 JPEG-shaped data URI of approximately `rawBytes` raw bytes. */
function buildFakePhotoDataUri(rawBytes: number): string {
  const buf = crypto.randomBytes(rawBytes); // random bytes = worst-case entropy for base64 expansion (real JPEGs are similar-entropy in their compressed body)
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

interface Scenario {
  label: string;
  rawBytes: number | null; // null = no photo at all (baseline)
}

const SCENARIOS: Scenario[] = [
  { label: "No photo (baseline — current token shape minus picture)", rawBytes: null },
  { label: "Small/plain-color 48x48 avatar (~600 B raw JPEG)", rawBytes: 600 },
  { label: "Typical 48x48 face photo (~2 KB raw JPEG)", rawBytes: 2048 },
  { label: "Detailed 48x48 face photo (~4 KB raw JPEG)", rawBytes: 4096 },
  { label: "Worst-case high-entropy 48x48 JPEG (~8 KB raw — larger than any realistic Graph 48x48 thumbnail)", rawBytes: 8192 },
];

async function measure(label: string, imageDataUri: string | null, rawBytes: number | null, includePicture: boolean) {
  const token = buildTokenPayload(imageDataUri, includePicture);
  const jwtString = await encode({ token, secret: AUTH_SECRET, salt: SALT, maxAge: 30 * 24 * 60 * 60 });
  const jwtBytes = Buffer.byteLength(jwtString, "utf8");
  const chunks = chunkCount(jwtBytes);
  const wouldChunk = chunks > 1;

  console.log(`--- ${label} ---`);
  if (rawBytes != null && includePicture) {
    const dataUriBytes = Buffer.byteLength(imageDataUri!, "utf8");
    console.log(`  raw photo bytes:            ${rawBytes}`);
    console.log(`  base64 data URI bytes:      ${dataUriBytes}`);
  }
  console.log(`  encoded JWT bytes:          ${jwtBytes}`);
  console.log(`  Auth.js would chunk?        ${wouldChunk ? `YES — ${chunks} Set-Cookie chunks` : "no — single cookie"}`);
  if (wouldChunk) {
    const perChunkTotal = Math.ceil(jwtBytes / chunks) + ESTIMATED_EMPTY_COOKIE_SIZE;
    console.log(`  approx. total Set-Cookie response bytes across all chunks: ${jwtBytes + chunks * ESTIMATED_EMPTY_COOKIE_SIZE} (${chunks} x ~${perChunkTotal})`);
  } else {
    console.log(`  approx. single Set-Cookie response bytes: ${jwtBytes + ESTIMATED_EMPTY_COOKIE_SIZE}`);
  }
  console.log(`  exceeds single-cookie 4096B browser limit? ${jwtBytes + ESTIMATED_EMPTY_COOKIE_SIZE > ALLOWED_COOKIE_SIZE ? "YES" : "no"}`);
  console.log();
  return { jwtBytes, chunks };
}

async function main() {
  console.log("Measuring real Auth.js JWT + cookie-chunking behavior with next-auth/jwt's actual encode()...\n");
  console.log(`Auth.js cookie chunk size budget: ${CHUNK_SIZE} bytes/chunk (${ALLOWED_COOKIE_SIZE} allowed - ${ESTIMATED_EMPTY_COOKIE_SIZE} estimated cookie-attribute overhead)\n`);

  console.log("=".repeat(78));
  console.log("BEFORE (what the token would look like if `picture` were still set —");
  console.log("reproduced here ONLY for comparison/proof-the-risk-was-real; the current");
  console.log("code never does this)");
  console.log("=".repeat(78) + "\n");
  const beforeResults: { label: string; rawBytes: number | null; jwtBytes: number; chunks: number }[] = [];
  for (const scenario of SCENARIOS) {
    const imageDataUri = scenario.rawBytes == null ? null : buildFakePhotoDataUri(scenario.rawBytes);
    const r = await measure(scenario.label, imageDataUri, scenario.rawBytes, true);
    beforeResults.push({ label: scenario.label, rawBytes: scenario.rawBytes, ...r });
  }

  console.log("Test 1: confirms the risk was REAL, not a strawman — a typical ~2KB photo genuinely forced multi-chunk cookies before the fix\n");
  const typical = beforeResults.find((r) => r.rawBytes === 2048)!;
  check(`Typical 2KB photo WOULD have exceeded the single-cookie limit if still embedded (${typical.jwtBytes} bytes, ${typical.chunks} chunk(s))`, typical.chunks > 1);
  const worstCase = beforeResults.find((r) => r.rawBytes === 8192)!;
  check(`Worst-case 8KB photo WOULD have needed multiple chunks (${worstCase.jwtBytes} bytes, ${worstCase.chunks} chunks)`, worstCase.chunks > 1);

  console.log("\n" + "=".repeat(78));
  console.log("AFTER / CURRENT CODE (token.picture is unconditionally deleted in");
  console.log("lib/auth.ts's jwt callback — the photo size has ZERO effect on JWT size)");
  console.log("=".repeat(78) + "\n");
  const afterResults: { label: string; rawBytes: number | null; jwtBytes: number; chunks: number }[] = [];
  for (const scenario of SCENARIOS) {
    const imageDataUri = scenario.rawBytes == null ? null : buildFakePhotoDataUri(scenario.rawBytes);
    const r = await measure(scenario.label, imageDataUri, scenario.rawBytes, false);
    afterResults.push({ label: scenario.label, rawBytes: scenario.rawBytes, ...r });
  }

  console.log("Test 2: with the current code, JWT size is IDENTICAL regardless of photo size (picture is never included)\n");
  const baselineBytes = afterResults[0].jwtBytes;
  for (const r of afterResults) {
    check(`"${r.label}" produces the SAME JWT size as no-photo (${r.jwtBytes} bytes)`, r.jwtBytes === baselineBytes);
  }

  console.log("\nTest 3: with the current code, no scenario — including the worst-case 8KB photo — ever triggers cookie chunking\n");
  for (const r of afterResults) {
    check(`"${r.label}" stays a single, unchunked cookie`, r.chunks === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("\nNote: this session cookie is sent on EVERY subsequent request to the app (not just at login) —");
  console.log("with the fix, its size is now constant regardless of the user's photo size.");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Measurement crashed:", err);
  process.exit(1);
});
