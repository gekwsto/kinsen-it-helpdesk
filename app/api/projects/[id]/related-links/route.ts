import { NextRequest } from "next/server";
import { handleCreate, handleList } from "@/lib/related-links/route-handlers";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleList("project", params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleCreate("project", req, params);
}
