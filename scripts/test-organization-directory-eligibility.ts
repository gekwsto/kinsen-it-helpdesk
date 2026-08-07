/**
 * lib/services/organization-directory-eligibility-service.ts — the single,
 * shared @kinsen.gr organization-sync eligibility rule (FIND-003, see
 * docs/roadmap-handoff-register.md). Pure functions, no DB/network — every
 * case from the FIND-003 spec's explicit domain-matching test list.
 *
 * Usage: npx tsx scripts/test-organization-directory-eligibility.ts
 */
import { getOrganizationDirectoryEligibility, isEligibleOrganizationDirectoryUser } from "@/lib/services/organization-directory-eligibility-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

console.log("\n=== Domain matching (FIND-003 explicit test list) ===\n");

check("1. mail=user@kinsen.gr -> eligible", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@kinsen.gr" }));
check("2. mail=USER@KINSEN.GR (mixed case) -> eligible", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "USER@KINSEN.GR" }));
check("3. mail=null, UPN=user@kinsen.gr -> eligible", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: null, userPrincipalName: "user@kinsen.gr" }));
check("4. mail=user@kinsen.gr, UPN=user@tenant.onmicrosoft.com -> eligible (mail matches)", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@kinsen.gr", userPrincipalName: "user@tenant.onmicrosoft.com" }));
check("5. mail=user@other.com, UPN=user@kinsen.gr -> eligible (UPN matches)", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@other.com", userPrincipalName: "user@kinsen.gr" }));
check("6. mail=user@other.com, UPN=user@tenant.onmicrosoft.com -> NOT eligible (neither matches)", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@other.com", userPrincipalName: "user@tenant.onmicrosoft.com" }));
check("7. user@fakekinsen.gr -> NOT eligible (no real '@kinsen.gr' suffix)", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@fakekinsen.gr" }));
check("8. user@kinsen.gr.evil.com -> NOT eligible (suffix is '.evil.com', not '@kinsen.gr')", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@kinsen.gr.evil.com" }));
check("9. Guest with an @kinsen.gr mail -> NOT eligible (userType wins over domain)", !isEligibleOrganizationDirectoryUser({ userType: "Guest", mail: "external@kinsen.gr" }));
check("10. null mail + null UPN -> NOT eligible", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: null, userPrincipalName: null }));

console.log("\n=== Additional edge cases ===\n");

check("Leading/trailing whitespace is trimmed before matching", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "  user@kinsen.gr  " }));
check("Missing userType (absent, not 'Guest') is NOT treated as evidence of guest — domain still decides", isEligibleOrganizationDirectoryUser({ mail: "user@kinsen.gr" }));
check("userType present but not exactly 'Member' (e.g. lowercase 'member') -> NOT eligible — only a genuinely ABSENT userType is exempt from this check, not a differently-cased/malformed value", !isEligibleOrganizationDirectoryUser({ userType: "member", mail: "user@kinsen.gr" }));
check("Empty-string mail treated as absent, falls through to UPN", isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "", userPrincipalName: "user@kinsen.gr" }));
check("A domain that merely CONTAINS 'kinsen.gr' but not as an '@' suffix -> NOT eligible", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "kinsen.gr@other.com" }));
check("Subdomain of kinsen.gr (not the literal apex domain) -> NOT eligible unless it IS the configured domain", !isEligibleOrganizationDirectoryUser({ userType: "Member", mail: "user@mail.kinsen.gr" }));

console.log("\n=== getOrganizationDirectoryEligibility reason codes (for distinct usersSkippedDomain/usersSkippedGuest counters) ===\n");

const guestResult = getOrganizationDirectoryEligibility({ userType: "Guest", mail: "a@kinsen.gr" });
check("Guest -> reason 'not_member'", !guestResult.eligible && guestResult.reason === "not_member");

const domainResult = getOrganizationDirectoryEligibility({ userType: "Member", mail: "a@other.com" });
check("Wrong domain -> reason 'no_matching_domain'", !domainResult.eligible && domainResult.reason === "no_matching_domain");

const eligibleResult = getOrganizationDirectoryEligibility({ userType: "Member", mail: "Maria@Kinsen.GR" });
check("Eligible result carries the normalized matchedEmail", eligibleResult.eligible && eligibleResult.matchedEmail === "maria@kinsen.gr");

printSummaryAndExit();
