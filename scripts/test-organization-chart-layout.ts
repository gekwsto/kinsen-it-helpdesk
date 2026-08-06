/**
 * lib/organization-chart-layout.ts's computeTreeLayout — pure function, no
 * DB, no network. Proves determinism (same tree in -> same positions out,
 * every time) and basic structural correctness (every node gets a unique
 * position, depth increases going down, siblings never overlap).
 *
 * Usage: npx tsx scripts/test-organization-chart-layout.ts
 */
import { computeTreeLayout, toLayoutPositionMap, type LayoutTreeNode } from "@/lib/organization-chart-layout";

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

function makeSampleTree(): LayoutTreeNode[] {
  return [
    {
      id: "root",
      children: [
        { id: "a", children: [{ id: "a1", children: [] }, { id: "a2", children: [] }] },
        { id: "b", children: [{ id: "b1", children: [] }] },
      ],
    },
  ];
}

console.log("\nDeterminism...\n");
const tree1 = makeSampleTree();
const tree2 = makeSampleTree();
const layout1 = computeTreeLayout(tree1);
const layout2 = computeTreeLayout(tree2);
check("same tree shape -> identical positions across two independent computations", JSON.stringify(layout1) === JSON.stringify(layout2));

const layout3 = computeTreeLayout(makeSampleTree());
check("re-running a third time still produces identical output", JSON.stringify(layout1) === JSON.stringify(layout3));

console.log("\nStructure...\n");
const positions = toLayoutPositionMap(layout1);
check("every node in the input tree has a position", ["root", "a", "a1", "a2", "b", "b1"].every((id) => positions.has(id)));
check("root is at depth 0", positions.get("root")?.depth === 0);
check("a/b are at depth 1", positions.get("a")?.depth === 1 && positions.get("b")?.depth === 1);
check("a1/a2/b1 are at depth 2", positions.get("a1")?.depth === 2 && positions.get("a2")?.depth === 2 && positions.get("b1")?.depth === 2);
check("leaf siblings a1/a2 have distinct x", positions.get("a1")!.x !== positions.get("a2")!.x);
check("a's x is the average of its children (a1, a2)", positions.get("a")!.x === (positions.get("a1")!.x + positions.get("a2")!.x) / 2);
check("b's x equals its only child b1's x", positions.get("b")!.x === positions.get("b1")!.x);
check("root's x is the average of a and b", Math.abs(positions.get("root")!.x - (positions.get("a")!.x + positions.get("b")!.x) / 2) < 1e-9);

console.log("\nSingle node...\n");
const single = computeTreeLayout([{ id: "only", children: [] }]);
check("a lone root gets exactly one position at (0,0,depth 0)", single.length === 1 && single[0].x === 0 && single[0].y === 0 && single[0].depth === 0);

console.log("\nEmpty input...\n");
check("no roots -> empty position list", computeTreeLayout([]).length === 0);

console.log("\nMultiple independent roots never overlap...\n");
const multiRoot = computeTreeLayout([
  { id: "r1", children: [] },
  { id: "r2", children: [] },
  { id: "r3", children: [] },
]);
const xs = multiRoot.map((p) => p.x);
check("three lone roots get three distinct x slots", new Set(xs).size === 3);

console.log("\nCustom spacing options are honored...\n");
const spaced = computeTreeLayout([{ id: "r", children: [{ id: "c1", children: [] }, { id: "c2", children: [] }] }], { horizontalSpacing: 500, verticalSpacing: 300 });
const spacedPositions = toLayoutPositionMap(spaced);
check("verticalSpacing multiplies depth for y", spacedPositions.get("c1")!.y === 300);
check("horizontalSpacing is the leaf-slot step size", Math.abs(spacedPositions.get("c2")!.x - spacedPositions.get("c1")!.x) === 500);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
