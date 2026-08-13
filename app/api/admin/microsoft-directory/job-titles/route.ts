import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { listJobTitleDirectoryForAdmin } from "@/lib/services/microsoft-job-title-directory-service";
import { ALLOWED_ORGANIZATION_EMAIL_DOMAINS } from "@/lib/allowed-email-domains";

// `?domain=` selects which configured allowed organization domain to view
// (see ALLOWED_ORGANIZATION_EMAIL_DOMAINS) — omitted defaults to the first
// one, preserving the exact previous single-domain response shape for a
// deployment that only ever configured one.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const requestedDomain = req.nextUrl.searchParams.get("domain") ?? undefined;
    const { domain, rows } = await listJobTitleDirectoryForAdmin(requestedDomain);
    return NextResponse.json({ domain, rows, allowedDomains: ALLOWED_ORGANIZATION_EMAIL_DOMAINS });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
