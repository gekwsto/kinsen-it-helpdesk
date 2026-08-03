/**
 * Server-side pagination for /admin/users: lib/pagination.ts's pure
 * parse/compute/window functions (no DB needed), plus real-DB integration
 * tests using the exact query-builder (lib/services/admin-user-list-query.ts)
 * the page itself calls, proving page-2-subset correctness, no duplicates
 * across consecutive pages, search/filter-before-pagination, totalCount/
 * totalPages correctness, and empty-result handling.
 *
 * Usage: npx tsx scripts/test-admin-users-pagination.ts
 * Requires a reachable DATABASE_URL for the integration section — prints a
 * clear message and skips (not fails) that section if one isn't configured.
 */
import {
  parsePageParam,
  parsePageSizeParam,
  computePagination,
  isOutOfRange,
  getPageNumbers,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/pagination";
import {
  buildAdminUserListQueryArgs,
  buildAdminUserListWhere,
} from "@/lib/services/admin-user-list-query";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";

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

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const RUN_ID = Date.now();

function testParsePageParam() {
  console.log("\nparsePageParam...\n");
  check("undefined -> default (1)", parsePageParam(undefined) === DEFAULT_PAGE);
  check("missing/empty string -> default", parsePageParam("") === DEFAULT_PAGE);
  check("'1' -> 1", parsePageParam("1") === 1);
  check("'2' -> 2", parsePageParam("2") === 2);
  check("'0' -> default (rejects zero)", parsePageParam("0") === DEFAULT_PAGE);
  check("'-1' -> default (rejects negative)", parsePageParam("-1") === DEFAULT_PAGE);
  check("'1.5' -> default (rejects non-integer)", parsePageParam("1.5") === DEFAULT_PAGE);
  check("'abc' -> default (rejects NaN)", parsePageParam("abc") === DEFAULT_PAGE);
  check("'2abc' -> default (rejects trailing garbage)", parsePageParam("2abc") === DEFAULT_PAGE);
  check("'Infinity' -> default (rejects non-finite)", parsePageParam("Infinity") === DEFAULT_PAGE);
  check("array picks first element", parsePageParam(["3", "4"]) === 3);
}

function testParsePageSizeParam() {
  console.log("\nparsePageSizeParam...\n");
  check("undefined -> default (20)", parsePageSizeParam(undefined) === DEFAULT_PAGE_SIZE);
  check("'20' -> 20", parsePageSizeParam("20") === 20);
  check("'50' -> 50", parsePageSizeParam("50") === 50);
  check("'100' -> 100", parsePageSizeParam("100") === 100);
  check("'30' (not in allowlist) -> default", parsePageSizeParam("30") === DEFAULT_PAGE_SIZE);
  check("'1000000' (excessive) -> default", parsePageSizeParam("1000000") === DEFAULT_PAGE_SIZE);
  check("'-20' -> default (rejects negative)", parsePageSizeParam("-20") === DEFAULT_PAGE_SIZE);
  check("'0' -> default (rejects zero)", parsePageSizeParam("0") === DEFAULT_PAGE_SIZE);
  check("'abc' -> default (rejects NaN)", parsePageSizeParam("abc") === DEFAULT_PAGE_SIZE);
  check("'20.5' -> default (rejects non-integer)", parsePageSizeParam("20.5") === DEFAULT_PAGE_SIZE);
}

function testComputePagination() {
  console.log("\ncomputePagination...\n");

  const empty = computePagination(0, 1, 20);
  check("totalCount=0 -> totalPages=1 (never 0)", empty.totalPages === 1);
  check("totalCount=0 -> page=1", empty.page === 1);
  check("totalCount=0 -> startIndex=0", empty.startIndex === 0);
  check("totalCount=0 -> endIndex=0", empty.endIndex === 0);
  check("totalCount=0 -> hasPreviousPage=false", empty.hasPreviousPage === false);
  check("totalCount=0 -> hasNextPage=false", empty.hasNextPage === false);

  const page1of7 = computePagination(137, 1, 20);
  check("137 users, page 1, size 20 -> totalPages=7", page1of7.totalPages === 7);
  check("page 1 -> startIndex=1", page1of7.startIndex === 1);
  check("page 1 -> endIndex=20", page1of7.endIndex === 20);
  check("page 1 -> hasPreviousPage=false", page1of7.hasPreviousPage === false);
  check("page 1 -> hasNextPage=true", page1of7.hasNextPage === true);

  const page2of7 = computePagination(137, 2, 20);
  check("page 2 -> startIndex=21", page2of7.startIndex === 21);
  check("page 2 -> endIndex=40", page2of7.endIndex === 40);
  check("page 2 -> \"Showing 21-40 of 137\" matches spec example", page2of7.startIndex === 21 && page2of7.endIndex === 40 && page2of7.totalCount === 137);
  check("page 2 -> hasPreviousPage=true", page2of7.hasPreviousPage === true);
  check("page 2 -> hasNextPage=true", page2of7.hasNextPage === true);

  const lastPage = computePagination(137, 7, 20);
  check("last page (7) -> endIndex clamps to totalCount (137, not 140)", lastPage.endIndex === 137);
  check("last page -> hasNextPage=false", lastPage.hasNextPage === false);
  check("last page -> hasPreviousPage=true", lastPage.hasPreviousPage === true);

  const outOfRange = computePagination(137, 999, 20);
  check("requested page beyond totalPages clamps page down to totalPages (7)", outOfRange.page === 7);
  check("isOutOfRange true when clamped", isOutOfRange(999, outOfRange) === true);
  check("isOutOfRange false when within range", isOutOfRange(2, page2of7) === false);

  const exact = computePagination(40, 2, 20);
  check("exact multiple (40 users, size 20) -> totalPages=2, no phantom page 3", exact.totalPages === 2);
  check("exact multiple, page 2 -> endIndex=40", exact.endIndex === 40);
}

function testGetPageNumbers() {
  console.log("\ngetPageNumbers...\n");

  check("totalPages=0 -> []", getPageNumbers(1, 0).length === 0);
  check("totalPages=1 -> [1]", JSON.stringify(getPageNumbers(1, 1)) === JSON.stringify([1]));
  check("totalPages=2, current=1 -> [1,2]", JSON.stringify(getPageNumbers(1, 2)) === JSON.stringify([1, 2]));
  check("totalPages=3, current=2 -> [1,2,3] (no ellipsis needed for 3 pages)", JSON.stringify(getPageNumbers(2, 3)) === JSON.stringify([1, 2, 3]));
  check("totalPages=10, current=1 -> starts with 1, ends with 10", (() => {
    const t = getPageNumbers(1, 10);
    return t[0] === 1 && t[t.length - 1] === 10;
  })());
  check("totalPages=10, current=5 -> contains an ellipsis on both sides", (() => {
    const t = getPageNumbers(5, 10);
    return t.filter((x) => x === "ellipsis").length === 2;
  })());
  check("totalPages=10, current=1 -> exactly one ellipsis (no gap at the start)", getPageNumbers(1, 10).filter((x) => x === "ellipsis").length === 1);
  check("totalPages=10, current=10 -> exactly one ellipsis (no gap at the end)", getPageNumbers(10, 10).filter((x) => x === "ellipsis").length === 1);

  // Exhaustive sweep: for every totalPages 1..25 and every current 1..totalPages,
  // the token list must always start with 1, always end with totalPages, never
  // have two adjacent ellipsis tokens, never repeat a numeric token, and the
  // numeric tokens must be strictly increasing.
  let sweepOk = true;
  const failures: string[] = [];
  for (let totalPages = 1; totalPages <= 25; totalPages++) {
    for (let current = 1; current <= totalPages; current++) {
      const tokens = getPageNumbers(current, totalPages);
      if (tokens.length === 0) continue;
      if (tokens[0] !== 1) {
        sweepOk = false;
        failures.push(`totalPages=${totalPages} current=${current}: doesn't start with 1`);
        continue;
      }
      if (tokens[tokens.length - 1] !== totalPages) {
        sweepOk = false;
        failures.push(`totalPages=${totalPages} current=${current}: doesn't end with totalPages`);
        continue;
      }
      let lastNumeric = 0;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "ellipsis") {
          if (tokens[i - 1] === "ellipsis") {
            sweepOk = false;
            failures.push(`totalPages=${totalPages} current=${current}: adjacent ellipsis tokens`);
          }
          continue;
        }
        if (t <= lastNumeric) {
          sweepOk = false;
          failures.push(`totalPages=${totalPages} current=${current}: numeric tokens not strictly increasing (${t} after ${lastNumeric})`);
        }
        lastNumeric = t;
      }
    }
  }
  check("exhaustive sweep (totalPages 1..25, all current values): well-formed token lists", sweepOk);
  if (!sweepOk) {
    console.error("  first few failures:", failures.slice(0, 5));
  }
}

