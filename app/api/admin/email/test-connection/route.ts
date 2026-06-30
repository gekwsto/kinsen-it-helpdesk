import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { microsoftGraph } from "@/lib/microsoft-graph";

export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await microsoftGraph.testConnection();
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? "Test failed" },
      { status: 500 }
    );
  }
}
