/**
 * Deterministic tidy-tree node positioning for the organization chart
 * (components/admin/organization-chart/*) — a pure function of the tree
 * shape, with NO dependency on render order, previous positions, or
 * randomness, so re-rendering the exact same tree always produces the exact
 * same layout (the brief's explicit "nodes must not shift position on every
 * render" requirement).
 *
 * Deliberately hand-written rather than a dependency (`dagre`/`elkjs`):
 * both the department tree (Company/BusinessUnit/Department/SubDepartment)
 * and the people tree (manager/directReports) are STRICT trees, never an
 * arbitrary DAG — a classic single-pass "average of children" tidy-tree
 * layout is well-understood, small, and fully sufficient. @xyflow/react (the
 * one new dependency this feature adds) is used only for the canvas/pan/
 * zoom/rendering layer, not layout math.
 */

export interface LayoutTreeNode {
  id: string;
  children: LayoutTreeNode[];
}

export interface LayoutPosition {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export interface LayoutOptions {
  /** Horizontal distance between adjacent leaf-level slots — default 240. */
  horizontalSpacing?: number;
  /** Vertical distance between depth levels — default 140. */
  verticalSpacing?: number;
}

/**
 * Assigns every node a leaf-ordered horizontal slot (depth-first, so
 * siblings never visually cross) and a depth-based vertical row; an
 * internal node's x is the average of its children's x — the standard
 * "centered over children" tidy-tree placement. Multiple root trees (e.g.
 * several top-level people-tree roots) are laid out left-to-right in the
 * order given, sharing one horizontal slot counter so they never overlap.
 */
export function computeTreeLayout(roots: LayoutTreeNode[], options: LayoutOptions = {}): LayoutPosition[] {
  const horizontalSpacing = options.horizontalSpacing ?? 240;
  const verticalSpacing = options.verticalSpacing ?? 140;
  const positions: LayoutPosition[] = [];
  let nextLeafSlot = 0;

  function layout(node: LayoutTreeNode, depth: number): number {
    if (node.children.length === 0) {
      const x = nextLeafSlot * horizontalSpacing;
      nextLeafSlot++;
      positions.push({ id: node.id, x, y: depth * verticalSpacing, depth });
      return x;
    }
    const childXs = node.children.map((child) => layout(child, depth + 1));
    const x = childXs.reduce((sum, cx) => sum + cx, 0) / childXs.length;
    positions.push({ id: node.id, x, y: depth * verticalSpacing, depth });
    return x;
  }

  for (const root of roots) layout(root, 0);
  return positions;
}

/** Convenience lookup built from computeTreeLayout's flat array — O(1) position access by node id during render. */
export function toLayoutPositionMap(positions: LayoutPosition[]): Map<string, LayoutPosition> {
  return new Map(positions.map((p) => [p.id, p]));
}
