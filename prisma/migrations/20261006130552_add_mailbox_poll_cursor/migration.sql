-- CreateTable
CREATE TABLE "MailboxPollCursor" (
    "mailbox" TEXT NOT NULL,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxPollCursor_pkey" PRIMARY KEY ("mailbox")
);
