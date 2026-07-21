import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canViewAllDepartments } from "@/lib/permissions";
import { getMembership } from "@/lib/services/department-membership-service";
import {
  getDepartmentHierarchyTier,
  HIERARCHY_TIER_ORDER,
  HIERARCHY_TIER_LABELS,
  type HierarchyTier,
} from "@/lib/services/department-role-translation";

interface HierarchyMember {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  globalRole: string;
  roleLabel: string;
  subDepartments: string[];
}

/**
 * Read-only, on-demand data for the "View Hierarchy" popup on
 * /my-departments — fetched only when a card's dialog is opened (not
 * preloaded for every department on every page view). Access mirrors
 * exactly how /my-departments/page.tsx itself decides which departments to
 * show a user: cross-department roles (Admin/Director), or an actual active
 * membership — "members of that department" — no new permission invented.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const department = await prisma.department.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!department) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const allowed =
      canViewAllDepartments(session.user.role) || (await getMembership(session.user.id, id)) !== null;
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const memberships = await prisma.departmentMembership.findMany({
      where: { departmentId: id, isActive: true, user: { isActive: true } },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, image: true, role: true } },
        customRole: { select: { key: true, name: true, isBuiltIn: true } },
      },
    });

    const userIds = memberships.map((m) => m.user.id);
    const subDeptMemberships = userIds.length
      ? await prisma.subDepartmentMembership.findMany({
          where: { departmentId: id, userId: { in: userIds }, isActive: true },
          select: { userId: true, subDepartment: { select: { name: true } } },
        })
      : [];
    const subDeptNamesByUser = new Map<string, string[]>();
    for (const m of subDeptMemberships) {
      const list = subDeptNamesByUser.get(m.userId) ?? [];
      list.push(m.subDepartment.name);
      subDeptNamesByUser.set(m.userId, list);
    }

    const byTier = new Map<HierarchyTier, HierarchyMember[]>();
    for (const m of memberships) {
      const tier = getDepartmentHierarchyTier({
        globalRole: m.user.role,
        departmentRole: m.role,
        customRole: m.customRole ? { key: m.customRole.key, isBuiltIn: m.customRole.isBuiltIn } : null,
      });
      const entry: HierarchyMember = {
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        globalRole: m.user.role,
        // A custom role's own name is more specific/accurate than the tier
        // label it was bucketed into (e.g. "Regional Coordinator" vs. just
        // "Department Manager") — shown when set, tier label otherwise.
        roleLabel: m.customRole?.name ?? HIERARCHY_TIER_LABELS[tier],
        subDepartments: subDeptNamesByUser.get(m.user.id) ?? [],
      };
      const list = byTier.get(tier) ?? [];
      list.push(entry);
      byTier.set(tier, list);
    }

    const groups = HIERARCHY_TIER_ORDER.map((tier) => {
      const members = (byTier.get(tier) ?? []).sort((a, b) =>
        (a.name ?? a.email).localeCompare(b.name ?? b.email)
      );
      return { tier, label: HIERARCHY_TIER_LABELS[tier], members };
    }).filter((g) => g.members.length > 0);

    return NextResponse.json({ department, groups });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
