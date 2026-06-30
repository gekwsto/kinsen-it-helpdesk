"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Plug, TestTube2, ExternalLink } from "lucide-react";
import Link from "next/link";
import { formatTicketNumber } from "@/lib/utils";

interface ConnectionResult {
  tokenOk: boolean;
  mailboxOk: boolean;
  mailboxEmail?: string;
  unreadCount?: number;
  error?: string;
  details?: string;
}

interface TestTicketResult {
  success: boolean;
  ticketId?: string;
  ticketNumber?: number;
  title?: string;
  error?: string;
}

export function EmailAdminActions() {
  const router = useRouter();
  const [connResult, setConnResult] = useState<ConnectionResult | null>(null);
  const [ticketResult, setTicketResult] = useState<TestTicketResult | null>(null);
  const [testingConn, startConnTest] = useTransition();
  const [creatingTicket, startTicketCreate] = useTransition();

  function runConnectionTest() {
    startConnTest(async () => {
      setConnResult(null);
      const res = await fetch("/api/admin/email/test-connection", { method: "POST" });
      const data = await res.json();
      setConnResult(data);
    });
  }

  function runTestTicket() {
    startTicketCreate(async () => {
      setTicketResult(null);
      const res = await fetch("/api/admin/email/test-ticket", { method: "POST" });
      const data = await res.json();
      setTicketResult(data);
      if (data.success) router.refresh();
    });
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
      <p className="text-sm font-medium">Diagnostics</p>

      <div className="grid sm:grid-cols-2 gap-3">
        {/* Test Connection */}
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runConnectionTest}
            disabled={testingConn}
            className="w-full justify-start gap-2"
          >
            {testingConn ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            Test Microsoft Connection
          </Button>

          {connResult && (
            <div className="rounded-md border bg-background p-3 space-y-1.5 text-xs">
              <div className="flex items-center gap-1.5">
                {connResult.tokenOk ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                )}
                <span className={connResult.tokenOk ? "text-emerald-700" : "text-destructive font-medium"}>
                  Token: {connResult.tokenOk ? "OK" : "Failed"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {connResult.mailboxOk ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                )}
                <span className={connResult.mailboxOk ? "text-emerald-700" : "text-destructive font-medium"}>
                  Mailbox: {connResult.mailboxOk ? "OK" : "Failed"}
                </span>
              </div>
              {connResult.mailboxOk && connResult.mailboxEmail && (
                <p className="text-muted-foreground pl-5">
                  {connResult.mailboxEmail}
                  {connResult.unreadCount !== undefined && (
                    <span> · {connResult.unreadCount} unread</span>
                  )}
                </p>
              )}
              {connResult.error && (
                <p className="text-destructive pl-5 break-words">{connResult.error}</p>
              )}
              {connResult.details && (
                <p className="text-muted-foreground pl-5 font-mono break-all text-[10px]">
                  {connResult.details}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Create Test Ticket */}
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runTestTicket}
            disabled={creatingTicket}
            className="w-full justify-start gap-2"
          >
            {creatingTicket ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TestTube2 className="h-4 w-4" />
            )}
            Send Test Email Ticket
          </Button>

          {ticketResult && (
            <div className="rounded-md border bg-background p-3 space-y-1.5 text-xs">
              {ticketResult.success ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                    <span className="text-emerald-700 font-medium">Ticket created</span>
                  </div>
                  {ticketResult.ticketNumber && ticketResult.ticketId && (
                    <Link
                      href={`/tickets/${ticketResult.ticketId}`}
                      className="flex items-center gap-1 pl-5 text-primary hover:underline font-mono"
                    >
                      {formatTicketNumber(ticketResult.ticketNumber)}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                  {ticketResult.title && (
                    <p className="text-muted-foreground pl-5 truncate">{ticketResult.title}</p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <XCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                    <span className="text-destructive font-medium">Failed</span>
                  </div>
                  {ticketResult.error && (
                    <p className="text-destructive pl-5 break-words">{ticketResult.error}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
