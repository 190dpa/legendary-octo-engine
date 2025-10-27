/*
  Warnings:

  - You are about to drop the column `webhookSent` on the `DeliveryRecord` table. All the data in the column will be lost.
  - You are about to drop the column `webhookStatus` on the `DeliveryRecord` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DeliveryRecord" DROP COLUMN "webhookSent",
DROP COLUMN "webhookStatus",
ADD COLUMN     "messageSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messageStatus" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Configuration" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mainChannelId" TEXT,
    "deliveryChannelId" TEXT,
    "mainMessageId" TEXT,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);
