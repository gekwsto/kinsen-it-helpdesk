import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmailPollButton } from "@/components/admin/email-poll-button";
import { EmailAdminActions } from "@/components/admin/email-admin-actions";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { getCentralMailbox } from "@/lib/microsoft-graph";
import { listConfiguredDepartmentMailboxes } from "@/lib/services/inbound-mailbox-service";
import { Mail, CheckCircle2, XCircle, Clock, SkipForward, AlertCircle, ShieldCheck, ShieldOff, Building2 } from "lucide-react";

const MAILBOX = getCentralMailbox();

/** One entry of EmailPollRun.mailboxResults — see that column's schema comment in prisma/schema.prisma. */
interface MailboxResult {
  mailbox: string;
  kind: "central" | "department";
  departmentId: string | null;
  departmentName: string | null;
  ok: boolean;
  error: string | null;
  fetched: number;
  created: number;
  appended: number;
  skipped: number;
  errors: number;
}

const ACTION_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CREATED_TICKET:    { label: "New ticket",    variant: "default" },
  APPENDED_REPLY:    { label: "Reply added",   variant: "secondary" },
  SKIPPED_DUPLICATE: { label: "Duplicate",     variant: "outline" },
  SKIPPED_LOOP:      { label: "Auto-reply",    variant: "outline" },
  FAILED:            { label: "Failed",        variant: "destructive" },
};

