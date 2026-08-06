import { redirect } from "next/navigation";

// The Organization Chart moved to the canonical top-level /organization
// route (promoted out from under Administration — see app/(main)/organization/page.tsx).
// This route is kept as a permanent alias so existing bookmarks/links never
// break. No auth check here: redirect() carries no data of its own, and the
// destination page enforces its own session requirement.
export default function AdminOrganizationRedirectPage() {
  redirect("/organization");
}
