import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getGlobalRoleOptions } from "@/lib/services/global-role-options-service";

/**
 * Read-only list of Global Role choices (built-in Role enum values with a
 * mirrored, active CustomRole row + custom GLOBAL/BOTH-scope CustomRole
 * rows) for the Admin User "Global Role" dropdown. Mirrors
 * app/api/admin/department-roles/options/route.ts exactly — same
 * requireAuth()-only gating rationale (the actual grant is re-validated
 * server-side by assertGlobalRoleAssignable on the write endpoint; seeing
 * which role names exist isn't sensitive on its own), same `includeInactive`
 * opt-in for resolving/preserving an existing user's current (possibly
 * disabled) role display.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "true";
    const options = await getGlobalRoleOptions({ includeInactive });
    return NextResponse.json(options);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
