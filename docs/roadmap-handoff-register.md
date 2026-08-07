# Roadmap / Handoff Findings Register

Tracks architectural findings discovered during audits/implementation work
that are out of scope for the change that discovered them, so they are never
left only in a chat transcript. Each entry: ID, exact finding, reproduction/
evidence, impact, target phase, acceptance test, source artifact, closure
status.

**Note on this file's origin:** no pre-existing `docs/roadmap-handoff-register.md`
was found in this repository when this update was requested — it did not
exist before this entry was created. It is being established now with the
findings relevant as of this session; it does not retroactively include
every finding from every prior session's chat-only reports.

---

## FIND-001 — User.departmentId could be written by Microsoft Directory Sync without ever creating a matching DepartmentMembership

- **Exact finding:** `organization-directory-sync-service.ts`'s multi-company
  placement resolver (`resolveOrganizationPlacement`) wrote `User.departmentId`
  directly and unconditionally on every sync. Separately, the same sync run
  called the older `MicrosoftDepartmentMapping`-based `resolveDepartmentMemberships`
  / `syncDepartmentMemberships`, which only creates a `DepartmentMembership`
  row when an admin has configured an explicit mapping for the exact Entra
  value — never true for a department auto-created by the multi-company
  resolver. Result: a user could have `User.departmentId` pointing at a real
  department with **zero** `DepartmentMembership` rows for it — and since
  ticket/project authorization (`department-scope-service.ts`) reads
  exclusively from `DepartmentMembership`, such a user had **no real access**
  to their own organizationally-placed department.
