import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canManageRoleScope } from "@/lib/permissions";
import { wouldOrphanAdminAccessByDisablingRole } from "@/lib/services/role-safety-service";
import { z } from "zod";

const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const allowed = await canManageRoleScope(session.user.role, session.user.customRoleId, role.scope, "update");
    if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });

    const body = await req.json();
    const data = updateRoleSchema.parse(body);

    // Disabling is the one destructive-ish lever left for a built-in role
    // (they can never be hard-deleted — key is load-bearing elsewhere) —
    // guarded so it can never remove the last path to admin access. Name/
    // description edits (built-in or custom) carry no such risk and are no
    // longer restricted — `key` itself stays immutable for every role,
    // built-in or custom, since it's never part of this schema.
    if (data.isActive === false && role.isActive) {
      const wouldOrphan = await wouldOrphanAdminAccessByDisablingRole(role.key);
      if (wouldOrphan) {
        return NextResponse.json(
          { error: "Disabling this role would leave no path to admin access.", code: "cannot_remove_last_admin" },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.customRole.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        description: data.description !== undefined ? data.description : undefined,
        isActive: data.isActive ?? undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const role = await prisma.customRole.findUnique({ where: { id } });
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const allowed = await canManageRoleScope(session.user.role, session.user.customRoleId, role.scope, "delete");
    if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });

    // Built-in roles are never HARD-deleted — their key is a load-bearing
    // string (role translation, Microsoft mapping, hardcoded label maps
    // elsewhere) that other code assumes still resolves to a real row. This
    // is narrower than "locked": name/description/permissions all remain
    // editable above and via the permissions route — only irreversible row
    // removal is blocked. Use Disable (PATCH isActive:false) instead.
    if (role.isBuiltIn) {
      return NextResponse.json(
        { error: "Built-in roles cannot be permanently deleted. Disable it instead.", code: "builtin_role_locked" },
        { status: 409 }
      );
    }

    const [usersWithRole, membershipsWithRole] = await Promise.all([
      prisma.user.count({ where: { customRoleId: id } }),
      prisma.departmentMembership.count({ where: { customRoleId: id } }),
    ]);
    const totalInUse = usersWithRole + membershipsWithRole;
    if (totalInUse > 0) {
      const parts: string[] = [];
      if (usersWithRole > 0) parts.push(`${usersWithRole} user${usersWithRole > 1 ? "s" : ""}`);
      if (membershipsWithRole > 0) parts.push(`${membershipsWithRole} department membership${membershipsWithRole > 1 ? "s" : ""}`);
      return NextResponse.json(
        { error: `This role is assigned to ${parts.join(" and ")} and cannot be deleted. Reassign them first.`, code: "role_in_use" },
        { status: 409 }
      );
    }

    // Remove all permission assignments for this role before deleting
    await prisma.rolePermission.deleteMany({ where: { roleKey: role.key } });
    await prisma.customRole.delete({ where: { id } });

    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
