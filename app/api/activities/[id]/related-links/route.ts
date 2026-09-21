import { NextRequest } from "next/server";
import { handleCreate, handleList } from "@/lib/related-links/route-handlers";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleList("activity", params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleCreate("activity", req, params);
}
