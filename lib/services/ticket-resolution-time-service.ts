/**
 * Ticket Resolution Time writes (manual effort — lib/resolution-time.ts).
 *
 * The one place Ticket.resolutionTimeMinutes is written, always inside the
 * caller's transaction, so the value and its audit entry commit together
 * (and, for a resolution, together with the status change). Touches ONLY
 * resolutionTimeMinutes — never status, closedAt or any SLA data.
 */
import type { Prisma } from "@prisma/client";
import { formatResolutionTime } from "@/lib/resolution-time";

export type ResolutionTimeChange = { changed: boolean; previous: number | null; current: number | null };

export async function setTicketResolutionTimeInTransaction(
  tx: Prisma.TransactionClient,
  args: { ticketId: string; actorId: string; minutes: number | null }
): Promise<ResolutionTimeChange> {
  // Row lock: concurrent edits serialize, so every audit entry's "previous"
  // is the value it actually replaced.
  const rows = await tx.$queryRaw<{ resolutionTimeMinutes: number | null }[]>`
    SELECT "resolutionTimeMinutes" FROM "Ticket" WHERE "id" = ${args.ticketId} FOR UPDATE`;
  if (rows.length === 0) throw new Error("ticket_not_found");
  const previous = rows[0].resolutionTimeMinutes;
  if (previous === args.minutes) return { changed: false, previous, current: previous };

  await tx.ticket.update({ where: { id: args.ticketId }, data: { resolutionTimeMinutes: args.minutes } });
  await tx.ticketHistory.create({
    data: {
      ticketId: args.ticketId,
      changedById: args.actorId,
      type: "RESOLUTION_TIME_CHANGE",
      // Raw minutes (NULL = not recorded) so reporting can tell "missing"
      // from an explicit 0; the description carries the readable form.
      oldValue: previous === null ? null : String(previous),
      newValue: args.minutes === null ? null : String(args.minutes),
      description: `Resolution time changed from ${formatResolutionTime(previous)} to ${formatResolutionTime(args.minutes)}`,
    },
  });
  return { changed: true, previous, current: args.minutes };
}