export default async function EmailAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireAdmin();
  } catch {
    redirect("/dashboard");
  }

  const [recentRuns, recentLogs, totalStats, departmentMailboxes] = await Promise.all([
    prisma.emailPollRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 15,
    }),
    prisma.emailProcessingLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.emailPollRun.aggregate({
      _sum: { created: true, appended: true, skipped: true, errors: true },
    }),
    listConfiguredDepartmentMailboxes(),
  ]);

  const lastRun = recentRuns[0] ?? null;
  const lastSuccess = recentRuns.find((r) => r.succeeded) ?? null;
  const lastError = recentRuns.find((r) => !r.succeeded && r.lastError)?.lastError ?? null;

  // Most recent per-mailbox breakdown, from the newest run that actually has
  // one (older rows predate the mailboxResults column and are simply
  // skipped, never guessed at) — pure DB read, no Graph calls, so this is
  // safe to render unconditionally on every page load.
  const mailboxResultsRun = recentRuns.find((r) => r.mailboxResults != null) ?? null;
  const lastMailboxResults = (mailboxResultsRun?.mailboxResults as unknown as MailboxResult[] | null) ?? [];
  const lastResultByMailbox = new Map(lastMailboxResults.map((m) => [m.mailbox, m]));

  const cronSecret = process.env.CRON_SECRET ? "configured" : "not set";
  const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET ? "configured" : "not set";

  const envVars = [
    { name: "GRAPH_TENANT_ID",     set: !!process.env.GRAPH_TENANT_ID,     label: "Azure Tenant ID" },
    { name: "GRAPH_CLIENT_ID",     set: !!process.env.GRAPH_CLIENT_ID,     label: "Azure Client ID" },
    { name: "GRAPH_CLIENT_SECRET", set: !!process.env.GRAPH_CLIENT_SECRET, label: "Azure Client Secret" },
    { name: "GRAPH_USER_EMAIL",    set: !!process.env.GRAPH_USER_EMAIL,    label: "Mailbox Email" },
    { name: "EMAIL_WEBHOOK_SECRET",set: !!process.env.EMAIL_WEBHOOK_SECRET,label: "Webhook Secret" },
    { name: "CRON_SECRET",         set: !!process.env.CRON_SECRET,         label: "Cron Secret" },
  ];

  return (
    <div className="space-y-8 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Mail className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Email Integration</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Inbound mailbox monitoring and email-to-ticket processing
            </p>
          </div>
        </div>
        <EmailPollButton />
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Central mailbox */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Central Mailbox
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium text-sm break-all">{MAILBOX}</p>
            <p className="text-xs text-muted-foreground mt-1">
              + {departmentMailboxes.filter((d) => d.isActive).length} department mailbox
              {departmentMailboxes.filter((d) => d.isActive).length !== 1 ? "es" : ""} polled every ~2 min
            </p>
          </CardContent>
        </Card>

        {/* Last poll */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Last Poll
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lastRun ? (
              <>
                <div className="flex items-center gap-1.5">
                  {lastRun.succeeded ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                  )}
                  <span className="font-medium text-sm">
                    {lastRun.succeeded ? "Success" : "Failed"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatRelative(lastRun.startedAt)}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Never polled</p>
            )}
          </CardContent>
        </Card>

        {/* Last success */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Last Success
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lastSuccess ? (
              <>
                <p className="font-medium text-sm text-emerald-600">
                  {formatRelative(lastSuccess.startedAt)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {lastSuccess.created + lastSuccess.appended} email{lastSuccess.created + lastSuccess.appended !== 1 ? "s" : ""} processed
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">None yet</p>
            )}
          </CardContent>
        </Card>

        {/* All-time totals */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              All-Time Totals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Tickets created</span>
              <span className="font-medium">{totalStats._sum.created ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Replies added</span>
              <span className="font-medium">{totalStats._sum.appended ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Skipped</span>
              <span className="font-medium">{totalStats._sum.skipped ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground text-destructive">Errors</span>
              <span className="font-medium text-destructive">{totalStats._sum.errors ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Department mailboxes */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">Department Mailboxes</p>
        </div>
        {departmentMailboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No department has an inbound email configured yet — every department's own mailbox address (set on the
            department's page) is polled here automatically once configured. Until then, all inbound email is
            routed by recipient address through the central mailbox above.
          </p>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Department</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Mailbox</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Last Poll</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {departmentMailboxes.map((d) => {
                  const lastResult = lastResultByMailbox.get(d.email);
                  return (
                    <tr key={d.departmentId}>
                      <td className="px-3 py-2 text-xs">{d.departmentName}</td>
                      <td className="px-3 py-2 text-xs font-mono break-all">{d.email}</td>
                      <td className="px-3 py-2 text-xs">
                        {!d.isActive ? (
                          <Badge variant="outline" className="text-[10px]">Inactive — not polled</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">Polled every ~2 min</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {!d.isActive ? (
                          <span className="text-muted-foreground">—</span>
                        ) : lastResult ? (
                          <span className={`flex items-center gap-1 ${lastResult.ok ? "text-emerald-600" : "text-destructive"}`}>
                            {lastResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            {lastResult.ok
                              ? `OK · ${lastResult.fetched} fetched`
                              : (lastResult.error ?? "Failed")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not polled yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Use <span className="font-medium">Test Microsoft Connection</span> below to live-check Graph access to
          every configured mailbox, including inactive ones.
        </p>
      </div>

      {/* Last error */}
      {lastError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-destructive">Last error</p>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{lastError}</p>
          </div>
        </div>
      )}

      {/* Environment variable configuration */}
      <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
        <p className="text-sm font-medium">Configuration</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {envVars.map((v) => (
            <div
              key={v.name}
              className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
            >
              {v.set ? (
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
              ) : (
                <ShieldOff className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-[10px] font-mono text-muted-foreground truncate">{v.name}</p>
                <p className={`text-xs font-medium ${v.set ? "text-emerald-700" : "text-destructive"}`}>
                  {v.set ? "Configured" : "Missing"}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          The Docker Compose stack (<code className="bg-background px-1 rounded">docker-compose.yml</code>) already
          includes an <code className="bg-background px-1 rounded">email-poller</code> service that calls this
          endpoint every ~2 minutes automatically — no manual cron needed. It requires{" "}
          <code className="bg-background px-1 rounded">EMAIL_WEBHOOK_SECRET</code> to be set (see Configuration
          above); without it, this endpoint refuses unauthenticated requests in production. For a non-Docker-Compose
          self-hosted deployment, an equivalent server/host cron works too:
        </p>
        <pre className="bg-background rounded border px-3 py-2 text-xs font-mono overflow-x-auto">
          {"*/2 * * * * curl -s -X POST https://your-domain/api/email/inbound \\\n  -H \"Authorization: Bearer $EMAIL_WEBHOOK_SECRET\""}
        </pre>
      </div>

      {/* Diagnostics actions */}
      <EmailAdminActions />

      <div className="grid lg:grid-cols-2 gap-8">
        {/* Recent runs */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Recent Poll Runs</h2>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Started</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">New</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Reply</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Skip</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Err</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-muted/20">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs">{run.created}</td>
                      <td className="px-3 py-2 text-right text-xs">{run.appended}</td>
                      <td className="px-3 py-2 text-right text-xs">{run.skipped}</td>
                      <td className="px-3 py-2 text-right text-xs">
                        {run.errors > 0 ? (
                          <span className="text-destructive font-medium">{run.errors}</span>
                        ) : (
                          run.errors
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {run.succeeded ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent log entries */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Recent Email Log</h2>
          {recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No emails processed yet.</p>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">From</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentLogs.map((log) => {
                    const meta = ACTION_LABELS[log.action] ?? { label: log.action, variant: "outline" as const };
                    return (
                      <tr key={log.id} className="hover:bg-muted/20">
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {formatRelative(log.createdAt)}
                        </td>
                        <td className="px-3 py-2 max-w-[160px]">
                          <p className="text-xs truncate">{log.fromEmail ?? "—"}</p>
                          {log.subject && (
                            <p className="text-[11px] text-muted-foreground truncate">{log.subject}</p>
                          )}
                          {log.mailbox && (
                            <p className="text-[10px] text-muted-foreground/70 truncate" title={`Fetched from ${log.mailbox}`}>
                              via {log.mailbox}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={meta.variant} className="text-[10px] py-0">
                            {meta.label}
                          </Badge>
                          {log.ticketId && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {log.action === "APPENDED_REPLY" ? "ticket" : "ref"}: {log.ticketId.slice(0, 8)}…
                            </p>
                          )}
                          {log.error && (
                            <p className="text-[10px] text-destructive mt-0.5 truncate max-w-[150px]" title={log.error}>
                              {log.error}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
