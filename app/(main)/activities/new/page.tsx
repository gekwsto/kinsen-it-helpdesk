import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { canActOnEntity, getNavVisibilityFlags, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { ActivityNewForm } from "@/components/activities/activity-new-form";

export default async function NewActivityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // This page previously had NO activity.create check at all — it rendered
  // the create form (and POST /api/activities was the only real gate,
  // correctly enforced there via resolveDepartmentForCreate) for ANY
  // authenticated user, including one with only activity.view. Same union
  // sidebar's "New Activity" link uses (navFlags.canCreateActivities) —
  // department-scoped OR global activity.create, never derived from
  // activity.view.
  const canCreate = (
    await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId)
  ).canCreateActivities;
  if (!canCreate) redirect("/activities");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const departmentId = activeWorkspace.isAllSelected ? null : activeWorkspace.departmentId;

  // Same canActOnEntity gate POST /api/projects itself enforces (via
  // resolveDepartmentForCreate) — computed here only to decide whether the
  // form offers "+ New Project" at all; the backend remains authoritative.
  const canCreateProject = departmentId
    ? await canActOnEntity(session.user.id, session.user.role, departmentId, "project.create")
    : false;

  // activity.create never implies activity.edit — independently grantable,
  // same as project.create/project.edit (see app/(main)/projects/new/page.tsx's
  // identical comment). This department is fixed for the whole page (no
  // department Select in standalone ActivityNewForm), so a single
  // hasEffectiveEntityPermission call — the same global-or-department union
  // every other entity-edit gate in this app uses — is enough; the
  // Attachments section's visibility is gated on this, never decided
  // client-side.
  // null (not false) when no department is resolved at all yet — distinct
  // from a real "resolved, but denied" false, so the form can stay silent
  // instead of showing a misleading permission message for an unrelated
  // "no workspace" state.
  const canUploadAttachments = departmentId
    ? await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, departmentId, "activity.edit")
    : null;

  // Same rule, checked against project.edit instead, for the NESTED "+ New
  // Project" dialog's own Attachments section — that dialog always creates
  // its Project into this SAME departmentId (see ProjectCreateDialog's
  // fixedDepartmentId={departmentId} wiring inside ActivityNewForm), so the
  // real target department for this check is this exact value, never the
  // active workspace and never inferred from project.create. A create-only
  // user (project.create without project.edit) can still create/select the
  // Project via this dialog — they just won't be offered attachment
  // selection, exactly like every other create-only case in this app.
  const canUploadProjectAttachments = departmentId
    ? await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, departmentId, "project.edit")
    : null;

  return (
    <ActivityNewForm
      departmentId={departmentId}
      canCreateProject={canCreateProject}
      canUploadAttachments={canUploadAttachments}
      canUploadProjectAttachments={canUploadProjectAttachments}
    />
  );
}
