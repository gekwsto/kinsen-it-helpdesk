-- CreateTable
CREATE TABLE "TicketMessageMention" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessageMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectNoteMention" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectNoteMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityNoteMention" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityNoteMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketMessageMention_userId_idx" ON "TicketMessageMention"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketMessageMention_messageId_userId_key" ON "TicketMessageMention"("messageId", "userId");

-- CreateIndex
CREATE INDEX "ProjectNoteMention_userId_idx" ON "ProjectNoteMention"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectNoteMention_noteId_userId_key" ON "ProjectNoteMention"("noteId", "userId");

-- CreateIndex
CREATE INDEX "ActivityNoteMention_userId_idx" ON "ActivityNoteMention"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityNoteMention_noteId_userId_key" ON "ActivityNoteMention"("noteId", "userId");

-- AddForeignKey
ALTER TABLE "TicketMessageMention" ADD CONSTRAINT "TicketMessageMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessageMention" ADD CONSTRAINT "TicketMessageMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectNoteMention" ADD CONSTRAINT "ProjectNoteMention_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ProjectNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectNoteMention" ADD CONSTRAINT "ProjectNoteMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityNoteMention" ADD CONSTRAINT "ActivityNoteMention_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "ActivityNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityNoteMention" ADD CONSTRAINT "ActivityNoteMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
