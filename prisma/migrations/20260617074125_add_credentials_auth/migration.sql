-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('MICROSOFT', 'CREDENTIALS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authProvider" "AuthProvider" NOT NULL DEFAULT 'MICROSOFT',
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordHash" TEXT;
