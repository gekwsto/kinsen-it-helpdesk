import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmailPollButton } from "@/components/admin/email-poll-button";
import { EmailAdminActions } from "@/components/admin/email-admin-actions";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { Mail, CheckCircle2, XCircle, Clock, SkipForward, AlertCircle, ShieldCheck, ShieldOff } from "lucide-react";

const MAILBOX = process.env.GRAPH_USER_EMAIL || process.env.SUPPORT_EMAIL || "kinsenitsupport@kinsen.gr";

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

  const [recentRuns, recentLogs, totalStats] = await Promise.all([
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
  ]);

  const lastRun = recentRuns[0] ?? null;
  const lastSuccess = recentRuns.find((r) => r.succeeded) ?? null;
  const lastError = recentRuns.find((r) => !r.succeeded && r.lastError)?.lastError ?? null;

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
        {/* Mailbox */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Monitored Mailbox
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium text-sm break-all">{MAILBOX}</p>
            <p className="text-xs text-muted-foreground mt-1">Polling every 2 min (Vercel Cron)</p>
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
          Docker / server cron — add to crontab:
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
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={meta.variant} className="text-[10px] py-0">
                            {meta.label}
                          </Badge>
                          {log.ticketId && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              ticket: {log.ticketId.slice(0, 8)}…
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
