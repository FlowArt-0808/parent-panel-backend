-- CreateTable
CREATE TABLE "ChildTimeLimit" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "dailyLimit" INTEGER NOT NULL DEFAULT 240,
    "weekdayLimit" INTEGER NOT NULL DEFAULT 180,
    "weekendLimit" INTEGER NOT NULL DEFAULT 300,
    "sessionLimit" INTEGER NOT NULL DEFAULT 60,
    "breakEvery" INTEGER NOT NULL DEFAULT 45,
    "breakDuration" INTEGER NOT NULL DEFAULT 10,
    "focusMode" BOOLEAN NOT NULL DEFAULT false,
    "downtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildTimeLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildAppLimit" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildAppLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildCategoryLimit" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildCategoryLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildAlwaysAllowed" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildAlwaysAllowed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildFocusBlocked" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildFocusBlocked_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChildTimeLimit_childId_key" ON "ChildTimeLimit"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildAppLimit_childId_name_key" ON "ChildAppLimit"("childId", "name");

-- CreateIndex
CREATE INDEX "ChildAppLimit_childId_idx" ON "ChildAppLimit"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildCategoryLimit_childId_name_key" ON "ChildCategoryLimit"("childId", "name");

-- CreateIndex
CREATE INDEX "ChildCategoryLimit_childId_idx" ON "ChildCategoryLimit"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildAlwaysAllowed_childId_name_key" ON "ChildAlwaysAllowed"("childId", "name");

-- CreateIndex
CREATE INDEX "ChildAlwaysAllowed_childId_idx" ON "ChildAlwaysAllowed"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildFocusBlocked_childId_name_key" ON "ChildFocusBlocked"("childId", "name");

-- CreateIndex
CREATE INDEX "ChildFocusBlocked_childId_idx" ON "ChildFocusBlocked"("childId");

-- CreateIndex
CREATE INDEX "Child_parentId_idx" ON "Child"("parentId");

-- CreateIndex
CREATE INDEX "History_childId_categoryName_idx" ON "History"("childId", "categoryName");

-- CreateIndex
CREATE INDEX "ChildCategorySetting_childId_idx" ON "ChildCategorySetting"("childId");

-- CreateIndex
CREATE INDEX "ChildUrlSetting_childId_idx" ON "ChildUrlSetting"("childId");

-- CreateIndex
CREATE INDEX "Alert_childId_createdAt_idx" ON "Alert"("childId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChildTimeLimit" ADD CONSTRAINT "ChildTimeLimit_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildAppLimit" ADD CONSTRAINT "ChildAppLimit_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildCategoryLimit" ADD CONSTRAINT "ChildCategoryLimit_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildAlwaysAllowed" ADD CONSTRAINT "ChildAlwaysAllowed_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildFocusBlocked" ADD CONSTRAINT "ChildFocusBlocked_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
