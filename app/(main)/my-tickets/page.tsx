import { redirect } from "next/navigation";

/**
 * "My Tickets" was split into /tickets/assigned-to-me and
 * /tickets/created-by-me (it used to conflate the two, only ever checking
 * requesterId). This route stays as a redirect so old bookmarks/links keep
 * working — "created by me" is the closer match to what this page used to
 * show.
 */
export default function MyTicketsRedirect() {
  redirect("/tickets/created-by-me");
}
