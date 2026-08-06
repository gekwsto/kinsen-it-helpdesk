import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { OrganizationChartView } from "@/components/admin/organization-chart/organization-chart-view";

// Deliberately NOT requireAdmin()-gated — every authenticated user is
// allowed to see this page, per the brief's "simple users can see at least
// their own department/manager" requirement. The actual data returned is
// scoped server-side per request (full tree vs. own slice) by
// lib/services/organization-scope-service.ts, called from every
// /api/organization/** route this page's client component fetches from —
// this page itself carries no authorization logic of its own beyond
// requiring a session. Canonical route (promoted out from under
// /admin/organization, which now just redirects here — see that page).
export default async function OrganizationChartPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Organization Chart</h1>
        <p className="text-muted-foreground mt-1">
          Department structure and reporting lines, synchronized from Microsoft Entra ID.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <OrganizationChartView />
      </div>
    </div>
  );
}
