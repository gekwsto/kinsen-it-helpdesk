"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
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
import { ChevronRight, Loader2, Building2, Briefcase } from "lucide-react";
import { ProjectStatus } from "@prisma/client";
import { FacilitiesDateField, facilitiesBoundaryPreview } from "@/components/projects/facilities-date-field";
import { ProjectDurationField, parseDurationOverride } from "@/components/projects/project-duration-field";
import { calculateProjectDurationDays } from "@/lib/project-duration";
import { PROJECT_IMPORTANCE_OPTIONS, PROJECT_SCORE_OPTIONS, getImportanceScoreFraction, formatScorePercent } from "@/lib/project-scoring-shared";

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
}

interface SubDepartmentOption {
  id: string;
  name: string;
}

interface ExpenseTypeOption {
  id: string;
  name: string;
}

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  // Audience — Users: system-wide (never Department-scoped), same
  // eligibility rule Owner(s) always used — editable here for EVERY
  // Project as of Phase 1.1 (previously request-origin-creation-only, with
  // no edit surface anywhere). A separate fetch/list from assignableUsers
  // (Members), same "GET /api/users, every active user" shape
  // components/projects/project-form.tsx's own systemWideUsers already uses.
  const [systemWideUsers, setSystemWideUsers] = useState<AssignableUser[]>([]);
  const [selectedAudienceIds, setSelectedAudienceIds] = useState<Set<string>>(new Set());
  const [audienceSearch, setAudienceSearch] = useState("");
  // Responsible People (Phase 2) — own independent relation, never
  // Audience. Same system-wide eligibility, reuses the SAME
  // systemWideUsers list (no separate fetch).
  const [selectedResponsiblePeopleIds, setSelectedResponsiblePeopleIds] = useState<Set<string>>(new Set());
  const [responsiblePeopleSearch, setResponsiblePeopleSearch] = useState("");
  // Organizational Audience (Phase 1) — editable here for EVERY Project
  // (manual or request-origin). Owner(s) stays request-origin-creation-only
  // and has no edit surface here — unchanged, out of scope for Phase 1.1.
  const [audienceDepartmentOptions, setAudienceDepartmentOptions] = useState<{ id: string; name: string }[]>([]);
  const [audienceBusinessUnitOptions, setAudienceBusinessUnitOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedAudienceDepartmentIds, setSelectedAudienceDepartmentIds] = useState<Set<string>>(new Set());
  const [selectedAudienceBusinessUnitIds, setSelectedAudienceBusinessUnitIds] = useState<Set<string>>(new Set());
  const [audienceDepartmentSearch, setAudienceDepartmentSearch] = useState("");
  const [audienceBusinessUnitSearch, setAudienceBusinessUnitSearch] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>(ProjectStatus.PLANNING);
  const [priority, setPriority] = useState("2");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [successTarget, setSuccessTarget] = useState("");
  const [isGoal, setIsGoal] = useState(false);
  const [subDepartments, setSubDepartments] = useState<SubDepartmentOption[]>([]);
  const [subDepartmentId, setSubDepartmentId] = useState("");

  // Request-origin-only — only ever shown/editable when the Project was
  // actually created through the request-origin setup flow (projectRequestId
  // set). A legacy request-origin Project (from before this feature, or
  // with these left null) is still editable like any other — these fields
  // simply start blank/unset, never a validation blocker.
  const [projectRequestId, setProjectRequestId] = useState<string | null>(null);
  // Creation-time baseline — display-only, server-authoritative, never sent
  // back on PATCH (see updateProjectRequestOriginFieldsSchema's doc comment
  // in lib/validations.ts). Editing Expected Start/Finish below must never
  // recompute or overwrite this; there is simply no code path that does.
  // Duration overrides — null = automatic (calculated from the dates), a
  // string = manual override text. Loaded from the persisted
  // …Overridden flags; see ProjectDurationField / lib/project-duration.ts.
  const [expectedDaysManual, setExpectedDaysManual] = useState<string | null>(null);
  const [actualDaysManual, setActualDaysManual] = useState<string | null>(null);
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [expectedFinishDate, setExpectedFinishDate] = useState("");
  const [expenseTypeId, setExpenseTypeId] = useState("");
  // Not stored — Project.budget/estimatedCost/actualCost no longer exist as
  // DB columns. These are derived totals computed server-side (GET
  // /api/projects/[id] via withProjectFinancials) from this Project's
  // Activities, displayed readonly, and never sent back on PATCH.
  const [estimatedCost, setEstimatedCost] = useState("");
  const [actualCost, setActualCost] = useState("");
  const [external, setExternal] = useState(false);
  const [expenseTypes, setExpenseTypes] = useState<ExpenseTypeOption[]>([]);

  // Facilities Services-only — server-resolved by GET /api/projects/[id]
  // itself (isFacilitiesServicesWorkspace: id comparison only, never a
  // display-name match), never re-derived here. Starts at the stored
  // precision/quarter/year/exact values exactly as persisted — switching
  // precision below clears the OTHER representation's own local state, so
  // a stale value from before the switch can never be sent alongside the
  // new one.
  const [isFacilitiesServicesWorkspace, setIsFacilitiesServicesWorkspace] = useState(false);
  const [facilitiesCompany, setFacilitiesCompany] = useState("");
  const [facilitiesLocation, setFacilitiesLocation] = useState("");
  const [facilitiesCategory, setFacilitiesCategory] = useState("");
  // Directly entered — separate from estimatedCost/actualCost above (the
  // read-only Activity-derived rollup). Plain text state, parsed to a
  // number (or null when blank) only at submit time.
  const [facilitiesEstimatedCost, setFacilitiesEstimatedCost] = useState("");
  const [facilitiesEstimatedCostNotes, setFacilitiesEstimatedCostNotes] = useState("");
  const [facilitiesActualCost, setFacilitiesActualCost] = useState("");
  const [facilitiesActualCostNotes, setFacilitiesActualCostNotes] = useState("");
  // Plain booleans, default unchecked — manually maintained, never
  // derived/calculated (see this feature's own business-rule doc comment
  // in prisma/schema.prisma).
  const [facilitiesPlannedForAnnualTargets, setFacilitiesPlannedForAnnualTargets] = useState(false);
  const [facilitiesIsBigProject, setFacilitiesIsBigProject] = useState(false);
  const [facStartPrecision, setFacStartPrecision] = useState<"EXACT" | "QUARTER">("EXACT");
  const [facStartQuarter, setFacStartQuarter] = useState("");
  const [facStartYear, setFacStartYear] = useState("");
  const [facEndPrecision, setFacEndPrecision] = useState<"EXACT" | "QUARTER">("EXACT");
  const [facEndQuarter, setFacEndQuarter] = useState("");
  const [facEndYear, setFacEndYear] = useState("");
  // Project Scoring. `facilitiesScorePercent` is the server-computed value
  // as of the last load/save — NOT recalculated per keystroke (that would
  // mean a live API call on every selection change, which conflicts with
  // "efficient, not per-project"). `savedImportance`/`savedScore` are the
  // snapshot it was computed against; once either current value drifts
  // from that snapshot, the displayed Score is flagged as stale (still
  // shown, never hidden) until the next successful Save refreshes both.
  const [facilitiesProjectImportanceOverall, setFacilitiesProjectImportanceOverall] = useState("");
  const [facilitiesProjectScore, setFacilitiesProjectScore] = useState("");
  const [facilitiesScorePercent, setFacilitiesScorePercent] = useState<number | null>(null);
  const [savedScoreInputs, setSavedScoreInputs] = useState({ importance: "", score: "" });
  const scoreInputsDirty = facilitiesProjectImportanceOverall !== savedScoreInputs.importance || facilitiesProjectScore !== savedScoreInputs.score;

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => {
        if (p?.title) {
          setTitle(p.title);
          setDescription(p.description ?? "");
          setStatus(p.status);
          // Clamp to max priority 3 (High) in case legacy value of 4 exists
          setPriority(String(Math.min(p.priority ?? 2, 3)));
          setStartDate(p.startDate ? p.startDate.split("T")[0] : "");
          setEndDate(p.endDate ? p.endDate.split("T")[0] : "");
          setActualDaysManual(p.actualTotalDaysOverridden ? String(p.actualTotalDays ?? "") : null);
          setIsFacilitiesServicesWorkspace(p.isFacilitiesServicesWorkspace ?? false);
          setFacilitiesCompany(p.facilitiesCompany ?? "");
          setFacilitiesLocation(p.facilitiesLocation ?? "");
          setFacilitiesCategory(p.facilitiesCategory ?? "");
          setFacilitiesEstimatedCost(p.facilitiesEstimatedCost !== null && p.facilitiesEstimatedCost !== undefined ? String(p.facilitiesEstimatedCost) : "");
          setFacilitiesEstimatedCostNotes(p.facilitiesEstimatedCostNotes ?? "");
          setFacilitiesActualCost(p.facilitiesActualCost !== null && p.facilitiesActualCost !== undefined ? String(p.facilitiesActualCost) : "");
          setFacilitiesActualCostNotes(p.facilitiesActualCostNotes ?? "");
          setFacilitiesPlannedForAnnualTargets(p.facilitiesPlannedForAnnualTargets ?? false);
          setFacilitiesIsBigProject(p.facilitiesIsBigProject ?? false);
          {
            const importanceStr = p.facilitiesProjectImportanceOverall !== null && p.facilitiesProjectImportanceOverall !== undefined ? String(p.facilitiesProjectImportanceOverall) : "";
            const scoreStr = p.facilitiesProjectScore !== null && p.facilitiesProjectScore !== undefined ? String(p.facilitiesProjectScore) : "";
            setFacilitiesProjectImportanceOverall(importanceStr);
            setFacilitiesProjectScore(scoreStr);
            setFacilitiesScorePercent(typeof p.facilitiesScorePercent === "number" ? p.facilitiesScorePercent : null);
            setSavedScoreInputs({ importance: importanceStr, score: scoreStr });
          }
          setFacStartPrecision(p.facilitiesStartPrecision === "QUARTER" ? "QUARTER" : "EXACT");
          setFacStartQuarter(p.facilitiesStartQuarter ?? "");
          setFacStartYear(p.facilitiesStartYear ? String(p.facilitiesStartYear) : "");
          setFacEndPrecision(p.facilitiesEndPrecision === "QUARTER" ? "QUARTER" : "EXACT");
          setFacEndQuarter(p.facilitiesEndQuarter ?? "");
          setFacEndYear(p.facilitiesEndYear ? String(p.facilitiesEndYear) : "");
          setSuccessTarget(p.successTarget ?? "");
          setIsGoal(p.isGoal ?? false);
          setSubDepartmentId(p.subDepartmentId ?? "");
          // Pre-select existing members
          const existingIds = new Set<string>(
            (p.members ?? []).map((m: { id: string }) => m.id)
          );
          setSelectedMemberIds(existingIds);
          setSelectedAudienceIds(new Set((p.audience ?? []).map((a: { id: string }) => a.id)));
          setSelectedResponsiblePeopleIds(new Set((p.responsiblePeople ?? []).map((r: { id: string }) => r.id)));
          setSelectedAudienceDepartmentIds(new Set((p.audienceDepartments ?? []).map((d: { id: string }) => d.id)));
          setSelectedAudienceBusinessUnitIds(new Set((p.audienceBusinessUnits ?? []).map((b: { id: string }) => b.id)));

          setProjectRequestId(p.projectRequestId ?? null);
          if (p.projectRequestId) {
            setExpectedDaysManual(p.expectedTotalInitialDaysOverridden ? String(p.expectedTotalInitialDays ?? "") : null);
            setExpectedStartDate(p.expectedStartDate ? p.expectedStartDate.split("T")[0] : "");
            setExpectedFinishDate(p.expectedFinishDate ? p.expectedFinishDate.split("T")[0] : "");
            setExpenseTypeId(p.expenseTypeId ?? "");
            // Server-derived (withProjectFinancials) — current authoritative
            // totals from this Project's Activities, display-only.
            setEstimatedCost(p.estimatedCost !== null && p.estimatedCost !== undefined ? String(p.estimatedCost) : "0");
            setActualCost(p.actualCost !== null && p.actualCost !== undefined ? String(p.actualCost) : "0");
            setExternal(p.external ?? false);
            fetch("/api/project-expense-types")
              .then((r) => (r.ok ? r.json() : []))
              .then((types: ExpenseTypeOption[]) => {
                // A now-INACTIVE type this Project already references must
                // still appear in the dropdown (and stay selected) — the
                // active-only list alone would silently hide it.
                if (p.expenseType && !types.some((t) => t.id === p.expenseType.id)) {
                  types = [...types, { id: p.expenseType.id, name: p.expenseType.name }];
                }
                setExpenseTypes(types);
              })
              .catch(() => {});
          }

          // Eligible members/sub-departments depend on the project's own
          // department (fixed — this form doesn't let you move departments)
          // — fetched once we know it, not in parallel with the project itself.
          if (p.departmentId) {
            fetch(`/api/users?assignableFor=project&departmentId=${p.departmentId}`)
              .then((r) => (r.ok ? r.json() : []))
              .then((users) => setAssignableUsers(Array.isArray(users) ? users : []));
            fetch(`/api/departments/${p.departmentId}/sub-departments`)
              .then((r) => (r.ok ? r.json() : []))
              .then((options) => setSubDepartments(Array.isArray(options) ? options : []));
          } else {
            fetch("/api/users?assignableFor=project")
              .then((r) => (r.ok ? r.json() : []))
              .then((users) => setAssignableUsers(Array.isArray(users) ? users : []));
          }
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Audience — Users options — fetched once, independent of the Project's
  // own department (unlike Members above), same "any active user in the
  // system" rule Owner(s) always used.
  useEffect(() => {
    fetch("/api/users")
      .then((r) => (r.ok ? r.json() : []))
      .then((users) => setSystemWideUsers(Array.isArray(users) ? users : []))
      .catch(() => {});
  }, []);

  // Organizational Audience options — fetched once, independent of the
  // Project's own department (unlike Members above).
  useEffect(() => {
    fetch("/api/departments")
      .then((r) => (r.ok ? r.json() : []))
      .then((depts) => setAudienceDepartmentOptions(Array.isArray(depts) ? depts : []))
      .catch(() => {});
    fetch("/api/business-units")
      .then((r) => (r.ok ? r.json() : []))
      .then((bus) => setAudienceBusinessUnitOptions(Array.isArray(bus) ? bus : []))
      .catch(() => {});
  }, []);

  const toggleAudienceMember = (userId: string) => {
    setSelectedAudienceIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };
  const audienceSearchResults = (() => {
    const q = audienceSearch.trim().toLowerCase();
    if (!q) return systemWideUsers;
    return systemWideUsers.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  })();

  const toggleResponsiblePerson = (userId: string) => {
    setSelectedResponsiblePeopleIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };
  const responsiblePeopleSearchResults = (() => {
    const q = responsiblePeopleSearch.trim().toLowerCase();
    if (!q) return systemWideUsers;
    return systemWideUsers.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  })();

  const toggleAudienceDepartment = (deptId: string) => {
    setSelectedAudienceDepartmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };
  const toggleAudienceBusinessUnit = (buId: string) => {
    setSelectedAudienceBusinessUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(buId)) next.delete(buId);
      else next.add(buId);
      return next;
    });
  };
  const audienceDepartmentSearchResults = audienceDepartmentOptions.filter((d) => d.name.toLowerCase().includes(audienceDepartmentSearch.trim().toLowerCase()));
  const audienceBusinessUnitSearchResults = audienceBusinessUnitOptions.filter((b) => b.name.toLowerCase().includes(audienceBusinessUnitSearch.trim().toLowerCase()));

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (projectRequestId && expectedStartDate && expectedFinishDate && new Date(expectedFinishDate) < new Date(expectedStartDate)) {
      toast.error("Expected Finish Date cannot be before Expected Start Date.");
      return;
    }
    // Duration overrides — a UX convenience only; re-validated server-side.
    const actualOverride = parseDurationOverride(actualDaysManual);
    if (!actualOverride.ok) {
      toast.error("Actual Total Days must be a whole number of days (0 or more).");
      return;
    }
    const expectedOverride = parseDurationOverride(projectRequestId ? expectedDaysManual : null);
    if (!expectedOverride.ok) {
      toast.error("Expected Total Initial Days must be a whole number of days (0 or more).");
      return;
    }
    // Facilities Services-only — a UX convenience only; the server
    // (resolveFacilitiesWrite) re-validates all of this regardless.
    if (isFacilitiesServicesWorkspace) {
      if (facStartPrecision === "QUARTER" && (!facStartQuarter || !facStartYear)) {
        toast.error("Select both a Quarter and a Year for Start.");
        return;
      }
      if (facEndPrecision === "QUARTER" && (!facEndQuarter || !facEndYear)) {
        toast.error("Select both a Quarter and a Year for End.");
        return;
      }
      for (const [raw, label] of [
        [facilitiesEstimatedCost, "Estimated Cost"],
        [facilitiesActualCost, "Actual Cost"],
      ] as const) {
        if (raw.trim() === "") continue;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          toast.error(`${label} must be a non-negative number.`);
          return;
        }
        if (Math.abs(Math.round(parsed * 100) - parsed * 100) > 1e-6) {
          toast.error(`${label} supports at most 2 decimal places.`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          status,
          priority: parseInt(priority),
          // Facilities Services: Start/End are driven by the precision
          // toggle below (an exact date still flows through this SAME
          // startDate/endDate field; Quarter mode sends quarter+year
          // instead and intentionally omits startDate/endDate so the
          // server's own resolveFacilitiesWrite derives the boundary,
          // never a stale value from before a precision switch). Every
          // other workspace: the exact, unmodified pre-existing behavior.
          ...(isFacilitiesServicesWorkspace
            ? {
                facilitiesCompany: facilitiesCompany.trim() || null,
                facilitiesLocation: facilitiesLocation.trim() || null,
                facilitiesCategory: facilitiesCategory.trim() || null,
                facilitiesEstimatedCost: facilitiesEstimatedCost.trim() === "" ? null : Number(facilitiesEstimatedCost),
                facilitiesEstimatedCostNotes: facilitiesEstimatedCostNotes.trim() || null,
                facilitiesActualCost: facilitiesActualCost.trim() === "" ? null : Number(facilitiesActualCost),
                facilitiesActualCostNotes: facilitiesActualCostNotes.trim() || null,
                facilitiesPlannedForAnnualTargets,
                facilitiesIsBigProject,
                facilitiesProjectImportanceOverall: facilitiesProjectImportanceOverall === "" ? null : Number(facilitiesProjectImportanceOverall),
                facilitiesProjectScore: facilitiesProjectScore === "" ? null : Number(facilitiesProjectScore),
                facilitiesStartPrecision: facStartPrecision,
                facilitiesStartQuarter: facStartPrecision === "QUARTER" ? facStartQuarter : null,
                facilitiesStartYear: facStartPrecision === "QUARTER" ? (facStartYear ? parseInt(facStartYear) : null) : null,
                startDate: facStartPrecision === "EXACT" ? startDate || null : undefined,
                facilitiesEndPrecision: facEndPrecision,
                facilitiesEndQuarter: facEndPrecision === "QUARTER" ? facEndQuarter : null,
                facilitiesEndYear: facEndPrecision === "QUARTER" ? (facEndYear ? parseInt(facEndYear) : null) : null,
                endDate: facEndPrecision === "EXACT" ? endDate || null : undefined,
              }
            : // Full-snapshot form: an emptied date is sent as an explicit
              // null so clearing it actually persists.
              { startDate: startDate || null, endDate: endDate || null }),
          // Always sent (full-snapshot form): a number persists a manual
          // override, null returns to the calculated value.
          actualTotalDaysOverride: actualOverride.value,
          successTarget: successTarget || undefined,
          memberIds: Array.from(selectedMemberIds),
          audienceIds: Array.from(selectedAudienceIds),
          audienceDepartmentIds: Array.from(selectedAudienceDepartmentIds),
          audienceBusinessUnitIds: Array.from(selectedAudienceBusinessUnitIds),
          responsiblePeopleIds: Array.from(selectedResponsiblePeopleIds),
          isGoal,
          subDepartmentId: subDepartmentId || null,
          // All 7 fields are OPTIONAL here (unlike at request-origin setup
          // time, which stays strictly required — see
          // createProjectFromRequestSchema). This form is always a full
          // snapshot of the currently-displayed state, so an empty field is
          // sent as an explicit `null` ("clear it"), never `undefined`
          // ("leave untouched") and never `Number("")` (`=== 0`, which would
          // silently turn an intentionally-cleared money field into €0.00).
          // See updateProjectRequestOriginFieldsSchema's doc comment for how
          // the PATCH route tells `null` and `undefined` apart.
          ...(projectRequestId
            ? {
                expectedStartDate: expectedStartDate || null,
                expectedFinishDate: expectedFinishDate || null,
                expectedTotalInitialDaysOverride: expectedOverride.value,
                expenseTypeId: expenseTypeId || null,
                // Estimated/Actual Cost are derived server-side and never
                // part of the editable PATCH payload — see
                // updateProjectRequestOriginFieldsSchema in lib/validations.ts.
                external,
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update project");
      }
      toast.success("Project updated");
      router.push(`/projects/${id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update project");
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // No max-width cap (previously max-w-2xl, then max-w-4xl) — a fixed
    // Tailwind cap always clamps at SOME fixed px value regardless of how
    // much room <main> actually has (measured: 720px of unused width at a
    // 1920px viewport, 1360px at 2560px). Fills whatever <main> gives it
    // instead (page padding is <main>'s own p-4 sm:p-6 in
    // app/(main)/layout.tsx, untouched here) — this form's own internal
    // grids distribute that width proportionally on their own.
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/projects/${id}`} className="hover:text-foreground truncate max-w-[200px]">
          {title}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Edit</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit Project</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                placeholder="Project title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Project description..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            {/* Sub-Department (when this department has any configured)
                joins Status/Priority in one responsive row instead of its
                own standalone row — three short single-value selects group
                naturally. Column count adapts to whether Sub-Department is
                actually rendered, so the row never ends with a visually
                empty trailing cell on wide screens. Collapses to a single
                column below `sm` (mobile), 2-up from `sm`, and the full
                adaptive count only from `lg` upward. */}
            <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${subDepartments.length > 0 ? "lg:grid-cols-3" : ""}`}>
              {subDepartments.length > 0 && (
                <div className="space-y-2">
                  <Label>Sub-Department</Label>
                  <Select value={subDepartmentId || "__none__"} onValueChange={(v) => setSubDepartmentId(v === "__none__" ? "" : v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {subDepartments.map((sd) => (
                        <SelectItem key={sd.id} value={sd.id}>
                          {sd.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ProjectStatus).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
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

            {isFacilitiesServicesWorkspace ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FacilitiesDateField
                  label="Start"
                  precision={facStartPrecision}
                  onPrecisionChange={(p) => {
                    setFacStartPrecision(p);
                    setStartDate("");
                    setFacStartQuarter("");
                    setFacStartYear("");
                  }}
                  exactValue={startDate}
                  onExactChange={setStartDate}
                  quarter={facStartQuarter}
                  onQuarterChange={setFacStartQuarter}
                  year={facStartYear}
                  onYearChange={setFacStartYear}
                />
                <FacilitiesDateField
                  label="End"
                  precision={facEndPrecision}
                  onPrecisionChange={(p) => {
                    setFacEndPrecision(p);
                    setEndDate("");
                    setFacEndQuarter("");
                    setFacEndYear("");
                  }}
                  exactValue={endDate}
                  onExactChange={setEndDate}
                  quarter={facEndQuarter}
                  onQuarterChange={setFacEndQuarter}
                  year={facEndYear}
                  onYearChange={setFacEndYear}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date</Label>
                  <Input
                    id="endDate"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ProjectDurationField
                id="actualTotalDays"
                label="Actual Total Days"
                calculatedValue={
                  isFacilitiesServicesWorkspace
                    ? calculateProjectDurationDays(
                        facilitiesBoundaryPreview("start", facStartPrecision, startDate, facStartQuarter, facStartYear),
                        facilitiesBoundaryPreview("end", facEndPrecision, endDate, facEndQuarter, facEndYear)
                      )
                    : calculateProjectDurationDays(startDate, endDate)
                }
                manualText={actualDaysManual}
                onManualTextChange={setActualDaysManual}
                sourceLabel="Start/End Date"
                disabled={saving}
              />
            </div>

            {isFacilitiesServicesWorkspace && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="facilitiesCompany">Company</Label>
                  <Input
                    id="facilitiesCompany"
                    placeholder="One or more company names…"
                    value={facilitiesCompany}
                    onChange={(e) => setFacilitiesCompany(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="facilitiesLocation">Location</Label>
                  <Input
                    id="facilitiesLocation"
                    placeholder="Where this project takes place…"
                    value={facilitiesLocation}
                    onChange={(e) => setFacilitiesLocation(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="facilitiesCategory">Category</Label>
                  <Input
                    id="facilitiesCategory"
                    placeholder="e.g. Maintenance, Renovation…"
                    value={facilitiesCategory}
                    onChange={(e) => setFacilitiesCategory(e.target.value)}
                  />
                </div>
                <div className="sm:col-span-2 flex flex-wrap gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded"
                      checked={facilitiesPlannedForAnnualTargets}
                      onChange={(e) => setFacilitiesPlannedForAnnualTargets(e.target.checked)}
                    />
                    <span className="text-sm font-medium">Planned for This Year&apos;s Targets</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded"
                      checked={facilitiesIsBigProject}
                      onChange={(e) => setFacilitiesIsBigProject(e.target.checked)}
                    />
                    <span className="text-sm font-medium">Big Project</span>
                  </label>
                </div>
              </div>
            )}

            {isFacilitiesServicesWorkspace && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Facilities Costs</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Directly entered — separate from any Activity-based cost calculation.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesEstimatedCost">Estimated Cost (EUR)</Label>
                    <Input
                      id="facilitiesEstimatedCost"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={facilitiesEstimatedCost}
                      onChange={(e) => setFacilitiesEstimatedCost(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesActualCost">Actual Cost (EUR)</Label>
                    <Input
                      id="facilitiesActualCost"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={facilitiesActualCost}
                      onChange={(e) => setFacilitiesActualCost(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesEstimatedCostNotes">Estimated Cost Notes</Label>
                    <Textarea
                      id="facilitiesEstimatedCostNotes"
                      placeholder="Optional notes…"
                      value={facilitiesEstimatedCostNotes}
                      onChange={(e) => setFacilitiesEstimatedCostNotes(e.target.value)}
                      className="min-h-[100px]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesActualCostNotes">Actual Cost Notes</Label>
                    <Textarea
                      id="facilitiesActualCostNotes"
                      placeholder="Optional notes…"
                      value={facilitiesActualCostNotes}
                      onChange={(e) => setFacilitiesActualCostNotes(e.target.value)}
                      className="min-h-[100px]"
                    />
                  </div>
                </div>
              </div>
            )}

            {isFacilitiesServicesWorkspace && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Project Scoring</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {scoreInputsDirty
                      ? "Score below reflects previously saved values — save to recalculate."
                      : "Score is recalculated whenever Facilities Projects change."}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesProjectImportanceOverall">Project Importance Overall</Label>
                    <Select value={facilitiesProjectImportanceOverall} onValueChange={setFacilitiesProjectImportanceOverall}>
                      <SelectTrigger id="facilitiesProjectImportanceOverall">
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_IMPORTANCE_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesProjectImportanceScore">Project Importance Score</Label>
                    <Input
                      id="facilitiesProjectImportanceScore"
                      disabled
                      readOnly
                      value={formatScorePercent(getImportanceScoreFraction(facilitiesProjectImportanceOverall === "" ? null : Number(facilitiesProjectImportanceOverall)))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesProjectScore">Project Score</Label>
                    <Select value={facilitiesProjectScore} onValueChange={setFacilitiesProjectScore}>
                      <SelectTrigger id="facilitiesProjectScore">
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_SCORE_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="facilitiesScore">Score{scoreInputsDirty ? " (previously saved)" : ""}</Label>
                    <Input id="facilitiesScore" disabled readOnly value={formatScorePercent(facilitiesScorePercent)} />
                  </div>
                </div>
              </div>
            )}

            {/* Request-origin-only fields — only ever shown for a Project
                created through the request-origin setup flow. A
                manually-created Project never sees (or needs) this block. */}
            {projectRequestId && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Project Request Setup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Metadata from this Project's originating Project Request.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expectedStartDate">Expected Start Date</Label>
                    <Input id="expectedStartDate" type="date" value={expectedStartDate} onChange={(e) => setExpectedStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expectedFinishDate">Expected Finish Date</Label>
                    <Input id="expectedFinishDate" type="date" value={expectedFinishDate} onChange={(e) => setExpectedFinishDate(e.target.value)} />
                  </div>
                </div>

                {/* Expense Type paired with Expected Total Initial Days —
                    both single, short fields, grouped the same way Expected
                    Start/Finish are above. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Expense Type</Label>
                    <Select value={expenseTypeId || "__none__"} onValueChange={(v) => setExpenseTypeId(v === "__none__" ? "" : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {expenseTypes.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <ProjectDurationField
                    id="expectedTotalInitialDays"
                    label="Expected Total Initial Days"
                    calculatedValue={calculateProjectDurationDays(expectedStartDate, expectedFinishDate)}
                    manualText={expectedDaysManual}
                    onManualTextChange={setExpectedDaysManual}
                    sourceLabel="Expected Start/Finish Date"
                    disabled={saving}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="estimatedCost">Estimated Cost (EUR)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                      <Input
                        id="estimatedCost"
                        type="text"
                        inputMode="none"
                        readOnly
                        aria-readonly="true"
                        tabIndex={-1}
                        className="pl-7 cursor-default bg-muted/40"
                        value={Number(estimatedCost || 0).toFixed(2)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Calculated automatically from this Project's Activities.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="actualCost">Actual Cost (EUR)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                      <Input
                        id="actualCost"
                        type="text"
                        inputMode="none"
                        readOnly
                        aria-readonly="true"
                        tabIndex={-1}
                        className="pl-7 cursor-default bg-muted/40"
                        value={Number(actualCost || 0).toFixed(2)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Calculated automatically from completed Activities.</p>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 rounded" checked={external} onChange={(e) => setExternal(e.target.checked)} />
                  <span className="text-sm font-medium">External</span>
                </label>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="successTarget">Success Target</Label>
              <Textarea
                id="successTarget"
                placeholder="What does success look like?"
                value={successTarget}
                onChange={(e) => setSuccessTarget(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded"
                  checked={isGoal}
                  onChange={(e) => setIsGoal(e.target.checked)}
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
                Only users eligible for this workspace are listed.
              </p>
              {assignableUsers.length > 0 ? (
                <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {assignableUsers.map((u) => (
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
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                  No eligible users for this workspace yet.
                </p>
              )}
            </div>

            {/* Audience — Users: available on every Project as of Phase
                1.1 (previously creation-time-only, no edit surface at
                all). Any active user in the system, same eligibility rule
                Owner(s) always used (Owner(s) itself stays unchanged — set
                only at request-origin creation, no edit surface here). */}
            <div className="space-y-2">
              <Label htmlFor="project-audience">Audience — Users</Label>
              <p className="text-xs text-muted-foreground">Optional — users who should be able to view this Project&apos;s progress without being a Member or an Owner. Any active user in the system.</p>
              <Input placeholder="Search by name or email…" value={audienceSearch} onChange={(e) => setAudienceSearch(e.target.value)} className="h-8 text-sm" />
              {systemWideUsers.length > 0 ? (
                <div id="project-audience" className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {audienceSearchResults.map((u) => (
                    <label key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
                      <input type="checkbox" className="h-4 w-4 rounded" checked={selectedAudienceIds.has(u.id)} onChange={() => toggleAudienceMember(u.id)} />
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

            {/* Responsible People (Phase 2) — a PERMANENT, independent
                relationship, deliberately separate from Owner(s)/Members/
                Audience above (never written into any of those). Same
                system-wide eligibility, same read-only visibility as
                Audience (buildProjectAudienceWhere). */}
            <div className="space-y-2">
              <Label htmlFor="project-responsible-people">Responsible People</Label>
              <p className="text-xs text-muted-foreground">Optional — users responsible for this Project, independent of Owner(s), Members and Audience. Any active user in the system.</p>
              <Input placeholder="Search by name or email…" value={responsiblePeopleSearch} onChange={(e) => setResponsiblePeopleSearch(e.target.value)} className="h-8 text-sm" />
              {systemWideUsers.length > 0 ? (
                <div id="project-responsible-people" className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {responsiblePeopleSearchResults.map((u) => (
                    <label key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
                      <input type="checkbox" className="h-4 w-4 rounded" checked={selectedResponsiblePeopleIds.has(u.id)} onChange={() => toggleResponsiblePerson(u.id)} />
                      <span className="text-sm">{u.name ?? u.email}</span>
                    </label>
                  ))}
                  {responsiblePeopleSearchResults.length === 0 && (
                    <p className="text-xs text-muted-foreground px-3 py-2">No users match &quot;{responsiblePeopleSearch}&quot;.</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">No active users exist yet.</p>
              )}
            </div>

            {/* Organizational Audience (Phase 1) — available on every
                Project, same as Audience — Users above. Selecting a
                Department/Business Unit grants dynamic, live-resolved read
                access to its CURRENT active members — see
                hasProjectViewAccess in lib/services/project-access-service.ts. */}
            <div className="space-y-2">
              <Label htmlFor="project-audience-departments">Audience — Departments</Label>
              <p className="text-xs text-muted-foreground">Optional — every active member of the selected Department(s) can view this Project, dynamically.</p>
              <Input placeholder="Search departments…" value={audienceDepartmentSearch} onChange={(e) => setAudienceDepartmentSearch(e.target.value)} className="h-8 text-sm" />
              {audienceDepartmentOptions.length > 0 ? (
                <div id="project-audience-departments" className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {audienceDepartmentSearchResults.map((d) => (
                    <label key={d.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
                      <input type="checkbox" className="h-4 w-4 rounded" checked={selectedAudienceDepartmentIds.has(d.id)} onChange={() => toggleAudienceDepartment(d.id)} />
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm">{d.name}</span>
                    </label>
                  ))}
                  {audienceDepartmentSearchResults.length === 0 && (
                    <p className="text-xs text-muted-foreground px-3 py-2">No departments match &quot;{audienceDepartmentSearch}&quot;.</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">No active departments exist.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-audience-business-units">Audience — Business Units</Label>
              <p className="text-xs text-muted-foreground">Optional — every active member of any Department under the selected Business Unit(s) can view this Project, dynamically.</p>
              <Input placeholder="Search business units…" value={audienceBusinessUnitSearch} onChange={(e) => setAudienceBusinessUnitSearch(e.target.value)} className="h-8 text-sm" />
              {audienceBusinessUnitOptions.length > 0 ? (
                <div id="project-audience-business-units" className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {audienceBusinessUnitSearchResults.map((b) => (
                    <label key={b.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
                      <input type="checkbox" className="h-4 w-4 rounded" checked={selectedAudienceBusinessUnitIds.has(b.id)} onChange={() => toggleAudienceBusinessUnit(b.id)} />
                      <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm">{b.name}</span>
                    </label>
                  ))}
                  {audienceBusinessUnitSearchResults.length === 0 && (
                    <p className="text-xs text-muted-foreground px-3 py-2">No business units match &quot;{audienceBusinessUnitSearch}&quot;.</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">No business units exist.</p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
