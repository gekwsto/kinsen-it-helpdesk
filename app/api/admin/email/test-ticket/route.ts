import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { createTestEmailTicket } from "@/lib/ticket-email-service";

export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const ticket = await createTestEmailTicket();
    return NextResponse.json({
      success: true,
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? "Failed to create test ticket" },
      { status: 500 }
    );
  }
}
