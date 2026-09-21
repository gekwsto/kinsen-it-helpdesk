import { NextRequest } from "next/server";
import { handleDelete, handleUpdate } from "@/lib/related-links/route-handlers";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  return handleUpdate("activity", req, params);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  return handleDelete("activity", params);
}
