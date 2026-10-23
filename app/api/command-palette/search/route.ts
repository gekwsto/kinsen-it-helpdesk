import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { buildTicketListWhere, buildProjectListWhere } from "@/lib/services/department-scope-service";

const RESULT_LIMIT = 5;

/**
 * Lightweight combined search for the global command palette (⌘K) —
 * everything the caller can see across departments (not scoped to the
 * active workspace, unlike the real Tickets/Projects list pages), since a
 * global "jump to anything" search should never be narrower than what the
 * user could already reach by navigating there directly. Reuses the exact
 * same scoping primitives as app/(main)/tickets/page.tsx and
 * app/(main)/projects/page.tsx (buildTicketListWhere/buildProjectListWhere
 * with no departmentId — their own documented "full accessible union"
 * behavior) rather than inventing new authorization logic. Autocomplete
 * shape only: no pagination metadata, a small `take` per entity type.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();

    // Server-side gate, independent of the client's own length check — never
    // trust the client to have applied it.
    if (q.length < 2) {
      return NextResponse.json({ tickets: [], projects: [] });
    }

    const [ticketScope, projectScope] = await Promise.all([
      buildTicketListWhere(session.user.id, session.user.role),
      buildProjectListWhere(session.user.id, session.user.role),
    ]);

    const numSearch = parseInt(q, 10);
    const ticketsPromise =
      "denied" in ticketScope
        ? Promise.resolve([])
        : prisma.ticket.findMany({
            where: {
              AND: [
                ticketScope,
                {
                  OR: [
                    { title: { contains: q, mode: "insensitive" } },
                    ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
                  ],
                },
              ],
            },
            take: RESULT_LIMIT,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              ticketNumber: true,
              title: true,
              status: { select: { name: true, color: true } },
              department: { select: { name: true } },
            },
          });

    const projectsPromise =
      "denied" in projectScope
        ? Promise.resolve([])
        : prisma.project.findMany({
            where: { AND: [projectScope, { title: { contains: q, mode: "insensitive" } }] },
            take: RESULT_LIMIT,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              title: true,
              department: { select: { name: true } },
            },
          });

    const [tickets, projects] = await Promise.all([ticketsPromise, projectsPromise]);

    return NextResponse.json({ tickets, projects });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
