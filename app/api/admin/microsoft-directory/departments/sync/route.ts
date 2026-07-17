import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { syncMicrosoftDirectoryDepartments } from "@/lib/services/microsoft-directory-service";

// Never a generic "sync failed" — every reason code gets a specific,
// admin-actionable message. Text, never a stack trace or raw Graph payload.
const SAFE_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Microsoft Graph rejected the app credentials — verify GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/GRAPH_TENANT_ID.",
  no_permission:
    "Microsoft Graph Directory.Read.All application permission with admin consent is required to sync tenant department values. Add it in Microsoft Entra admin center on the app registration used by GRAPH_CLIENT_ID, then grant admin consent — see docs/microsoft-graph-directory-sync.md. This does not affect the per-user login sync, which uses a different permission (User.Read).",
  rate_limited: "Microsoft Graph is throttling requests right now — try again shortly.",
  server_error: "Microsoft Graph returned a server error — try again shortly.",
  network_error: "Could not reach Microsoft Graph — check network connectivity.",
  malformed_response: "Microsoft Graph returned an unexpected response shape.",
};

export async function POST() {
  try {
    await requireAdmin();
    const result = await syncMicrosoftDirectoryDepartments();
    if (!result.ok) {
      return NextResponse.json(
        { error: SAFE_ERROR_MESSAGES[result.reason] ?? "Directory sync failed." },
        { status: 502 }
      );
    }
    return NextResponse.json(result);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
