import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getFacilitiesServicesDepartmentId } from "@/lib/services/project-facilities-service";

/**
 * GET — the Facilities Services Department's own canonical id (by slug,
 * never by display name), or null if it doesn't exist/isn't configured.
 * Not sensitive (any authenticated user can already see this department by
 * name in /admin/departments if they have access there) — this exists only
 * so ProjectForm's "inline" mode (the ticket-linking create dialog, whose
 * own caller chain is client components with no server-resolved id handy,
 * unlike standalone/fromRequest which resolve it directly in their own
 * server page) can determine whether to offer the Facilities-only fields,
 * without threading this one id through several more component layers.
 */
export async function GET() {
  try {
    await requireAuth();
    const id = await getFacilitiesServicesDepartmentId();
    return NextResponse.json({ id });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
