"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { createProjectSchema, type CreateProjectInput } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ChevronLeft, ShieldOff } from "lucide-react";
import Link from "next/link";
import { ProjectStatus } from "@prisma/client";
import { useCreateWithAttachments } from "@/hooks/use-create-with-attachments";
import { PendingAttachmentsField } from "@/components/attachments/pending-attachments-field";
import { PostCreateUploadPanel } from "@/components/attachments/post-create-upload-panel";
import { WorkspaceCombobox } from "@/components/projects/workspace-combobox";

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface SubDepartmentOption {
  id: string;
  name: string;
}

interface ExpenseTypeOption {
  id: string;
  name: string;
}

export interface CreatedProject {
  id: string;
  title: string;
  departmentId: string | null;
}

/** Whole calendar days between two date-only (YYYY-MM-DD) strings — a client-side PREVIEW only, purely for UX; mirrors wholeCalendarDaysBetween in lib/services/project-request-service.ts, but the server always recomputes and persists its own authoritative value, this number is never submitted. Returns null until both dates are present/valid. */
function previewCalendarDays(startStr: string, finishStr: string): number | null {
  if (!startStr || !finishStr) return null;
  const start = new Date(startStr);
  const finish = new Date(finishStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startUtcMidnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const finishUtcMidnight = Date.UTC(finish.getUTCFullYear(), finish.getUTCMonth(), finish.getUTCDate());
  return Math.round((finishUtcMidnight - startUtcMidnight) / MS_PER_DAY);
}

interface ProjectFormProps {
  departments: DepartmentOption[];
  /**
   * Server-computed set of department ids where this user holds effective
   * project.edit (global grant OR that department's own grant — the exact
   * union hasEffectiveEntityPermission resolves, computed once per
   * `departments` entry by the page). `create` never implies `edit`: a role
   * can independently grant project.create without project.edit, so a
   * create-only user's Attachments section stays hidden for a department
   * where they couldn't actually upload once the Project exists. The
   * client only ever checks membership in this server-truth set — it never
   * decides the permission itself.
   */
  editableDepartmentIds: string[];
  /** Preselected department — the active workspace's department if it's in `departments`, or the sole option if there's exactly one. Undefined forces an explicit choice. */
  defaultDepartmentId?: string;
  /**
   * "standalone" (default) — the full /projects/new page experience:
   * department is a real choice, success redirects to /projects/{id}.
   * "inline" — embedded in a modal (e.g. from the Ticket create/link flow):
   * department is FIXED to `fixedDepartmentId` (never a Select — this is
   * the actual enforcement point that a ticket can never end up linked to a
   * project from another department; POST /api/projects itself is still
   * the authoritative validator, this just never offers the invalid choice
   * in the first place), and success calls `onCreated` instead of
   * navigating away.
   * "fromRequest" — the request-origin Project setup page
   * (/projects/new?projectRequestId=...): department is FIXED to
   * `fixedDepartmentId` (the approved Project Request's own, same
   * enforcement rationale as inline), posts to the dedicated
   * POST /api/project-requests/[id]/project mutation instead of
   * POST /api/projects, and additionally collects Project Owner + the
   * request-origin-only fields (Expected Start/Finish, Expense Type,
   * Budget, Estimated Cost, Actual Cost, External) — never shown in any
   * other mode. Success redirects to /projects/{id}, same as standalone.
   */
  mode?: "standalone" | "inline" | "fromRequest";
  /** Required when mode="inline" or mode="fromRequest" — the department this project MUST belong to. */
  fixedDepartmentId?: string;
  fixedDepartmentName?: string;
  /**
   * Inline mode only — whether the current user holds effective
   * project.edit (global grant OR `fixedDepartmentId`'s own grant,
   * computed server-side by the caller via hasEffectiveEntityPermission —
   * see components/tickets/ticket-form.tsx / ticket-actions.tsx) in the
   * fixed department. Same "create never implies edit" rule as standalone;
   * governs whether the Attachments section is offered at all in the
   * dialog. Unused/defaults false outside inline mode.
   */
  inlineCanUploadAttachments?: boolean;
  /** Required when mode="fromRequest" — the approved Project Request this Project is being set up for; POSTs go to /api/project-requests/{fromRequestId}/project. */
  fromRequestId?: string;
  /** fromRequest mode only — pre-fills Title/Description/Priority from the request (still freely editable, same as any other Project field — only the department itself is locked). */
  fromRequestPrefill?: { title: string; description: string | null; priority: number };
  /**
   * Inline mode only — called whenever it becomes unsafe (or safe again) to
   * silently dismiss the enclosing dialog via Escape/backdrop-click/close-
   * button: true from the moment the Project has been created with
   * attachments still pending/failed, until the upload phase is fully
   * resolved (either every file succeeded, or the user explicitly clicked
   * Continue). The dialog shell (ProjectCreateDialog) is what actually
   * blocks the close; this form only ever reports the state.
   */
  onLockChange?: (locked: boolean) => void;
  onCreated?: (project: CreatedProject) => void;
  onCancel?: () => void;
}

export function ProjectForm({ departments, editableDepartmentIds, defaultDepartmentId, mode = "standalone", fixedDepartmentId, fixedDepartmentName, inlineCanUploadAttachments = false, fromRequestId, fromRequestPrefill, onLockChange, onCreated, onCancel }: ProjectFormProps) {
  const router = useRouter();
  const inline = mode === "inline";
  const fromRequest = mode === "fromRequest";
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const attachments = useCreateWithAttachments<CreatedProject>((id) => `/api/projects/${id}`);

  // ─── fromRequest-only fields — plain state, not react-hook-form (same
  // established pattern as selectedMemberIds above: the shared
  // createProjectSchema resolver below covers every field COMMON to all
  // three modes identically, so these request-origin-only extras are kept
  // separate rather than fighting a resolver that has to serve two
  // different zod schemas). Client-side checks below are a UX convenience
  // only — createProjectFromRequestSchema at the server boundary is the
  // real authority. ───
  // Owner(s) and Audience are BOTH system-wide (never Department-scoped,
  // unlike Members' own `assignableUsers`) — fed from the plain
  // `GET /api/users` endpoint (every active user, no `assignableFor`
  // narrowing), a completely separate fetch/list from assignableUsers.
  const [systemWideUsers, setSystemWideUsers] = useState<AssignableUser[]>([]);
  const [selectedOwnerIds, setSelectedOwnerIds] = useState<Set<string>>(new Set());
  const [selectedAudienceIds, setSelectedAudienceIds] = useState<Set<string>>(new Set());
  const [ownerSearch, setOwnerSearch] = useState("");
  const [audienceSearch, setAudienceSearch] = useState("");
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [expectedFinishDate, setExpectedFinishDate] = useState("");
  const [expenseTypeId, setExpenseTypeId] = useState("");
  const [external, setExternal] = useState(false);
  // Budget was REMOVED entirely (no replacement, no state/field at all).
  // Estimated Cost / Actual Cost are no longer user-entered — both are
  // derived from this Project's own Activities (none exist yet at creation
  // time, so both naturally start at €0) — see
  // lib/services/project-financials-service.ts. Neither has a state
  // variable here; they're rendered as a fixed readonly €0.00 below.
  const [expenseTypes, setExpenseTypes] = useState<ExpenseTypeOption[]>([]);
  const previewDays = useMemo(() => previewCalendarDays(expectedStartDate, expectedFinishDate), [expectedStartDate, expectedFinishDate]);

  useEffect(() => {
    if (!fromRequest) return;
    fetch("/api/project-expense-types")
      .then((r) => (r.ok ? r.json() : []))
      .then((types) => setExpenseTypes(Array.isArray(types) ? types : []))
      .catch(() => {});
  }, [fromRequest]);

  // Fetched ONCE (not re-fetched on department change, unlike
  // assignableUsers below) — Owner(s)/Audience eligibility never depends on
  // the selected workspace at all, per this feature's own spec ("no
  // Department restriction, no Workspace restriction").
  useEffect(() => {
    if (!fromRequest) return;
    fetch("/api/users")
      .then((r) => (r.ok ? r.json() : []))
      .then((users) => setSystemWideUsers(Array.isArray(users) ? users : []))
      .catch(() => {});
  }, [fromRequest]);

  const toggleOwner = (userId: string) => {
    setSelectedOwnerIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };
  const toggleAudienceMember = (userId: string) => {
    setSelectedAudienceIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };
  const ownerSearchResults = useMemo(() => {
    const q = ownerSearch.trim().toLowerCase();
    if (!q) return systemWideUsers;
    return systemWideUsers.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [systemWideUsers, ownerSearch]);
  const audienceSearchResults = useMemo(() => {
    const q = audienceSearch.trim().toLowerCase();
    if (!q) return systemWideUsers;
    return systemWideUsers.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [systemWideUsers, audienceSearch]);

  // Reports "safe to silently dismiss the dialog right now" to the inline
  // dialog shell — locked from the moment creation succeeded WITH
  // attachments to upload, until either every upload succeeded or the user
  // explicitly continued. Never fires in standalone mode (no dialog to guard).
  useEffect(() => {
    if (!inline) return;
    onLockChange?.(attachments.createdEntity !== null && attachments.entries.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, attachments.createdEntity, attachments.entries.length]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      title: fromRequestPrefill?.title,
      description: fromRequestPrefill?.description ?? undefined,
      status: ProjectStatus.PLANNING,
      priority: fromRequestPrefill?.priority ?? 2,
      memberIds: [],
      isGoal: false,
      departmentId: inline || fromRequest ? fixedDepartmentId : defaultDepartmentId,
    },
  });

  const departmentId = inline || fromRequest ? fixedDepartmentId : watch("departmentId");
  const [subDepartments, setSubDepartments] = useState<SubDepartmentOption[]>([]);

  // Recomputed purely from the already-server-resolved `editableDepartmentIds`
  // set whenever the Workspace Select changes — never a fresh permission
  // decision made client-side, just a membership check against server
  // truth. null (no department chosen yet) hides the section entirely,
  // same as false; only a confirmed `true` shows it. Inline mode never
  // offers attachments at all (see the `attachments` hook's own comment).
  // fromRequest mode always offers it — the exact recorded final approver
  // completing setup for THIS specific request already has the narrower,
  // dedicated authority POST /api/project-requests/[id]/project grants,
  // independent of whatever generic project.edit grant they may or may not
  // separately hold in this department.
  const canUploadAttachments: boolean | null = fromRequest ? true : inline ? inlineCanUploadAttachments : departmentId ? editableDepartmentIds.includes(departmentId) : null;

  // Eligible members depend on the selected workspace — re-fetched whenever
  // it changes, not loaded once and filtered in the browser.
  //
  // standalone (manual Project creation, the ONLY mode this branch applies
  // to): Members means "active users who belong to the selected Workspace/
  // Department" — the plain DepartmentMembership relation itself, via
  // GET /api/departments/[id]/members, with NO project.view/project.edit/
  // project.assignable/admin permission filtering layered on top (that
  // permission-based notion is a DIFFERENT concept — "who can be assigned
  // project work" — see getAssignableUsersForEntity's own doc comment).
  // With no Workspace selected yet there is no membership to show at all —
  // never system-wide users.
  //
  // inline/fromRequest keep the PRE-EXISTING, unchanged, permission-based
  // `assignableFor=project` eligibility: inline is a separate embedded form
  // (ticket-linking dialog) outside this task's scope, and fromRequest's
  // own Members rule is explicitly unchanged by the Owner(s)/Audience
  // feature (see scripts/test-project-request-project-creation.ts's own
  // "Members stays Department-scoped" contrast check).
  useEffect(() => {
    if (inline || fromRequest) {
      const url = `/api/users?assignableFor=project${departmentId ? `&departmentId=${departmentId}` : ""}`;
      fetch(url)
        .then((r) => (r.ok ? r.json() : []))
        .then((users) => setAssignableUsers(Array.isArray(users) ? users : []))
        .catch(() => {});
      return;
    }
    if (!departmentId) {
      setAssignableUsers([]);
      return;
    }
    fetch(`/api/departments/${departmentId}/members`)
      .then((r) => (r.ok ? r.json() : []))
      .then((users) => setAssignableUsers(Array.isArray(users) ? users : []))
      .catch(() => setAssignableUsers([]));
  }, [departmentId, inline, fromRequest]);

  // Switching Workspace (standalone only) invalidates any previously
  // selected Members — the old Workspace's members aren't implicitly valid
  // for the new one, so the selection is reset rather than silently carried
  // over as a now-stale memberId the user never re-confirmed. A no-op for
  // inline/fromRequest, whose departmentId is fixed for the form's whole
  // lifetime anyway.
  useEffect(() => {
    if (inline || fromRequest) return;
    setSelectedMemberIds(new Set());
    setValue("memberIds", []);
  }, [departmentId, inline, fromRequest, setValue]);

  const [memberSearch, setMemberSearch] = useState("");
  const memberSearchResults = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return assignableUsers;
    return assignableUsers.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [assignableUsers, memberSearch]);

  // Sub-departments are scoped to the selected workspace — cleared and
  // re-fetched whenever the workspace changes, since a sub-department from
  // the previous department is never valid for the new one.
  useEffect(() => {
    setValue("subDepartmentId", undefined);
    if (!departmentId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${departmentId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [departmentId, setValue]);

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      setValue("memberIds", Array.from(next));
      return next;
    });
  };

  const onSubmit = async (data: CreateProjectInput) => {
    // In inline/fromRequest mode the department is never user-editable, so
    // this can only trip if the caller forgot to pass fixedDepartmentId — a
    // real programming error, not a user-facing validation case.
    const effectiveDepartmentId = inline || fromRequest ? fixedDepartmentId : data.departmentId;
    if (!effectiveDepartmentId) {
      toast.error("Choose a workspace for this project.");
      return;
    }

    // fromRequest-only required fields — a UX convenience only;
    // createProjectFromRequestSchema at the server boundary re-validates
    // every one of these regardless. Budget/Estimated Cost/Actual Cost are
    // no longer among them — none is a user-entered field any more.
    if (fromRequest) {
      if (selectedOwnerIds.size === 0) return toast.error("Select at least one Owner for this Project.");
      if (!expectedStartDate || !expectedFinishDate) return toast.error("Expected Start and Finish dates are required.");
      if (new Date(expectedFinishDate) < new Date(expectedStartDate)) return toast.error("Expected Finish Date cannot be before Expected Start Date.");
      if (!expenseTypeId) return toast.error("Select an Expense Type.");
    }

    setIsSubmitting(true);
    try {
      const { departmentId: _ignoredDepartmentId, ...restData } = data;
      // Two-step architecture: create the Project first (unchanged request/
      // route), THEN — only once it has a real, server-issued id — upload
      // any selected attachments through the existing protected
      // POST /api/projects/[id]/attachments route. Never the reverse, never
      // a client-generated id, never a multipart create request.
      const { entity: project, allUploaded } = await attachments.submit(async () => {
        const url = fromRequest ? `/api/project-requests/${fromRequestId}/project` : "/api/projects";
        const body = fromRequest
          ? {
              ...restData,
              memberIds: Array.from(selectedMemberIds),
              ownerIds: Array.from(selectedOwnerIds),
              audienceIds: Array.from(selectedAudienceIds),
              expectedStartDate,
              expectedFinishDate,
              expenseTypeId,
              external,
            }
          : {
              ...restData,
              departmentId: effectiveDepartmentId,
              memberIds: Array.from(selectedMemberIds),
              // Tells POST /api/projects which Member-eligibility rule to
              // enforce (see createProjectMemberEligibilitySchema's own doc
              // comment in lib/validations.ts) — "workspaceMembership" only
              // for standalone, whose Members picker above is itself now
              // Workspace-membership-based; inline (ticket-linking) keeps
              // sending "assignable", preserving its own pre-existing,
              // permission-based eligibility untouched.
              memberEligibilitySource: inline ? "assignable" : "workspaceMembership",
            };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The authoritative scope/owner/expense-type validator
          // (resolveDepartmentForCreate, or createProjectFromApprovedRequest
          // for fromRequest) regardless of what's sent here — this only
          // ever narrows what the UI OFFERS, never widens what the backend
          // accepts.
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message ?? err.error ?? "Failed to create project");
        }
        const created = await res.json();
        // The dedicated request-origin route returns {id, alreadyExisted},
        // not the full Project shape /api/projects does — normalize to the
        // same CreatedProject contract the rest of this form (and
        // useCreateWithAttachments) relies on.
        return fromRequest ? { id: created.id, title: data.title, departmentId: effectiveDepartmentId } : created;
      });
      toast.success("Project created!");
      if (allUploaded) {
        // No attachments selected, or every upload succeeded. Inline: call
        // onCreated (the Ticket-linking callback) exactly once, now — never
        // before uploads finished. Standalone: navigate immediately, exactly
        // like this form always has. A partial/total upload failure instead
        // falls through to the PostCreateUploadPanel rendered below; inline
        // waits there for Retry/Continue before ever calling onCreated,
        // standalone waits for Continue before navigating.
        if (inline) {
          onCreated?.({ id: project.id, title: project.title, departmentId: project.departmentId ?? null });
        } else {
          router.push(`/projects/${project.id}`);
        }
      }
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!inline && !fromRequest && departments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">No workspace to create in</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have permission to create a project in any workspace. Contact your administrator to request access.
        </p>
      </div>
    );
  }

  // The Project already exists (create succeeded) and had attachments to
  // upload — the ORIGINAL form is never shown again from this point on
  // (nothing left to resubmit against — the create request is never fired
  // again, whether the user retries or continues), only upload progress +
  // Retry/Continue. On a fully successful upload this branch is never
  // reached at all: onSubmit above already called onCreated/navigated
  // directly.
  if (attachments.createdEntity && attachments.entries.length > 0) {
    const finish = () => {
      if (inline) {
        // Exactly once — this is the ONLY place inline's onCreated fires
        // from the panel (Continue, or a fully-successful Retry below).
        onCreated?.(attachments.createdEntity!);
      } else {
        router.push(`/projects/${attachments.createdEntity!.id}`);
      }
    };
    return (
      <PostCreateUploadPanel
        entityLabel="Project"
        entries={attachments.entries}
        uploading={attachments.phase === "uploading"}
        onRetryFailed={async () => {
          const { allUploaded } = await attachments.retryFailed();
          // Canonical rule, identical in both modes: a Retry that clears
          // every remaining failure finishes automatically (same as the
          // initial upload's own "all succeeded" path in onSubmit) — the
          // panel (and its Continue button) exists only to let the user
          // proceed EARLY while a failure still remains, not as an extra
          // confirmation step once there's nothing left to review.
          if (allUploaded) finish();
        }}
        onContinue={finish}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card className={inline ? "border-none shadow-none" : undefined}>
        {!inline && (
          <CardHeader>
            <CardTitle className="text-base">Project Details</CardTitle>
          </CardHeader>
        )}
        <CardContent className={inline ? "space-y-4 px-0" : "space-y-4"}>
          <div className="space-y-2">
            <Label htmlFor="title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input id="title" {...register("title")} placeholder="Project title..." />
            {errors.title && (
              <p className="text-xs text-destructive">{errors.title.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              {...register("description")}
              placeholder="Project description..."
              className="min-h-[100px]"
            />
          </div>

          {inline || fromRequest ? (
            // Fixed, never a Select — this IS the enforcement point that an
            // inline-created project can never end up in a different
            // department than the ticket (or, in fromRequest mode, the
            // approved Project Request) it's being created from.
            <div className="space-y-2">
              <Label>Workspace</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
                {fixedDepartmentName ?? (fromRequest ? "This request's department" : "This ticket's department")}
              </div>
            </div>
          ) : (
          <div className="space-y-2">
            <Label>
              Workspace <span className="text-destructive">*</span>
            </Label>
            <WorkspaceCombobox
              workspaces={departments}
              value={departmentId ?? ""}
              onChange={(id) => setValue("departmentId", id, { shouldValidate: true })}
            />
            <p className="text-xs text-muted-foreground">
              This project will belong to the selected workspace.
            </p>
          </div>
          )}

          {subDepartments.length > 0 && (
            <div className="space-y-2">
              <Label>Sub-Department</Label>
              <Select
                value={watch("subDepartmentId") ?? ""}
                onValueChange={(v) => setValue("subDepartmentId", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {subDepartments.map((sd) => (
                    <SelectItem key={sd.id} value={sd.id}>
                      {sd.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Optional — narrows this project within the workspace.</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                defaultValue={ProjectStatus.PLANNING}
                onValueChange={(v) => setValue("status", v as ProjectStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(ProjectStatus).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                value={String(watch("priority") ?? 2)}
                onValueChange={(v) => setValue("priority", parseInt(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">High</SelectItem>
                  <SelectItem value="2">Medium</SelectItem>
                  <SelectItem value="1">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input type="date" {...register("startDate")} />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input type="date" {...register("endDate")} />
            </div>
          </div>

          {fromRequest && (
            <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
              <div>
                <h3 className="text-sm font-semibold">Project Setup Details</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Required for Projects created from an approved Project Request.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-owners">
                  Owner(s) <span className="text-destructive">*</span>
                </Label>
                <p id="project-owners-helper" className="text-xs text-muted-foreground">
                  Any active user in the system — not limited to this department. At least one is required.
                </p>
                <Input
                  placeholder="Search by name or email…"
                  value={ownerSearch}
                  onChange={(e) => setOwnerSearch(e.target.value)}
                  className="h-8 text-sm"
                />
                {systemWideUsers.length > 0 ? (
                  <div
                    id="project-owners"
                    role="group"
                    aria-describedby="project-owners-helper"
                    className="border rounded-md divide-y max-h-48 overflow-y-auto"
                  >
                    {ownerSearchResults.map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded"
                          checked={selectedOwnerIds.has(u.id)}
                          onChange={() => toggleOwner(u.id)}
                        />
                        <span className="text-sm">{u.name ?? u.email}</span>
                      </label>
                    ))}
                    {ownerSearchResults.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">No users match &quot;{ownerSearch}&quot;.</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-destructive border rounded-md px-3 py-2">No active users exist. Contact an administrator.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-audience">Audience</Label>
                <p id="project-audience-helper" className="text-xs text-muted-foreground">
                  Optional — users who should be able to follow this Project&apos;s progress without being a Member or an Owner. Any active user in the system.
                </p>
                <Input
                  placeholder="Search by name or email…"
                  value={audienceSearch}
                  onChange={(e) => setAudienceSearch(e.target.value)}
                  className="h-8 text-sm"
                />
                {systemWideUsers.length > 0 ? (
                  <div
                    id="project-audience"
                    role="group"
                    aria-describedby="project-audience-helper"
                    className="border rounded-md divide-y max-h-48 overflow-y-auto"
                  >
                    {audienceSearchResults.map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded"
                          checked={selectedAudienceIds.has(u.id)}
                          onChange={() => toggleAudienceMember(u.id)}
                        />
                        <span className="text-sm">{u.name ?? u.email}</span>
                      </label>
                    ))}
                    {audienceSearchResults.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">No users match &quot;{audienceSearch}&quot;.</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">No active users exist yet.</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="expected-start">
                    Expected Start Date <span className="text-destructive">*</span>
                  </Label>
                  <Input id="expected-start" type="date" value={expectedStartDate} onChange={(e) => setExpectedStartDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="expected-finish">
                    Expected Finish Date <span className="text-destructive">*</span>
                  </Label>
                  <Input id="expected-finish" type="date" value={expectedFinishDate} onChange={(e) => setExpectedFinishDate(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="expected-total-initial-days">Expected Total Initial Days</Label>
                {/* readOnly (never `disabled`) — deliberately keeps the SAME
                    visual weight as every other input on this form (no
                    disabled:opacity-50 greying), because this is a real
                    Project field, just a server-computed one — not an
                    unimportant/inactive one. This is a client-side PREVIEW
                    only (see previewCalendarDays's doc comment); it is never
                    read from state on submit, never sent to the server, and
                    the server independently recomputes + persists its own
                    authoritative value from Expected Start/Finish. */}
                <Input
                  id="expected-total-initial-days"
                  type="text"
                  inputMode="none"
                  readOnly
                  aria-readonly="true"
                  tabIndex={-1}
                  value={previewDays !== null ? `${previewDays} day${previewDays === 1 ? "" : "s"}` : ""}
                  placeholder="Select both dates to calculate"
                  className="cursor-default bg-muted/40"
                />
                <p className="text-xs text-muted-foreground">Calculated automatically from Expected Start/Finish Date — not editable.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="expense-type">
                  Expense Type <span className="text-destructive">*</span>
                </Label>
                <Select value={expenseTypeId} onValueChange={setExpenseTypeId}>
                  <SelectTrigger id="expense-type">
                    <SelectValue placeholder="Select an Expense Type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {expenseTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Budget was removed entirely — no field, no input, no
                  replacement. Estimated Cost / Actual Cost are no longer
                  user-entered: both are derived from this Project's own
                  Activities (lib/services/project-financials-service.ts).
                  At creation time there are normally no Activities yet, so
                  both naturally start at €0.00 — shown here as fixed
                  readonly text (not even a live preview input, since there
                  is nothing yet to compute from). */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="estimated-cost">Estimated Cost (EUR)</Label>
                  <Input
                    id="estimated-cost"
                    type="text"
                    inputMode="none"
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    value="€0.00"
                    className="cursor-default bg-muted/40"
                  />
                  <p className="text-xs text-muted-foreground">Calculated automatically from this Project's Activities once created.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="actual-cost">Actual Cost (EUR)</Label>
                  <Input
                    id="actual-cost"
                    type="text"
                    inputMode="none"
                    readOnly
                    aria-readonly="true"
                    tabIndex={-1}
                    value="€0.00"
                    className="cursor-default bg-muted/40"
                  />
                  <p className="text-xs text-muted-foreground">Calculated automatically once Activities are completed.</p>
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 rounded" checked={external} onChange={(e) => setExternal(e.target.checked)} />
                  <span className="text-sm font-medium">External</span>
                </label>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Success Target</Label>
            <Textarea
              {...register("successTarget")}
              placeholder="What does success look like?"
              className="min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded"
                {...register("isGoal")}
              />
              <span className="text-sm font-medium">This project is a Goal</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Mark this project as a yearly goal for tracking purposes.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Members</Label>
            <p className="text-xs text-muted-foreground">
              {!inline && !fromRequest
                ? "Active users who belong to the selected workspace."
                : "Only users eligible for this workspace are listed."}
            </p>
            {!inline && !fromRequest && !departmentId ? (
              <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                Select a workspace to see its members.
              </p>
            ) : (
              <>
                {!inline && !fromRequest && assignableUsers.length > 0 && (
                  <Input
                    placeholder="Search members by name or email…"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="h-8 text-sm"
                  />
                )}
                {assignableUsers.length > 0 ? (
                  <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                    {memberSearchResults.map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded"
                          checked={selectedMemberIds.has(u.id)}
                          onChange={() => toggleMember(u.id)}
                        />
                        <span className="text-sm">{u.name ?? u.email}</span>
                      </label>
                    ))}
                    {memberSearchResults.length === 0 && (
                      <p className="text-xs text-muted-foreground px-3 py-2">No members match &quot;{memberSearch}&quot;.</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                    No eligible users for this workspace yet.
                  </p>
                )}
              </>
            )}
          </div>

          <PendingAttachmentsField
            files={attachments.files}
            onFilesChange={attachments.setFiles}
            disabled={isSubmitting}
            canUpload={canUploadAttachments}
            unavailableMessage={
              inline
                ? "You don't have permission to attach files to a Project in this department."
                : "You don't have permission to attach files to a Project in the selected workspace."
            }
            neutralMessage={!inline && !fromRequest ? "Select a workspace to enable project attachments." : undefined}
          />

          <div className="flex justify-end gap-3 pt-2">
            {inline ? (
              <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </Button>
            ) : (
              <Button type="button" variant="outline" asChild>
                <Link href="/projects">Cancel</Link>
              </Button>
            )}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Project
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
