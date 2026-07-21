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
    const pendingTicket = await createTestEmailTicket();
    return NextResponse.json({
      success: true,
      pendingTicketId: pendingTicket.id,
      subject: pendingTicket.subject,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? "Failed to create test pending ticket" },
      { status: 500 }
    );
  }
}
