const express = require("express");
const prisma = require("../lib/prisma");
const { getSessionFromRequest, unauthorizedJson } = require("../lib/session");
const { filterRestrictedCategories, normalizeCategoryName } = require("../lib/categoryFilters");

const router = express.Router();

const TABLE_NOT_FOUND_CODE = "P2021";
const isPrismaTableMissingError = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === TABLE_NOT_FOUND_CODE;

const DEFAULT_TIME_LIMIT_MINUTES = {
  weekdayLimit: 180,
  weekendLimit: 300,
  sessionLimit: 60,
  breakEvery: 45,
  breakDuration: 10,
};
const DEFAULT_DAILY_SHADOW_LIMIT = Math.max(
  DEFAULT_TIME_LIMIT_MINUTES.weekdayLimit,
  DEFAULT_TIME_LIMIT_MINUTES.weekendLimit,
);
const DEFAULT_BEDTIME_SCHEDULE = {
  schoolNightStartMinute: 21 * 60,
  schoolNightEndMinute: 7 * 60,
  weekendStartMinute: 22 * 60,
  weekendEndMinute: 8 * 60,
};

const TIME_LIMIT_DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "ChildTimeLimit" (
    "id" SERIAL PRIMARY KEY,
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
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ChildAppLimit" (
    "id" SERIAL PRIMARY KEY,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ChildCategoryLimit" (
    "id" SERIAL PRIMARY KEY,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ChildAlwaysAllowed" (
    "id" SERIAL PRIMARY KEY,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ChildFocusBlocked" (
    "id" SERIAL PRIMARY KEY,
    "childId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "ChildBedtimeSchedule" (
    "id" SERIAL PRIMARY KEY,
    "childId" INTEGER NOT NULL,
    "schoolNightStartMinute" INTEGER NOT NULL DEFAULT 1260,
    "schoolNightEndMinute" INTEGER NOT NULL DEFAULT 420,
    "weekendStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "weekendEndMinute" INTEGER NOT NULL DEFAULT 480,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildTimeLimit_childId_key" ON "ChildTimeLimit"("childId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildAppLimit_childId_name_key" ON "ChildAppLimit"("childId", "name")`,
  `CREATE INDEX IF NOT EXISTS "ChildAppLimit_childId_idx" ON "ChildAppLimit"("childId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildCategoryLimit_childId_name_key" ON "ChildCategoryLimit"("childId", "name")`,
  `CREATE INDEX IF NOT EXISTS "ChildCategoryLimit_childId_idx" ON "ChildCategoryLimit"("childId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildAlwaysAllowed_childId_name_key" ON "ChildAlwaysAllowed"("childId", "name")`,
  `CREATE INDEX IF NOT EXISTS "ChildAlwaysAllowed_childId_idx" ON "ChildAlwaysAllowed"("childId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildFocusBlocked_childId_name_key" ON "ChildFocusBlocked"("childId", "name")`,
  `CREATE INDEX IF NOT EXISTS "ChildFocusBlocked_childId_idx" ON "ChildFocusBlocked"("childId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChildBedtimeSchedule_childId_key" ON "ChildBedtimeSchedule"("childId")`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildTimeLimit_childId_fkey') THEN
      ALTER TABLE "ChildTimeLimit" ADD CONSTRAINT "ChildTimeLimit_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildAppLimit_childId_fkey') THEN
      ALTER TABLE "ChildAppLimit" ADD CONSTRAINT "ChildAppLimit_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildCategoryLimit_childId_fkey') THEN
      ALTER TABLE "ChildCategoryLimit" ADD CONSTRAINT "ChildCategoryLimit_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildAlwaysAllowed_childId_fkey') THEN
      ALTER TABLE "ChildAlwaysAllowed" ADD CONSTRAINT "ChildAlwaysAllowed_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildFocusBlocked_childId_fkey') THEN
      ALTER TABLE "ChildFocusBlocked" ADD CONSTRAINT "ChildFocusBlocked_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChildBedtimeSchedule_childId_fkey') THEN
      ALTER TABLE "ChildBedtimeSchedule" ADD CONSTRAINT "ChildBedtimeSchedule_childId_fkey"
      FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
];

const ensureTimeLimitTables = async () => {
  for (const statement of TIME_LIMIT_DDL_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
};

const toStoredMinutes = (value, fallbackMinutes) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackMinutes;
  return Math.max(1, Math.round(numeric));
};

const toSafeMinutes = (value, fallbackMinutes) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackMinutes;
  return Math.max(1, Math.round(numeric));
};

const toMinuteOfDay = (value, fallbackMinute) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackMinute;
  const rounded = Math.round(numeric);
  return Math.max(0, Math.min(1439, rounded));
};

const requireChild = async (childId, parentId) => {
  const child = await prisma.child.findUnique({
    where: { id: childId },
    select: { id: true, parentId: true },
  });
  if (!child || child.parentId !== parentId) return null;
  return child;
};

const isLikelyLegacySecondsRow = (row) => {
  const values = [
    row.dailyLimit,
    row.weekdayLimit,
    row.weekendLimit,
    row.sessionLimit,
    row.breakEvery,
    row.breakDuration,
  ].map((value) => Number(value));

  if (values.some((value) => !Number.isFinite(value))) return false;

  const secondsLikeBreakEvery = row.breakEvery % 60 === 0 && row.breakEvery >= 60;
  const secondsLikeBreakDuration = row.breakDuration % 60 === 0 && row.breakDuration >= 60;
  const hasLargeValue = values.some((value) => value >= 600);

  return secondsLikeBreakEvery && secondsLikeBreakDuration && hasLargeValue;
};

const normalizeTimeLimitRow = (row) => ({
  ...row,
  weekdayLimit: toSafeMinutes(row.weekdayLimit, DEFAULT_TIME_LIMIT_MINUTES.weekdayLimit),
  weekendLimit: toSafeMinutes(row.weekendLimit, DEFAULT_TIME_LIMIT_MINUTES.weekendLimit),
  dailyLimit: Math.max(
    toSafeMinutes(row.weekdayLimit, DEFAULT_TIME_LIMIT_MINUTES.weekdayLimit),
    toSafeMinutes(row.weekendLimit, DEFAULT_TIME_LIMIT_MINUTES.weekendLimit),
  ),
  sessionLimit: toSafeMinutes(row.sessionLimit, DEFAULT_TIME_LIMIT_MINUTES.sessionLimit),
  breakEvery: toSafeMinutes(row.breakEvery, DEFAULT_TIME_LIMIT_MINUTES.breakEvery),
  breakDuration: toSafeMinutes(row.breakDuration, DEFAULT_TIME_LIMIT_MINUTES.breakDuration),
});

const normalizeBedtimeSchedule = (row) => ({
  schoolNightStartMinute: toMinuteOfDay(
    row?.schoolNightStartMinute,
    DEFAULT_BEDTIME_SCHEDULE.schoolNightStartMinute,
  ),
  schoolNightEndMinute: toMinuteOfDay(
    row?.schoolNightEndMinute,
    DEFAULT_BEDTIME_SCHEDULE.schoolNightEndMinute,
  ),
  weekendStartMinute: toMinuteOfDay(
    row?.weekendStartMinute,
    DEFAULT_BEDTIME_SCHEDULE.weekendStartMinute,
  ),
  weekendEndMinute: toMinuteOfDay(
    row?.weekendEndMinute,
    DEFAULT_BEDTIME_SCHEDULE.weekendEndMinute,
  ),
});

const getBedtimeSchedule = async (childId) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
      "schoolNightStartMinute",
      "schoolNightEndMinute",
      "weekendStartMinute",
      "weekendEndMinute"
    FROM "ChildBedtimeSchedule"
    WHERE "childId" = $1
    LIMIT 1`,
    childId,
  );
  return normalizeBedtimeSchedule(rows[0]);
};

const upsertBedtimeSchedule = (childId, bedtimeSchedule) => {
  const schedule = normalizeBedtimeSchedule(
    typeof bedtimeSchedule === "object" && bedtimeSchedule !== null
      ? bedtimeSchedule
      : null,
  );
  return prisma.$executeRawUnsafe(
    `INSERT INTO "ChildBedtimeSchedule" (
      "childId",
      "schoolNightStartMinute",
      "schoolNightEndMinute",
      "weekendStartMinute",
      "weekendEndMinute",
      "createdAt",
      "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("childId")
    DO UPDATE SET
      "schoolNightStartMinute" = EXCLUDED."schoolNightStartMinute",
      "schoolNightEndMinute" = EXCLUDED."schoolNightEndMinute",
      "weekendStartMinute" = EXCLUDED."weekendStartMinute",
      "weekendEndMinute" = EXCLUDED."weekendEndMinute",
      "updatedAt" = CURRENT_TIMESTAMP`,
    childId,
    schedule.schoolNightStartMinute,
    schedule.schoolNightEndMinute,
    schedule.weekendStartMinute,
    schedule.weekendEndMinute,
  );
};

const getUBTodayDate = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? 0);
  const month = Number(parts.find((part) => part.type === "month")?.value ?? 1);
  const day = Number(parts.find((part) => part.type === "day")?.value ?? 1);
  return new Date(Date.UTC(year, month - 1, day));
};

router.get("/", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const childIdParam = req.query?.childId;
    const childId = childIdParam ? Number.parseInt(childIdParam, 10) : null;

    if (!childId || Number.isNaN(childId)) {
      return res.status(400).json({ error: "Invalid childId" });
    }

    const child = await requireChild(childId, session.userId);
    if (!child) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const loadTimeLimitData = async () =>
      Promise.all([
        prisma.childTimeLimit.findUnique({
          where: { childId },
        }),
        prisma.childAppLimit.findMany({
          where: { childId },
          select: { id: true, name: true, minutes: true },
          orderBy: { name: "asc" },
        }),
        prisma.childCategoryLimit.findMany({
          where: { childId },
          select: { id: true, name: true, minutes: true },
          orderBy: { name: "asc" },
        }),
        prisma.childAlwaysAllowed.findMany({
          where: { childId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        prisma.childFocusBlocked.findMany({
          where: { childId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        prisma.categoryCatalog.findMany({
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
      ]);

    let timeLimitData;
    try {
      timeLimitData = await loadTimeLimitData();
    } catch (error) {
      if (!isPrismaTableMissingError(error)) throw error;
      await ensureTimeLimitTables();
      timeLimitData = await loadTimeLimitData();
    }

    const [
      loadedTimeLimit,
      appLimits,
      categoryLimits,
      alwaysAllowed,
      blockedDuringFocus,
      catalogCategories,
    ] = timeLimitData;
    let timeLimit = loadedTimeLimit;

    if (!timeLimit) {
      timeLimit = await prisma.childTimeLimit.upsert({
        where: { childId },
        update: {},
        create: {
          childId,
          dailyLimit: DEFAULT_DAILY_SHADOW_LIMIT,
          weekdayLimit: DEFAULT_TIME_LIMIT_MINUTES.weekdayLimit,
          weekendLimit: DEFAULT_TIME_LIMIT_MINUTES.weekendLimit,
          sessionLimit: DEFAULT_TIME_LIMIT_MINUTES.sessionLimit,
          breakEvery: DEFAULT_TIME_LIMIT_MINUTES.breakEvery,
          breakDuration: DEFAULT_TIME_LIMIT_MINUTES.breakDuration,
          focusMode: false,
          downtimeEnabled: true,
        },
      });
    }

    if (timeLimit && isLikelyLegacySecondsRow(timeLimit)) {
      const convertedWeekdayLimit = Math.max(1, Math.round(timeLimit.weekdayLimit / 60));
      const convertedWeekendLimit = Math.max(1, Math.round(timeLimit.weekendLimit / 60));
      timeLimit = await prisma.childTimeLimit.update({
        where: { childId },
        data: {
          dailyLimit: Math.max(convertedWeekdayLimit, convertedWeekendLimit),
          weekdayLimit: convertedWeekdayLimit,
          weekendLimit: convertedWeekendLimit,
          sessionLimit: Math.max(1, Math.round(timeLimit.sessionLimit / 60)),
          breakEvery: Math.max(1, Math.round(timeLimit.breakEvery / 60)),
          breakDuration: Math.max(1, Math.round(timeLimit.breakDuration / 60)),
        },
      });
    }

    const normalizedTimeLimit = timeLimit ? normalizeTimeLimitRow(timeLimit) : null;
    const availableCategories = filterRestrictedCategories(catalogCategories ?? []);
    const allowedCategoryNames = new Set(
      availableCategories.map((category) => normalizeCategoryName(category.name)),
    );
    const filteredCategoryLimits = (categoryLimits ?? []).filter((item) =>
      allowedCategoryNames.has(normalizeCategoryName(item.name)),
    );
    let bedtimeSchedule = normalizeBedtimeSchedule(null);
    try {
      bedtimeSchedule = await getBedtimeSchedule(childId);
    } catch {
      await ensureTimeLimitTables();
      bedtimeSchedule = await getBedtimeSchedule(childId);
    }

    return res.json({
      timeLimit: normalizedTimeLimit,
      bedtimeSchedule,
      appLimits,
      categoryLimits: filteredCategoryLimits,
      availableCategories,
      alwaysAllowed,
      blockedDuringFocus,
    });
  } catch (error) {
    if (isPrismaTableMissingError(error)) {
      return res.json({
        timeLimit: null,
        bedtimeSchedule: normalizeBedtimeSchedule(null),
        appLimits: [],
        categoryLimits: [],
        availableCategories: [],
        alwaysAllowed: [],
        blockedDuringFocus: [],
        warning: "Time-limit tables are missing in current database.",
      });
    }
    const message = error instanceof Error ? error.message : "Failed to load time limits.";
    return res.status(500).json({ error: message });
  }
});

router.post("/", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const payload = req.body ?? {};
    const childId = payload?.childId ? Number.parseInt(String(payload.childId), 10) : null;
    const action = typeof payload?.action === "string" ? payload.action : "";

    if (!childId || Number.isNaN(childId)) {
      return res.status(400).json({ error: "Invalid childId" });
    }
    if (action !== "RESET_DAILY_TIMER") {
      return res.status(400).json({ error: "Invalid action" });
    }

    const child = await requireChild(childId, session.userId);
    if (!child) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const today = getUBTodayDate();
    const removed = await prisma.dailyUsage.deleteMany({
      where: { childId, date: today },
    });

    return res.json({
      success: true,
      resetRows: removed.count,
      message: "Daily timer reset.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reset daily timer.";
    return res.status(500).json({ error: message });
  }
});

router.put("/", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const payload = req.body ?? {};
    const childId = payload?.childId ? Number.parseInt(String(payload.childId), 10) : null;

    if (!childId || Number.isNaN(childId)) {
      return res.status(400).json({ error: "Invalid childId" });
    }

    const child = await requireChild(childId, session.userId);
    if (!child) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const timeLimit = payload?.timeLimit ?? {};
    const bedtimeSchedule = payload?.bedtimeSchedule ?? {};
    const appLimits = Array.isArray(payload?.appLimits) ? payload.appLimits : [];
    const categoryLimits = Array.isArray(payload?.categoryLimits) ? payload.categoryLimits : [];
    const alwaysAllowed = Array.isArray(payload?.alwaysAllowed) ? payload.alwaysAllowed : [];
    const blockedDuringFocus = Array.isArray(payload?.blockedDuringFocus)
      ? payload.blockedDuringFocus
      : [];
    const storedWeekdayLimit = toStoredMinutes(
      timeLimit.weekdayLimit,
      DEFAULT_TIME_LIMIT_MINUTES.weekdayLimit,
    );
    const storedWeekendLimit = toStoredMinutes(
      timeLimit.weekendLimit,
      DEFAULT_TIME_LIMIT_MINUTES.weekendLimit,
    );
    const storedSessionLimit = toStoredMinutes(
      timeLimit.sessionLimit,
      DEFAULT_TIME_LIMIT_MINUTES.sessionLimit,
    );
    const storedBreakEvery = toStoredMinutes(
      timeLimit.breakEvery,
      DEFAULT_TIME_LIMIT_MINUTES.breakEvery,
    );
    const storedBreakDuration = toStoredMinutes(
      timeLimit.breakDuration,
      DEFAULT_TIME_LIMIT_MINUTES.breakDuration,
    );
    const storedDailyShadowLimit = Math.max(storedWeekdayLimit, storedWeekendLimit);

    const persistTimeLimitData = async () =>
      prisma.$transaction([
        prisma.childTimeLimit.upsert({
          where: { childId },
          update: {
            dailyLimit: storedDailyShadowLimit,
            weekdayLimit: storedWeekdayLimit,
            weekendLimit: storedWeekendLimit,
            sessionLimit: storedSessionLimit,
            breakEvery: storedBreakEvery,
            breakDuration: storedBreakDuration,
            focusMode: Boolean(timeLimit.focusMode ?? false),
            downtimeEnabled: Boolean(timeLimit.downtimeEnabled ?? true),
          },
          create: {
            childId,
            dailyLimit: storedDailyShadowLimit,
            weekdayLimit: storedWeekdayLimit,
            weekendLimit: storedWeekendLimit,
            sessionLimit: storedSessionLimit,
            breakEvery: storedBreakEvery,
            breakDuration: storedBreakDuration,
            focusMode: Boolean(timeLimit.focusMode ?? false),
            downtimeEnabled: Boolean(timeLimit.downtimeEnabled ?? true),
          },
        }),
        prisma.childAppLimit.deleteMany({ where: { childId } }),
        prisma.childCategoryLimit.deleteMany({ where: { childId } }),
        prisma.childAlwaysAllowed.deleteMany({ where: { childId } }),
        prisma.childFocusBlocked.deleteMany({ where: { childId } }),
        upsertBedtimeSchedule(childId, bedtimeSchedule),
        prisma.childAppLimit.createMany({
          data: appLimits
            .filter((item) => item?.name)
            .map((item) => ({
              childId,
              name: String(item.name),
              minutes: Number(item.minutes ?? 0),
            })),
          skipDuplicates: true,
        }),
        prisma.childCategoryLimit.createMany({
          data: categoryLimits
            .filter((item) => item?.name)
            .map((item) => ({
              childId,
              name: String(item.name),
              minutes: Number(item.minutes ?? 0),
            })),
          skipDuplicates: true,
        }),
        prisma.childAlwaysAllowed.createMany({
          data: alwaysAllowed
            .filter((name) => name && String(name).trim().length > 0)
            .map((name) => ({
              childId,
              name: String(name),
            })),
          skipDuplicates: true,
        }),
        prisma.childFocusBlocked.createMany({
          data: blockedDuringFocus
            .filter((name) => name && String(name).trim().length > 0)
            .map((name) => ({
              childId,
              name: String(name),
            })),
          skipDuplicates: true,
        }),
      ]);

    try {
      await persistTimeLimitData();
    } catch (error) {
      if (!isPrismaTableMissingError(error)) throw error;
      await ensureTimeLimitTables();
      await persistTimeLimitData();
    }

    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save time limits.";
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
