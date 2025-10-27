-- CreateTable
CREATE TABLE "Punishment" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "originalRoles" TEXT[],
    "punishChannelId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Punishment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Punishment_userId_key" ON "Punishment"("userId");