- **Reproduction/evidence:** confirmed via code trace (both call sites read
  in full) and empirically reproduced in
  `scripts/test-organization-sync-primary-membership.ts` before the fix
  (test 9 failed: "brand-new Microsoft user got created but no active
  PRIMARY DepartmentMembership existed").
- **Impact:** high — silent, invisible loss of department access for any
  user placed via the multi-company Microsoft Directory Sync resolver.
- **Target phase:** this session (Phase 2 of the User/Department/Member
  canonical-membership work).
- **Acceptance test:** `scripts/test-organization-sync-primary-membership.ts`
  (tests 9-12) — a brand-new/existing Microsoft-synced user always gets an
  active PRIMARY `DepartmentMembership` matching `User.departmentId`, in the
  same sync run.
- **Source artifact:** `lib/services/department-membership-service.ts`
  (`setPrimaryDepartmentMembership`), `lib/services/organization-directory-sync-service.ts`.
- **Closure status:** **CLOSED** — fixed by routing all `User.departmentId`
  writes through the new canonical `setPrimaryDepartmentMembership`; verified
  by the acceptance test above and the database invariant audit
  (`scripts/audit-user-department-membership-invariants.ts`, invariants 1/2/3/6,
  all passing on the dev database after reconciliation).

---

## FIND-002 — Three different screens computed "how many users in this department" three different, disagreeing ways

- **Exact finding:** the Organization tree unioned `User.departmentId`
  matches with ALL active `DepartmentMembership` rows (primary + secondary);
  the admin Departments list counted only `User.departmentId` matches
  (`Department._count.users`); the Department Members page counted only
  `DepartmentMembership` rows. A user with only a secondary membership
  appeared as a "Member" but not a "User", and vice versa for organizational
  placement.
- **Reproduction/evidence:** live DB query in the original audit turn found
  `pavlos.chatzisavvas@kinsen.gr` with `User.departmentId = IT` and a
  secondary `Finance` membership — Departments list showed Finance=0 users,
  Members page showed Finance=1 member, both technically "correct" for what
  they each measured, but visibly contradictory to an admin.
- **Impact:** medium — confusing/contradictory admin UI numbers, no data
  corruption, but real operator confusion (this is what the user originally
  reported as "the department shows users in the tree but 0 Members").
- **Target phase:** this session.
- **Acceptance test:** `scripts/test-director-multi-department-authorization.ts`
  (test 8) — a user with only a secondary membership in a department does
  NOT count toward that department's Organization-tree placement, while
  still fully counting for authorization and the Members page.
- **Source artifact:** `lib/services/organization-tree-service.ts`
  (`loadDepartmentUserAssociations`, now primary-only).
- **Closure status:** **CLOSED** for the Organization tree vs. Members page
  distinction (now deliberately different by design, documented in both
  services' header comments). The admin Departments list's `_count.users`
  query was intentionally left unchanged — since `User.departmentId` is now
  a correctly-maintained mirror of the active primary membership, that count
  is automatically equivalent to "primary membership count" going forward,
  with no code change needed there.

---

## FIND-003 — @kinsen.gr domain filtering for Microsoft Directory Sync

- **Exact finding:** Microsoft Directory Sync had zero domain-based
  filtering — every `userType: "Member"` account in the tenant was synced,
  regardless of email domain or `companyName`. Also, the per-login Microsoft
  sync's PRIMARY department placement was driven by an entirely separate
  mechanism (`MicrosoftDepartmentMapping`/`resolvePrimaryMicrosoftMapping`)
  than the full Directory Sync's multi-company `companyName`/`department`
  resolver — meaning a first Microsoft login and a full sync could place the
  same person differently.
- **Implementation (this session):**
  - New shared, unit-tested rule:
    `lib/services/organization-directory-eligibility-service.ts`
    (`getOrganizationDirectoryEligibility`/`isEligibleOrganizationDirectoryUser`)
    — `userType === "Member"` AND (`mail` OR `userPrincipalName` ends with
    `@<ALLOWED_EMAIL_DOMAIN>`, case-insensitive, strict `@domain` suffix
    boundary, reusing the same env var `lib/auth.ts`'s authentication gate
    already reads).
  - `organization-directory-sync-service.ts`'s `validateDirectoryUser` now
    applies this rule (new `domain_not_eligible` reason, alongside the
    existing `guest_or_service_account`); new granular in-memory counters
    (`usersEligible`, `usersSkippedDomain`, `usersSkippedGuest`,
    `usersCreatedCount`, `usersUpdatedCount`) added additively — the
    persisted `OrganizationSyncRun` DB contract (`usersScanned`,
    `usersUpdated`, `usersSkipped`, `errorCount`) is unchanged, no migration.
  - `microsoft-department-sync-service.ts`'s login flow now fetches
    `companyName`/`userType`/`givenName`/`surname` too (`GET /me` `$select`
    extended — same delegated `User.Read` scope, no new Azure permission)
    and, when eligible, resolves PRIMARY placement via the SAME
    `organization-company-department-resolver.ts` multi-company resolver
    the full sync uses (never `MicrosoftDepartmentMapping` for primary
    anymore) — converging both entry points on identical organizational
    placement for the same profile. `MicrosoftDepartmentMapping` remains
    exactly as it was for SECONDARY memberships and the independent global-
    role decision.
  - Existing non-eligible local users (already in the DB from before, or
    never matching at all): completely untouched — `validateDirectoryUser`
    rejecting a record means `upsertOneDirectoryUser` is never called for
    it, so their existing row/memberships/roles are never written to.
- **Reproduction/evidence:** `scripts/test-organization-directory-eligibility.ts`
  (19/19), `scripts/test-organization-sync-convergence-and-safety.ts`
  (25/25 — proves full-sync/first-login convergence AND non-Kinsen safety
  in one file), `scripts/test-microsoft-first-login-sync.ts` (51/51,
  substantially rewritten for the new primary-placement mechanism),
  `scripts/test-organization-multicompany-sync.ts` (40/40, fixtures moved
  to `@kinsen.gr`), `scripts/test-organization-sync-primary-membership.ts`
  (18/18). Live read-only dev-DB audit: 6/7 users have `@kinsen.gr` email,
  3 have an active primary membership with `User.departmentId` mirroring it
  exactly, 0 duplicate normalized emails, 0 users with >1 active primary.
- **Impact:** resolved — organization sync now only processes real
  `@<ALLOWED_EMAIL_DOMAIN>` identities, via one converged placement
  mechanism for both full sync and login.
- **Target phase:** this session — complete.
- **Acceptance test:** all tests listed above, green; full regression suite
  green twice in a row (see final report).
- **Source artifact:** `lib/services/organization-directory-eligibility-service.ts`,
  `lib/services/organization-directory-sync-service.ts`,
  `lib/services/microsoft-department-sync-service.ts`.
- **Closure status:** **CLOSED**. **Not verified against a real Microsoft
  tenant** — this environment's Graph credentials remain dummy values (see
  `docs/microsoft-production-readiness-audit.md`); all Graph interaction in
  the tests above is mocked. In particular, whether `companyName`/`userType`
  are actually readable via delegated `User.Read` on `GET /me` for this
  app registration is an assumption consistent with Microsoft Graph's
  documented basic-profile-property behavior, not something confirmed
  against a live tenant here.

---

## FIND-004 — No admin-facing surfacing of an unresolved dual-primary-membership conflict

- **Exact finding:** `department-membership-reconciliation-service.ts`'s
  `F_conflict` category (a user with 2+ active primary memberships, no
  single MANUAL tiebreak) is correctly never auto-corrected — but today the
  only way to discover one exists is manually re-running
  `scripts/reconcile-user-department-membership.ts` (dry-run) and reading
  its console output. There is no admin UI alert, scheduled check, or
  monitoring hook.
- **Reproduction/evidence:** by design — see
  `scripts/test-reconcile-user-department-membership.ts` (test 20), which
  proves the conflict is reported, not silently fixed, but that "reported"
  today means "printed to a script's stdout."
- **Impact:** low today (zero such conflicts exist in the current dev
  database, confirmed via the invariant audit) — but would be a silent gap
  if one arose in production, since nothing currently surfaces it
  proactively.
- **Target phase:** future, separate from this session's scope.
- **Acceptance test:** not yet written — would need an admin-visible
  surface (e.g. an admin dashboard warning, or wiring the reconciliation
  dry-run into a scheduled health check) to close.
- **Source artifact:** `lib/services/department-membership-reconciliation-service.ts`.
- **Closure status:** **OPEN** — new finding from this session, genuinely
  out of scope for the write-path fix itself.

---

## FIND-005 — Microsoft Job Title auto-discovery: domain filtering, admin visibility, and reuse of the existing mapping engine

- **Exact finding (pre-existing gap, found during this feature's audit):**
  `MicrosoftDepartmentMapping` already supported `PROFILE_JOB_TITLE` as a
  `sourceType`, already resolved identically for full sync and first login
  (`resolveDepartmentMemberships`/`resolvePrimaryMicrosoftMapping`), and
  `MicrosoftDirectoryJobTitleValue` already cached distinct job title values
  to back the mapping form's dropdown — but that discovery scan
  (`fetchAllGraphUserDirectoryValues`, Operation B) had **zero domain/userType
  filtering**: any tenant user's job title (including Guests and, in a
  future multi-domain tenant, another company entirely) could populate the
  admin dropdown, inconsistent with the `@kinsen.gr`-only policy FIND-003
  already established for organizational sync. There was also no admin
  visibility into how many real users currently hold a discovered title, or
  whether it already has a configured mapping.
- **Implementation (this session):**
  - `fetchAllGraphUserDirectoryValues` (`microsoft-directory-service.ts`) now
    applies the SAME shared `getOrganizationDirectoryEligibility` rule
    FIND-003 established — a job title/department value is only collected
    from an eligible (`userType: "Member"`, `@<ALLOWED_EMAIL_DOMAIN>`) user.
    Non-configured-domain Member accounts are reported (`otherDomainsObserved`),
    never processed.
  - `MicrosoftDirectoryJobTitleValue` extended (additive migration
    `20260807110000_job_title_directory_domain_scope`) with `domain`,
    `normalizedValue` (trim+collapse-space+lowercase), and `userCount`,
    upserted by the compound key `(domain, normalizedValue)` — ready for a
    future multi-domain tenant with zero redesign, since each domain gets
    its own row even when the raw text collides. The pre-existing
    `value`-only unique index and the pre-existing Operation A/B write paths
    (`upsertDiscoveredMicrosoftDirectoryValue`, the legacy combined
    department+jobTitle admin sync) were kept fully intact for the
    Department table and adapted (not replaced) for the Job Title table —
    Operation A's jobTitle branch now upserts by the compound key too
    (wrapped in try/catch: a cache-fill must never break a real Microsoft
    sign-in), closing a real compound-unique collision risk the schema
    change would otherwise have introduced for two distinct titles cached
    opportunistically after the same migration.
  - New composition-only service `microsoft-job-title-directory-service.ts`:
    `syncMicrosoftJobTitleDirectory` (a job-title-focused summary wrapper
    around the SAME existing `syncMicrosoftDirectoryValues` scan — no
    duplicate Graph traffic) and `listJobTitleDirectoryForAdmin` (joins the
    domain-scoped value cache against active `PROFILE_JOB_TITLE` mappings,
    case/whitespace-insensitively, matching `microsoft-mapping-service.ts`'s
    own matching rule exactly, so the admin never sees a "configured" status
    that sync/login would actually disagree with).
  - New admin routes `GET/POST /api/admin/microsoft-directory/job-titles`
    (`/sync`), and a new "Job Titles — Auto-Discovery" panel on
    `/admin/microsoft-mappings` (`components/admin/microsoft-mapping-management.tsx`):
    per-title user count, Configured/Not Configured badge (with the target
    department + role when configured), a "Map" quick action prefilling the
    existing Add Mapping dialog, and a dedicated "Sync Microsoft Job Titles"
    button with its own loading/toast/summary — deliberately calling the
    SAME underlying sync as the pre-existing generic "Sync directory values"
    button (one Graph scan, two purpose-fit summaries), not a parallel
    discovery mechanism.
  - The actual permission-mapping engine (`MicrosoftDepartmentMapping`,
    `createMapping`/`updateMapping`, MANUAL-primary protection,
    `shouldSyncGlobalRole`) was **not duplicated or modified** — this
    feature is purely a richer discovery/visibility layer on top of it, per
    the explicit audit-first requirement. Organization placement
    (Company/Department/primary DepartmentMembership,
    `setPrimaryDepartmentMembership`) is untouched and structurally
    unreachable from any file this feature added.
- **Reproduction/evidence:** `scripts/test-microsoft-job-title-directory.ts`
  (32/32 — normalization, domain/userType filtering, idempotent compound-key
  sync, staling/reactivation, Operation A collision-safety regression,
  admin listing's configured-status join), `scripts/test-microsoft-first-login-sync.ts`
  (51/51, Case 5 fixture updated for the new eligibility filter + the
  intentional case-insensitive job-title dedup semantic change — see the
  test's own updated comment), full regression suite 107/107 twice,
  `scripts/audit-job-title-directory-invariants.ts` (6/6),
  `scripts/audit-user-department-membership-invariants.ts` (4/4, unaffected),
  `scripts/browser-verify-microsoft-job-title-directory.ts` (16/16 — real
  Chromium session against a real running admin UI: discovery panel render,
  Map quick action prefill, mapping creation via the real form, Configured
  badge appearing after reload, and the documented graceful-failure toast
  for the sync button against this environment's dummy Graph credentials).
- **Impact:** resolved — Job Title discovery is now domain-scoped and
  admin-visible (count + configured status), reusing 100% of the existing
  permission-mapping engine.
- **Target phase:** this session — complete for the discovery catalog,
  scoped to `@kinsen.gr` only per explicit instruction.

### Follow-up audit (same session, next turn) — the "multi-domain-ready" claim below was only half true

A targeted re-audit, requested specifically to verify the multi-domain-ready
claim before this finding could be trusted as CLOSED, found the claim was
**correct for the discovery catalog but not for the permission mapping
engine**, and found one real bug in the discovery catalog itself:

1. **Bug found and fixed — discovery catalog still had a global `value`
   unique constraint.** The original migration
   (`20260807110000_job_title_directory_domain_scope`) added the compound
   `@@unique([domain, normalizedValue])` index but **left the pre-existing
   global `@unique` on `value` in place** (copy-pasted from
   `MicrosoftDirectoryDepartmentValue`, which was never given this
   extension). Confirmed via `prisma/schema.prisma`, real Postgres index
   introspection (`pg_indexes`), and an empirical write attempt: with the
   bug present, `domain="kinsen.gr", value="IT Manager"` and
   `domain="kinsen.at", value="IT Manager"` could **not** coexist — the
   second insert violated `MicrosoftDirectoryJobTitleValue_value_key`. This
   directly contradicted the "ready for a future multi-domain tenant"
   claim above. **Fixed** by
   `prisma/migrations/20260807153000_job_title_value_domain_scoped_identity/`
   (drops `MicrosoftDirectoryJobTitleValue_value_key`; touches zero row
   data — a UNIQUE index removal can never violate existing data). Canonical
   identity is now `(domain, normalizedValue)` only; `value` is
   display-only. Verified empirically post-fix (same two rows now coexist;
   `scripts/test-microsoft-job-title-directory.ts` section 6, 4/4 checks) —
   see `scripts/audit-job-title-directory-invariants.ts` for the standing
   DB-level proof. Every pre-existing row (57 at audit time, all confirmed
   via exhaustive code-path audit — see next point — to be legitimate
   `kinsen.gr` test fixtures created by this session's own test scripts)
   kept its exact `id`/data; nothing was deleted or recreated.
2. **Backfill safety confirmed, not merely assumed.** Only two code paths
   ever write `MicrosoftDirectoryJobTitleValue`: Operation A
   (`upsertDiscoveredMicrosoftDirectoryValue`, gated upstream by `lib/auth.ts`'s
   Microsoft SSO domain restriction, in place since before this feature) and
   Operation B (`syncMicrosoftDirectoryValues`/`syncJobTitleDirectoryTable`,
   Graph-scan-only, never runs against a real tenant here — dummy
   credentials). An exhaustive `grep` for every call site of both functions
   found exactly 4 scripts, all confirmed to use only `@kinsen.gr` fixture
   emails. A separate script that DOES use non-Kinsen fixture domains
   (`simulate-organization-sync-fixture.ts`, `@kinsen.example`/etc.) was
   checked and confirmed to call only `runOrganizationSync` — a completely
   different pipeline that never touches this table. **This conclusion is
   specific to this dev database's actual history, proven by code-path
   audit, not a general rule** — a real production deployment that had a
   genuine (pre-domain-filter) Operation B admin sync run against a real
   multi-domain/guest-containing tenant before this fix existed could have
   accumulated real non-Kinsen rows, and would need this same kind of audit
   run against its own actual history (not this dev DB's) before trusting
   its backfill.
3. **NOT fixed, and NOT in scope for this finding — `MicrosoftDepartmentMapping`
   (the actual permission-mapping engine) is global-per-string, not
   domain-scoped.** Confirmed via schema (`@@unique([sourceType, microsoftValue])`,
   no `domain` column at all) and an isolated empirical test: creating a
   mapping for `PROFILE_JOB_TITLE`/`"Director"` targeting one department,
   then attempting a second mapping for the SAME raw string targeting a
   different department (conceptually "kinsen.at Director"), is rejected
   with `P2002` on `(sourceType, microsoftValue)` — see
   `scripts/test-microsoft-job-title-directory.ts` section 7 (an explicit,
   intentional **negative** test, not a bug in this session's work: it
   documents current, unchanged behavior). Deliberately **not changed** in
   this follow-up — extending `MicrosoftDepartmentMapping` to be
   domain-scoped would require adding a `domain` column, changing its
   unique key, and changing `resolveDepartmentMemberships`/
   `resolvePrimaryMicrosoftMapping`/`findActiveMappingsForClaims` (which
   directly drive `DepartmentMembership` creation and `User.role`) to filter
   by domain — real new functionality touching the login/full-sync
   resolution pipeline, explicitly out of scope for this audit-and-fix
   turn (which was scoped to "no new functionality, don't touch
   DepartmentMembership/Organization architecture"). Tracked separately as
   **FIND-006, OPEN** — see below.
- **Acceptance test:** all tests listed above, green; `scripts/test-microsoft-job-title-directory.ts`
  now 38/38 (was 32/32 — 6 new checks across sections 6-7 above); full
  regression suite green twice in a row, both before and after this
  follow-up audit's fix.
- **Source artifact:** `lib/services/microsoft-directory-service.ts`,
  `lib/services/microsoft-job-title-directory-service.ts`,
  `lib/services/organization-directory-eligibility-service.ts`,
  `prisma/migrations/20260807110000_job_title_directory_domain_scope/`,
  `prisma/migrations/20260807153000_job_title_value_domain_scoped_identity/`.
- **Closure status:** **CLOSED, WITH QUALIFICATION.** The discovered-value
  catalog (`MicrosoftDirectoryJobTitleValue`) is genuinely domain-scoped and
  multi-domain-ready with zero further schema change — proven, not assumed.
  The permission-mapping engine (`MicrosoftDepartmentMapping`) is **not**
  domain-scoped — that gap is real, was not silently claimed closed, and is
  tracked as its own OPEN finding (FIND-006). `ALLOWED_EMAIL_DOMAIN` still
  enables only `kinsen.gr`; no other domain was activated. **Not verified
  against a real Microsoft tenant** — this environment's Graph credentials
  remain dummy values (see `docs/microsoft-production-readiness-audit.md`);
  every Graph interaction in the tests above is a mocked `global.fetch`, and
  the browser verification's "Sync Microsoft Job Titles" click deliberately
  exercises the documented graceful-failure path (a specific, actionable
  error toast) against the real dummy credentials — not a successful real
  discovery.

---

## FIND-006 — MicrosoftDepartmentMapping (Job Title/Department/Group/App-Role permission mapping) is global-per-string, not domain-scoped

- **Exact finding:** `MicrosoftDepartmentMapping` has no `domain` column and
  its uniqueness is `@@unique([sourceType, microsoftValue])` — a single
  raw Microsoft value (e.g. job title `"Director"`) can only ever have ONE
  mapping across the entire installation, regardless of which Entra domain
  a user with that value belongs to. `resolveDepartmentMemberships`/
  `resolvePrimaryMicrosoftMapping`/`findActiveMappingsForClaims`
  (`microsoft-mapping-service.ts`) match purely on `{sourceType,
  microsoftValue}` — `MicrosoftIdentityClaims` carries no domain signal into
  the matching logic at all (only `email`, from which a domain COULD be
  derived, but isn't, today).
- **Reproduction/evidence:** `scripts/test-microsoft-job-title-directory.ts`
  section 7 — creating a `PROFILE_JOB_TITLE` mapping for `"Director"`
  targeting department A, then attempting a second mapping for the exact
  same raw string targeting department B, fails with `P2002` on
  `(sourceType, microsoftValue)`. This is today's real, unchanged,
  intentional-per-current-design behavior (not a regression from FIND-005's
  work) — first observed and confirmed during FIND-005's follow-up audit.
- **Impact:** none today — `kinsen.gr` is the only enabled domain, so a
  global-per-string mapping is indistinguishable from a domain-scoped one in
  practice. Becomes a real limitation the moment a second domain (e.g.
  `kinsen.at`) is enabled and needs a *different* department/role for the
  same job title string than `kinsen.gr` uses — that scenario cannot be
  configured today; both domains would be forced to share one mapping.
- **Target phase:** future, only relevant once/if a second domain is
  actually enabled in `organization-directory-eligibility-service.ts`.
  Explicitly deferred from this session — the fix is genuinely new
  functionality (a schema change to the model that drives
  `DepartmentMembership` creation and `User.role`, plus resolution-logic and
  admin-UI changes), which this audit turn was explicitly scoped to avoid.
- **Acceptance test:** not yet written — closing this would need a `domain`
  column on `MicrosoftDepartmentMapping` (nullable/optional, defaulting to
  "any domain" for backward compatibility with today's `kinsen.gr`-only
  mappings — so existing mappings keep resolving identically with zero
  admin action), a compound uniqueness that includes it, `MicrosoftIdentityClaims`
  extended with a derived domain signal, and
  `resolveDepartmentMemberships`/`resolvePrimaryMicrosoftMapping` updated to
  filter/prefer by domain — each of which needs its own regression coverage
  (existing single-domain mappings unaffected; two same-string mappings on
  different domains both resolve correctly and independently; a mapping
  with no domain set still matches any domain, for compatibility).
- **Source artifact:** `prisma/schema.prisma` (`MicrosoftDepartmentMapping`),
  `lib/services/microsoft-mapping-service.ts`.
- **Closure status:** **OPEN** — new finding from this session's FIND-005
  follow-up audit. `kinsen.gr`-only behavior today has zero regression from
  this gap; it only matters once a second domain is actually enabled.
