import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

async function main() {
  const ticketNumbers = [401, 402, 1202];

  for (const ticketNumber of ticketNumbers) {
    const t = await prisma.ticket.findUnique({
      where: { ticketNumber },
      select: {
        id: true,
        ticketNumber: true,
        title: true,
        description: true,
        createdAt: true,
      },
    });

    if (!t) {
      console.log(`\n--- Ticket #${ticketNumber} ---`);
      console.log("  NOT FOUND");
      continue;
    }

    const descLen = t.description?.length ?? 0;
    const preview = t.description?.slice(0, 120).replace(/\n/g, " ") ?? "(empty)";

    console.log(`\n--- Ticket #${t.ticketNumber} ---`);
    console.log(`  id:          ${t.id}`);
    console.log(`  title:       ${t.title}`);
    console.log(`  desc length: ${descLen}`);
    console.log(`  preview:     ${preview}${descLen > 120 ? "..." : ""}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
