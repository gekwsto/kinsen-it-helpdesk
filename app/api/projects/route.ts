import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import {
  buildProjectListWhere,
  resolveDepartmentForCreate,
  departmentDenialMessage,
  departmentDenialStatus,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { resolveActiveDepartmentMemberIds } from "@/lib/services/department-membership-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { createProjectSchema, createProjectMemberEligibilitySchema, facilitiesProjectFieldsSchema } from "@/lib/validations";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import {
  getFacilitiesServicesDepartmentId,
  hasFacilitiesFieldsPresent,
  resolveFacilitiesWrite,
  facilitiesResolutionErrorMessage,
  type ResolvedFacilitiesWrite,
} from "@/lib/services/project-facilities-service";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);

    const page = parseInt(searchParams.get("page") ?? "1");
    const limit = parseInt(searchParams.get("limit") ?? "20");
    const search = searchParams.get("search") ?? "";
    const status = searchParams.get("status");
    const departmentId = searchParams.get("departmentId");
    const subDepartmentId = searchParams.get("subDepartmentId");

    const skip = (page - 1) * limit;

    const scope = await buildProjectListWhere(session.user.id, session.user.role, departmentId);
    if ("denied" in scope) {
      return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
    }

    const andConditions: any[] = [scope];
    if (subDepartmentId) andConditions.push({ subDepartmentId });
    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (status) andConditions.push({ status });

    const where: any = { AND: andConditions };

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          owner: { select: { id: true, name: true, email: true, image: true } },
          department: { select: { id: true, name: true } },
          businessUnit: { select: { id: true, name: true } },
          members: { select: { id: true, name: true, image: true } },
          _count: { select: { activities: true } },
        },
      }),
      prisma.project.count({ where }),
    ]);

    return NextResponse.json({
      projects,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const body = await req.json();
    const data = createProjectSchema.merge(facilitiesProjectFieldsSchema).parse(body);
    const { memberEligibilitySource } = createProjectMemberEligibilitySchema.parse(body);

    // No explicit departmentId in the body — fall back to the caller's
    // active workspace (Phase 2B) before resolveDepartmentForCreate's own
    // primary/sole-membership fallback.
    let effectiveRequestedDepartmentId = data.departmentId;
    if (!effectiveRequestedDepartmentId) {
      const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
      effectiveRequestedDepartmentId = activeWorkspace.departmentId ?? undefined;
    }

    const deptResolution = await resolveDepartmentForCreate(
      session.user.id,
      session.user.role,
      effectiveRequestedDepartmentId,
      "project.create"
    );
    if ("denied" in deptResolution) {
      return NextResponse.json(
        { error: departmentDenialMessage(deptResolution.denied) },
        { status: departmentDenialStatus(deptResolution.denied) }
      );
    }

    const {
      memberIds,
      startDate,
      endDate,
      departmentId: _ignoredDepartmentId,
      facilitiesCompany,
      facilitiesLocation,
      facilitiesStartPrecision,
      facilitiesStartQuarter,
      facilitiesStartYear,
      facilitiesEndPrecision,
      facilitiesEndQuarter,
      facilitiesEndYear,
      ...rest
    } = data;

    // Facilities Services-only metadata — rejected outright for any other
    // workspace (requirement: "prevent cross-workspace writes"), resolved
    // (Quarter -> boundary date, or the plain exact date) only when this
    // Project's own department actually IS Facilities Services. Checked
    // against the RAW body (not `data`) so an attempt is caught even if
    // Zod would otherwise have rejected/stripped the value.
    const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
    const isFacilitiesWorkspace = !!facilitiesServicesDepartmentId && deptResolution.departmentId === facilitiesServicesDepartmentId;
    if (!isFacilitiesWorkspace && hasFacilitiesFieldsPresent(body)) {
      return NextResponse.json(
        { error: "Facilities-specific fields can only be set for a Project in the Facilities Services workspace.", code: "facilities_fields_not_allowed" },
        { status: 400 }
      );
    }
    let facilitiesWrite: ResolvedFacilitiesWrite | null = null;
    if (isFacilitiesWorkspace) {
      const resolution = resolveFacilitiesWrite({
        startPrecision: facilitiesStartPrecision ?? null,
        startQuarter: facilitiesStartQuarter ?? null,
        startYear: facilitiesStartYear ?? null,
        startExact: startDate ?? null,
        endPrecision: facilitiesEndPrecision ?? null,
        endQuarter: facilitiesEndQuarter ?? null,
        endYear: facilitiesEndYear ?? null,
        endExact: endDate ?? null,
      });
      if (!resolution.ok) {
        return NextResponse.json({ error: facilitiesResolutionErrorMessage(resolution.error), code: resolution.error.code }, { status: 400 });
      }
      facilitiesWrite = resolution.value;
    }

    if (rest.subDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(rest.subDepartmentId, deptResolution.departmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to this project's department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    // Two DIFFERENT, mutually exclusive Member-eligibility rules, picked by
    // the request itself (see createProjectMemberEligibilitySchema's own
    // doc comment) — never both, never a silent fallback between them:
    // "workspaceMembership" (the standalone manual-creation form only)
    // requires an active DepartmentMembership in this exact department;
    // "assignable" (the default, every other caller) requires the
    // historical `project.assignable` permission. Whichever rule applies,
    // every id is still independently re-validated server-side — the
    // client's own eligibilitySource choice only selects WHICH check runs,
    // never whether one runs at all.
    if (memberIds.length > 0) {
      if (memberEligibilitySource === "workspaceMembership") {
        const validatedMemberIds = await resolveActiveDepartmentMemberIds(deptResolution.departmentId, memberIds);
        if (validatedMemberIds === null) {
          return NextResponse.json(
            { error: "One or more selected members are not active members of this workspace.", code: "assignee_not_assignable" },
            { status: 400 }
          );
        }
      } else {
        for (const userId of memberIds) {
          const assignable = await userHasAssignablePermissionForEntity(userId, "project", deptResolution.departmentId);
          if (!assignable) {
            return NextResponse.json(
              { error: "One or more selected members cannot be assigned to projects in this department.", code: "assignee_not_assignable" },
              { status: 400 }
            );
          }
        }
      }
    }

    const project = await prisma.project.create({
      data: {
        ...rest,
        departmentId: deptResolution.departmentId,
        ownerId: session.user.id,
        // Mirrors the single canonical owner into the authoritative
        // multi-owner relation too — see Project.owners' own schema doc
        // comment for why this invariant ("owners always contains
        // ownerId") holds for every Project, manual or request-origin.
        // Purely internal consistency: nothing about normal/manual Project
        // behavior changes — no UI, no permission check, reads this
        // relation differently for a manual Project.
        owners: { connect: [{ id: session.user.id }] },
        // Facilities Services: the resolved write wins outright (it
        // already derived startDate/endDate from either the exact date or
        // the Quarter boundary, plus the precision/quarter/year metadata).
        // Every other workspace: the exact, unmodified pre-existing
        // behavior — a plain exact date or nothing.
        ...(isFacilitiesWorkspace && facilitiesWrite
          ? { ...facilitiesWrite, facilitiesCompany: facilitiesCompany ?? undefined, facilitiesLocation: facilitiesLocation ?? undefined }
          : { startDate: startDate ? new Date(startDate) : undefined, endDate: endDate ? new Date(endDate) : undefined }),
        members: memberIds.length
          ? { connect: memberIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
        members: { select: { id: true, name: true, image: true } },
        _count: { select: { activities: true } },
      },
    });

    // Published only after the create has actually committed above — the
    // new project needs to appear in every open, matching Project list.
    publishProjectListInvalidation();

    return NextResponse.json(project, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