async function testIntegration() {
  console.log("\nIntegration: buildAdminUserListQueryArgs against a real DB...\n");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping integration section.");
    console.log(String(err instanceof Error ? err.message : err));
    return;
  }

  const userIds: string[] = [];
  try {
    // 25 users, deterministic names "Pag Test 00".."Pag Test 24", so
    // orderBy [{name:"asc"},{id:"asc"}] gives a fully predictable sequence.
    const created = [];
    for (let i = 0; i < 25; i++) {
      const label = String(i).padStart(2, "0");
      const u = await prisma.user.create({
        data: {
          email: `pag-test-${RUN_ID}-${label}@kinsen.gr`,
          name: `Pag Test ${RUN_ID} ${label}`,
          authProvider: AuthProvider.CREDENTIALS,
          role: Role.USER,
        },
      });
      created.push(u);
      userIds.push(u.id);
    }

    // Scope every query to just this run's users so we're never affected by
    // other rows already in the DB (dev DB may have pre-existing users).
    const scopedWhere = { AND: [buildAdminUserListWhere("all", ""), { id: { in: userIds } }] };

    const totalCount = await prisma.user.count({ where: scopedWhere });
    check("count matches the number of fixtures created (25)", totalCount === 25);

    const pageSize = 10;
    const page1Args = buildAdminUserListQueryArgs({ departmentId: "all", search: "", page: 1, pageSize });
    const page1 = await prisma.user.findMany({ ...page1Args, where: { AND: [page1Args.where, { id: { in: userIds } }] } });
    check("page 1, size 10 -> returns exactly 10 rows", page1.length === 10);
    check("page 1 -> first row is 'Pag Test .. 00' (deterministic name asc ordering)", page1[0].name === `Pag Test ${RUN_ID} 00`);
    check("page 1 -> last row is 'Pag Test .. 09'", page1[9].name === `Pag Test ${RUN_ID} 09`);

    const page2Args = buildAdminUserListQueryArgs({ departmentId: "all", search: "", page: 2, pageSize });
    const page2 = await prisma.user.findMany({ ...page2Args, where: { AND: [page2Args.where, { id: { in: userIds } }] } });
    check("page 2, size 10 -> returns exactly 10 rows", page2.length === 10);
    check("page 2 -> first row is 'Pag Test .. 10'", page2[0].name === `Pag Test ${RUN_ID} 10`);
    check("page 2 -> last row is 'Pag Test .. 19'", page2[9].name === `Pag Test ${RUN_ID} 19`);

    const page3Args = buildAdminUserListQueryArgs({ departmentId: "all", search: "", page: 3, pageSize });
    const page3 = await prisma.user.findMany({ ...page3Args, where: { AND: [page3Args.where, { id: { in: userIds } }] } });
    check("page 3 (partial, 25 total / size 10) -> returns exactly 5 rows", page3.length === 5);

    const allIdsAcrossPages = [...page1, ...page2, ...page3].map((u) => u.id);
    const uniqueIds = new Set(allIdsAcrossPages);
    check("no duplicate users across pages 1-3", uniqueIds.size === allIdsAcrossPages.length);
    check("pages 1-3 together account for all 25 fixtures", uniqueIds.size === 25);

    const pagination = computePagination(totalCount, 1, pageSize);
    check("computePagination on real totalCount (25, size 10) -> totalPages=3", pagination.totalPages === 3);

    // Search filter narrows the *count* the same way it narrows the list —
    // confirms the where clause behind count and findMany can never diverge.
    const searchArgs = buildAdminUserListQueryArgs({ departmentId: "all", search: `Pag Test ${RUN_ID} 0`, page: 1, pageSize: 20 });
    const searchWhereScoped = { AND: [searchArgs.where, { id: { in: userIds } }] };
    const searchResults = await prisma.user.findMany({ ...searchArgs, where: searchWhereScoped });
    const searchCount = await prisma.user.count({ where: searchWhereScoped });
    check("search 'Pag Test .. 0' matches exactly users 00-09 (10 users)", searchResults.length === 10 && searchCount === 10);
    check("search results all actually contain the search term (search applied, not ignored)", searchResults.every((u) => u.name?.includes(`Pag Test ${RUN_ID} 0`)));

    const noMatchArgs = buildAdminUserListQueryArgs({ departmentId: "all", search: `nonexistent-${RUN_ID}-zzz`, page: 1, pageSize: 20 });
    const noMatchWhereScoped = { AND: [noMatchArgs.where, { id: { in: userIds } }] };
    const noMatchResults = await prisma.user.findMany({ ...noMatchArgs, where: noMatchWhereScoped });
    const noMatchCount = await prisma.user.count({ where: noMatchWhereScoped });
    check("search with no matches -> empty result set", noMatchResults.length === 0 && noMatchCount === 0);
    const noMatchPagination = computePagination(noMatchCount, 1, 20);
    check("empty result -> totalPages=1, not 0 (no misleading pagination controls)", noMatchPagination.totalPages === 1);
    check("empty result -> hasNextPage=false, hasPreviousPage=false", noMatchPagination.hasNextPage === false && noMatchPagination.hasPreviousPage === false);

    // Page far beyond the real last page must be recognized as out-of-range
    // and clamp down to the true last page — the redirect trigger the real
    // Server Component acts on.
    const beyondPagination = computePagination(totalCount, 999, pageSize);
    check("page 999 (way beyond totalPages=3) clamps to page 3", beyondPagination.page === 3);
    check("page 999 flagged as out-of-range (would trigger canonical redirect)", isOutOfRange(999, beyondPagination) === true);

    // Simulate "delete the last user of the last page": with 25 users and
    // pageSize 10, page 3 has 5 users; if we drop to 20 total (delete 5),
    // page 3 no longer exists and must clamp back to page 2.
    const afterDeleteCount = totalCount - 5;
    const afterDeletePagination = computePagination(afterDeleteCount, 3, pageSize);
    check("after deleting the last page's users, requesting page 3 clamps to page 2", afterDeletePagination.page === 2);
    check("after-delete clamp is flagged out-of-range", isOutOfRange(3, afterDeletePagination) === true);
  } finally {
    if (userIds.length > 0) {
      try {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      } catch (err) {
        console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }
}

async function main() {
  testParsePageParam();
  testParsePageSizeParam();
  testComputePagination();
  testGetPageNumbers();
  await testIntegration();
  printSummaryAndExit();
}

main();
