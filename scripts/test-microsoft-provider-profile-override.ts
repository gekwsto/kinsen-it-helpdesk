/**
 * Proves the custom MicrosoftEntraID provider override in lib/auth.config.ts
 * (added to stop the built-in provider's implicit photo fetch — see
 * lib/services/microsoft-profile-photo-service.ts) still preserves every
 * field downstream code actually needs.
 *
 * Two distinct things are verified, because they are RESOLVED DIFFERENTLY
 * by Auth.js and are easy to conflate:
 *
 *  1. `provider.profile(rawProfile, tokens)` — OUR overridden function.
 *     Its return value becomes the transformed `User` object Auth.js's
 *     adapter uses for createUser/account linking. This is the ONLY thing
 *     the override touches. Verified directly against the actual provider
 *     object built by authConfig.
 *
 *  2. The RAW OIDC claims (`oid`, `department`, `groups`, `roles`, etc.) —
 *     these are NEVER passed through `provider.profile()` at all. Per
 *     @auth/core/lib/actions/callback/oauth/callback.js (getUserAndAccount +
 *     its caller), the raw claims object is threaded through completely
 *     independently and is what lib/auth.ts's own `jwt({ profile })`
 *     parameter receives — proven here by reading that exact source file
 *     and asserting the code path, since this is the crux of "did the
 *     override remove anything the department/job-title/groups/roles sync
 *     depends on."
 *
 * Usage: npx tsx scripts/test-microsoft-provider-profile-override.ts
 */
import fs from "fs";
import path from "path";
import { authConfig } from "@/lib/auth.config";

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
  console.log("Test 1: the overridden provider.profile() preserves id/name/email, sets image: null\n");
  const provider = authConfig.providers[0] as unknown as {
    id: string;
    type: string;
    profile: (p: { sub: string; name?: string; email?: string; oid?: string }, tokens: unknown) => unknown;
  };
  check("provider id is still microsoft-entra-id (base object survived the spread)", provider.id === "microsoft-entra-id");
  check("provider type is still oidc (base object survived the spread)", provider.type === "oidc");

  const rawProfile = {
    sub: "11111111-2222-3333-4444-555555555555",
    oid: "11111111-2222-3333-4444-555555555555",
    name: "Test Real User",
    email: "test.real.user@kinsen.gr",
    // Fields that are part of a real Entra ID token but are NOT expected to
    // be read by profile() at all (proven in Test 2 that they still reach
    // the app via a different path).
    department: "Should not be read here",
    groups: ["Should not be read here"],
  };
  const result = (await provider.profile(rawProfile, {})) as { id: string; name?: string; email?: string; image: unknown };

  check("id === profile.sub (becomes Account.providerAccountId — see @auth/core getUserAndAccount)", result.id === rawProfile.sub);
  check("name preserved", result.name === rawProfile.name);
  check("email preserved", result.email === rawProfile.email);
  check("image is explicitly null (never the old implicit base64 photo fetch)", result.image === null);
  check("profile() does NOT itself expose oid/department/groups as top-level User fields (by design — see Test 2)", !("oid" in result) && !("department" in result) && !("groups" in result));

  console.log("\nTest 2: the RAW profile (oid/department/groups/roles) reaches lib/auth.ts's jwt callback via a SEPARATE path, untouched by the override\n");
  // Reads the actual installed @auth/core source (not our own code) to prove
  // the raw claims object is threaded through independently of
  // provider.profile()'s return value — this is a fact about the library
  // our fix depends on, not an assumption, so it's verified from the real
  // installed file rather than just asserted.
  const oauthCallbackPath = path.join(
    process.cwd(),
    "node_modules/@auth/core/lib/actions/callback/oauth/callback.js"
  );
  const source = fs.readFileSync(oauthCallbackPath, "utf8");
  check(
    "installed @auth/core still returns the RAW profile alongside (not instead of) the profile() result",
    /return\s*{\s*\.\.\.profileResult,\s*profile,\s*cookies:/.test(source)
  );
  check(
    "installed @auth/core still calls provider.profile() to build the transformed User separately",
    /const userFromProfile = await provider\.profile\(OAuthProfile, tokens\);/.test(source)
  );

  console.log("\nTest 3: lib/auth.ts still reads oid/department/groups/roles from the `profile` jwt-callback parameter (not from user.*)\n");
  const authTsSource = fs.readFileSync(path.join(process.cwd(), "lib/auth.ts"), "utf8");
  check(
    "lib/auth.ts extracts oid/department/groups/roles from `profile`, the raw-claims jwt-callback param",
    /const msProfile = profile as[\s\S]*?oid\?: string;[\s\S]*?groups\?: string\[\];[\s\S]*?roles\?: string\[\]/.test(authTsSource)
  );
  check(
    "lib/auth.ts passes oid/groups/roles into handleMicrosoftJwtSignIn — department/job-title/role sync is unaffected by the profile() override",
    /oid: msProfile\?\.oid/.test(authTsSource) &&
      /fallbackGroups: msProfile\?\.groups/.test(authTsSource) &&
      /fallbackRoles: msProfile\?\.roles/.test(authTsSource)
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
