import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canManageTickets, hasPermission } from "@/lib/permissions";
import { replyTicketSchema } from "@/lib/validations";
import { notifyRequesterReply, notifyTicketRequesterPublicReply } from "@/lib/ticket-notification-service";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { Role } from "@prisma/client";

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

    const message = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: session.user.id,
        body: data.body,
        direction: data.direction,
        isInternal: data.isInternal,
      },
      include: {
        author: { select: { id: true, name: true, email: true, image: true, role: true } },
        attachments: true,
      },
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

    // Publish real-time event
    publishTicketEvent(
      data.isInternal ? "TICKET_INTERNAL_NOTE_CREATED" : "TICKET_MESSAGE_CREATED",
      id,
      session.user.id,
      message
    );

    return NextResponse.json(message, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
