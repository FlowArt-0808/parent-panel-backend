-- CreateEnum
CREATE TYPE "StatusType" AS ENUM ('ALLOWED', 'BLOCKED', 'LIMITED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('DANGEROUS_CONTENT', 'TIME_LIMIT_EXCEEDED', 'SUSPICIOUS_ACTIVITY');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Child" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "pin" TEXT,
    "age" INTEGER,
    "gender" TEXT,
    "parentId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Child_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryCatalog" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CategoryCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyUsage" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "History" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "fullUrl" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT,
    "categoryName" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionTaken" "StatusType" NOT NULL,
    "device" TEXT,

    CONSTRAINT "History_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildCategorySetting" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "status" "StatusType" NOT NULL DEFAULT 'ALLOWED',
    "timeLimit" INTEGER,

    CONSTRAINT "ChildCategorySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildUrlSetting" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "urlId" INTEGER NOT NULL,
    "status" "StatusType" NOT NULL DEFAULT 'ALLOWED',
    "timeLimit" INTEGER,

    CONSTRAINT "ChildUrlSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UrlCatalog" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "safetyScore" INTEGER,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UrlCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" SERIAL NOT NULL,
    "childId" INTEGER NOT NULL,
    "type" "AlertType" NOT NULL,
    "message" TEXT NOT NULL,
    "isSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryCatalog_name_key" ON "CategoryCatalog"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DailyUsage_childId_categoryId_date_key" ON "DailyUsage"("childId", "categoryId", "date");

-- CreateIndex
CREATE INDEX "History_childId_visitedAt_idx" ON "History"("childId", "visitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChildCategorySetting_childId_categoryId_key" ON "ChildCategorySetting"("childId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ChildUrlSetting_childId_urlId_key" ON "ChildUrlSetting"("childId", "urlId");

-- CreateIndex
CREATE UNIQUE INDEX "UrlCatalog_domain_key" ON "UrlCatalog"("domain");

-- AddForeignKey
ALTER TABLE "Child" ADD CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyUsage" ADD CONSTRAINT "DailyUsage_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyUsage" ADD CONSTRAINT "DailyUsage_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CategoryCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "History" ADD CONSTRAINT "History_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildCategorySetting" ADD CONSTRAINT "ChildCategorySetting_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CategoryCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildCategorySetting" ADD CONSTRAINT "ChildCategorySetting_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildUrlSetting" ADD CONSTRAINT "ChildUrlSetting_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildUrlSetting" ADD CONSTRAINT "ChildUrlSetting_urlId_fkey" FOREIGN KEY ("urlId") REFERENCES "UrlCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
