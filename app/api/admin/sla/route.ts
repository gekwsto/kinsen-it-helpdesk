import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await requireAdmin();

    const [settings, priorities] = await Promise.all([
      prisma.slaSettings.findFirst(),
      prisma.ticketPriority.findMany({
        where: { isActive: true },
        orderBy: { level: "desc" },
        include: { slaPolicy: true },
      }),
    ]);

    return NextResponse.json({
      isEnabled: settings?.isEnabled ?? false,
      priorities: priorities.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        level: p.level,
        firstResponseHours: p.slaPolicy?.firstResponseHours ?? 8,
        resolutionHours: p.slaPolicy?.resolutionHours ?? 48,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();

    const { isEnabled, policies } = await req.json();

    await prisma.slaSettings.upsert({
      where: { id: "sla-settings-singleton" },
      update: { isEnabled },
      create: { id: "sla-settings-singleton", isEnabled },
    });

    if (Array.isArray(policies)) {
      await Promise.all(
        policies.map((p: { priorityId: string; firstResponseHours: number; resolutionHours: number }) =>
          prisma.slaPolicy.upsert({
            where: { priorityId: p.priorityId },
            update: {
              firstResponseHours: Number(p.firstResponseHours),
              resolutionHours: Number(p.resolutionHours),
            },
            create: {
              priorityId: p.priorityId,
              firstResponseHours: Number(p.firstResponseHours),
              resolutionHours: Number(p.resolutionHours),
            },
          })
        )
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
