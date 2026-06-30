import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { processInboundEmails } from "@/lib/ticket-email-service";

export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processInboundEmails();
    return NextResponse.json({
      success: true,
      ...result,
      message: `Created ${result.created}, appended ${result.appended}, skipped ${result.skipped}, errors ${result.errors}`,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? "Processing failed" },
      { status: 500 }
    );
  }
}
