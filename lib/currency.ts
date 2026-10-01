/**
 * Single source of truth for rendering a EUR cost value — never a
 * second/independently-drifting format string anywhere else. Accepts
 * `number | string | null | undefined` because a Prisma.Decimal value
 * crosses both JSON (NextResponse.json, via Decimal's own toJSON -> string)
 * and the React Server Component Flight boundary (where a raw Decimal
 * instance cannot be passed to a Client Component at all — callers convert
 * it to a plain number first; see app/(main)/project-requests/new/page.tsx).
 * Returns null (never a placeholder string) when there is no cost to show,
 * so callers decide their own "not set" copy.
 */
export function formatEUR(cost: number | string | null | undefined): string | null {
  if (cost === null || cost === undefined) return null;
  const n = typeof cost === "string" ? Number(cost) : cost;
  if (!Number.isFinite(n)) return null;
  return `€${n.toFixed(2)}`;
}
