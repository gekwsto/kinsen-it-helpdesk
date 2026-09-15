import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canManageTickets, hasPermission } from "@/lib/permissions";
import { replyTicketSchema } from "@/lib/validations";
import { notifyRequesterReply, notifyTicketRequesterPublicReply } from "@/lib/ticket-notification-service";
import { resolveEligibleMentionUsers } from "@/lib/services/mention-service";
import { notifyNewMentions } from "@/lib/services/mention-notification-service";
import { formatTicketNumber } from "@/lib/utils";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { Role } from "@prisma/client";

const messageInclude = {
  author: { select: { id: true, name: true, email: true, image: true, role: true } },
  attachments: true,
  mentions: { include: { user: { select: { id: true, name: true, email: true } } } },
} as const;

function toMessageMentions(message: { mentions: { user: { id: string; name: string | null; email: string } }[] }) {
  return message.mentions.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email }));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { requester: true, status: true },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const canReply = await hasPermission(session.user.role, "ticket.reply", session.user.customRoleId);
    const isRequester = ticket.requesterId === session.user.id;

    if (!canReply && !isRequester) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = replyTicketSchema.parse(body);

    // Prevent users without the internalNote permission from creating internal notes
    if (data.isInternal) {
      const canInternalNote = await hasPermission(session.user.role, "ticket.internalNote", session.user.customRoleId);
      if (!canInternalNote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Mentions are a "Ticket Notes" concept — internal notes only, never a
    // public/requester-facing reply (see lib/services/mention-service.ts).
    // Layer 2 of the mention security model: every client-submitted
    // mentionUserId is re-validated here against the exact same canonical
    // ticket-view eligibility check the picker itself used (canViewTicket),
    // independent of whatever the client claims. Anything that fails is
    // silently dropped — never persisted as a mention, never notified.
    const eligibleMentions = data.isInternal
      ? await resolveEligibleMentionUsers({ entityType: "ticket", entityId: id, requestedUserIds: data.mentionUserIds })
      : [];

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorId: session.user.id,
          body: data.body,
          direction: data.direction,
          isInternal: data.isInternal,
        },
      });
      if (eligibleMentions.length > 0) {
        await tx.ticketMessageMention.createMany({
          data: eligibleMentions.map((m) => ({ messageId: created.id, userId: m.id })),
          skipDuplicates: true,
        });
      }
      return tx.ticketMessage.findUniqueOrThrow({ where: { id: created.id }, include: messageInclude });
    });

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: data.isInternal ? "COMMENT_ADDED" : "COMMENT_ADDED",
        description: data.isInternal
          ? "Internal note added"
          : `Reply added by ${session.user.name}`,
      },
    });

    // Email: agent/staff public reply to a non-admin requester — the
    // existing, intentionally unchanged gate (see the doc comment on
    // notifyTicketRequesterPublicReply in lib/ticket-notification-service.ts
    // for why the Web Push path below deliberately does NOT reuse this same
    // condition).
    if (
      !data.isInternal &&
      canManageTickets(session.user.role) &&
      ticket.requesterId !== session.user.id &&
      ticket.requester.role !== Role.ADMIN
    ) {
      notifyRequesterReply({
        ticketId: id,
        messageId: message.id,
        agentName: session.user.name ?? "IT Support",
        replyBody: data.body,
      }).catch((err) => {
        console.error("[notification] Failed to send reply email:", err);
      });
    }

    // Web Push (+ in-app bell): the real business event — "another user
    // posted a public reply to my ticket" — never role-gated, independent
    // of canManageTickets()/Role. Recipient resolution, idempotency, and
    // delivery all live in notifyTicketRequesterPublicReply; deferred via
    // after() so a push-provider failure can never affect this response
    // (the message is already committed above).
    if (!data.isInternal && ticket.requesterId !== session.user.id) {
      after(() =>
        notifyTicketRequesterPublicReply({
          ticketId: id,
          messageId: message.id,
        })
      );
    }

    // Mention notifications only fire after the message + its mentions are
    // fully committed — never before, and never for a mention that failed
    // eligibility. Self-mentions are silently skipped inside
    // notifyNewMentions; Ticket messages are never edited (only ever
    // appended), so every mention here is by construction "newly added."
    // Awaited (not fire-and-forget) so a mentioned user is guaranteed to
    // already have their notification by the time this response reaches
    // the client — a failure here is logged, never allowed to fail message
    // creation itself (the message is already committed above).
    if (eligibleMentions.length > 0) {
      try {
        await notifyNewMentions({
          authorId: session.user.id,
          authorName: session.user.name ?? "Someone",
          mentionedUserIds: eligibleMentions.map((m) => m.id),
          link: `/tickets/${id}`,
          entityLabel: `ticket ${formatTicketNumber(ticket.ticketNumber)}`,
        });
      } catch (err) {
        console.error("[mentions] Failed to notify ticket note mentions:", err);
      }
    }

    const messageWithMentions = { ...message, mentions: toMessageMentions(message) };

    // Publish real-time event
    publishTicketEvent(
      data.isInternal ? "TICKET_INTERNAL_NOTE_CREATED" : "TICKET_MESSAGE_CREATED",
      id,
      session.user.id,
      messageWithMentions
    );

    return NextResponse.json(messageWithMentions, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
