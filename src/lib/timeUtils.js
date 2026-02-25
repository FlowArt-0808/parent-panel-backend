const prisma = require("./prisma");
const TABLE_NOT_FOUND_CODE = "P2021";
const DEFAULT_TIME_LIMIT_SECONDS = {
  dailyLimit: 240 * 60,
  weekdayLimit: 180 * 60,
  weekendLimit: 300 * 60,
  sessionLimit: 60 * 60,
  breakEvery: 45 * 60,
  breakDuration: 10 * 60,
};
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
    "dailyLimit" INTEGER NOT NULL DEFAULT 14400,
    "weekdayLimit" INTEGER NOT NULL DEFAULT 10800,
    "weekendLimit" INTEGER NOT NULL DEFAULT 18000,
    "sessionLimit" INTEGER NOT NULL DEFAULT 3600,
    "breakEvery" INTEGER NOT NULL DEFAULT 2700,
    "breakDuration" INTEGER NOT NULL DEFAULT 600,
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

// Улаанбаатарын цагаар "Өнөөдөр"-ийн огноог UTC 00:00 дээр тогтвортой авна
// Энэ нь DB-ийн DATE талбарт зөв өдөр буухад тусална.
function getUBTodayDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year")?.value ?? 0);
  const month = Number(parts.find(part => part.type === "month")?.value ?? 1);
  const day = Number(parts.find(part => part.type === "day")?.value ?? 1);
  return new Date(Date.UTC(year, month - 1, day));
}

// Улаанбаатарын яг одоогийн цагийг авах (History visitedAt-д зориулж)
function getUBCurrentTime() {
  const now = new Date();
  // Одоогийн системийг цагийг UB руу хөрвүүлэх
  const ubString = now.toLocaleString("en-US", {
    timeZone: "Asia/Ulaanbaatar",
  });
  return new Date(ubString);
}

function toSafeSeconds(value, fallbackSeconds) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackSeconds;
  return Math.max(1, Math.round(numeric));
}

function toMinuteOfDay(value, fallbackMinute) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackMinute;
  const rounded = Math.round(numeric);
  return Math.max(0, Math.min(1439, rounded));
}

function isLikelyLegacyMinuteRow(row) {
  return (
    row.dailyLimit >= 30 &&
    row.dailyLimit <= 720 &&
    row.dailyLimit % 30 === 0 &&
    row.weekdayLimit >= 30 &&
    row.weekdayLimit <= 600 &&
    row.weekdayLimit % 30 === 0 &&
    row.weekendLimit >= 30 &&
    row.weekendLimit <= 720 &&
    row.weekendLimit % 30 === 0 &&
    row.sessionLimit >= 15 &&
    row.sessionLimit <= 180 &&
    row.sessionLimit % 15 === 0 &&
    row.breakEvery >= 15 &&
    row.breakEvery <= 120 &&
    row.breakEvery % 15 === 0 &&
    row.breakDuration >= 5 &&
    row.breakDuration <= 30 &&
    row.breakDuration % 5 === 0
  );
}

function normalizeTimeLimitRow(row) {
  return {
    ...row,
    dailyLimit: toSafeSeconds(row.dailyLimit, DEFAULT_TIME_LIMIT_SECONDS.dailyLimit),
    weekdayLimit: toSafeSeconds(row.weekdayLimit, DEFAULT_TIME_LIMIT_SECONDS.weekdayLimit),
    weekendLimit: toSafeSeconds(row.weekendLimit, DEFAULT_TIME_LIMIT_SECONDS.weekendLimit),
    sessionLimit: toSafeSeconds(row.sessionLimit, DEFAULT_TIME_LIMIT_SECONDS.sessionLimit),
    breakEvery: toSafeSeconds(row.breakEvery, DEFAULT_TIME_LIMIT_SECONDS.breakEvery),
    breakDuration: toSafeSeconds(row.breakDuration, DEFAULT_TIME_LIMIT_SECONDS.breakDuration),
  };
}

function normalizeBedtimeSchedule(row) {
  return {
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
  };
}

function isTableMissingError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === TABLE_NOT_FOUND_CODE
  );
}

async function ensureTimeLimitTables() {
  for (const statement of TIME_LIMIT_DDL_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function ensureChildTimeLimitRow(numericChildId) {
  let row = await prisma.childTimeLimit.findUnique({
    where: { childId: numericChildId },
    select: {
      childId: true,
      dailyLimit: true,
      weekdayLimit: true,
      weekendLimit: true,
      sessionLimit: true,
      breakEvery: true,
      breakDuration: true,
    },
  });

  if (!row) {
    row = await prisma.childTimeLimit.upsert({
      where: { childId: numericChildId },
      update: {},
      create: {
        childId: numericChildId,
        dailyLimit: DEFAULT_TIME_LIMIT_SECONDS.dailyLimit,
        weekdayLimit: DEFAULT_TIME_LIMIT_SECONDS.weekdayLimit,
        weekendLimit: DEFAULT_TIME_LIMIT_SECONDS.weekendLimit,
        sessionLimit: DEFAULT_TIME_LIMIT_SECONDS.sessionLimit,
        breakEvery: DEFAULT_TIME_LIMIT_SECONDS.breakEvery,
        breakDuration: DEFAULT_TIME_LIMIT_SECONDS.breakDuration,
        focusMode: false,
        downtimeEnabled: true,
      },
      select: {
        childId: true,
        dailyLimit: true,
        weekdayLimit: true,
        weekendLimit: true,
        sessionLimit: true,
        breakEvery: true,
        breakDuration: true,
      },
    });
  }

  if (isLikelyLegacyMinuteRow(row)) {
    row = await prisma.childTimeLimit.update({
      where: { childId: numericChildId },
      data: {
        dailyLimit: row.dailyLimit * 60,
        weekdayLimit: row.weekdayLimit * 60,
        weekendLimit: row.weekendLimit * 60,
        sessionLimit: row.sessionLimit * 60,
        breakEvery: row.breakEvery * 60,
        breakDuration: row.breakDuration * 60,
      },
      select: {
        childId: true,
        dailyLimit: true,
        weekdayLimit: true,
        weekendLimit: true,
        sessionLimit: true,
        breakEvery: true,
        breakDuration: true,
      },
    });
  }

  return normalizeTimeLimitRow(row);
}

async function fetchBedtimeSchedule(numericChildId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
      "schoolNightStartMinute",
      "schoolNightEndMinute",
      "weekendStartMinute",
      "weekendEndMinute"
    FROM "ChildBedtimeSchedule"
    WHERE "childId" = $1
    LIMIT 1`,
    numericChildId,
  );
  return normalizeBedtimeSchedule(rows[0]);
}

function getCurrentUBWeekdayAndMinute() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ulaanbaatar",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const weekdayText = parts.find(part => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? "0");

  const weekdayByName = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayByName[weekdayText] ?? 0;
  const minuteOfDay = Math.max(0, Math.min(1439, hour * 60 + minute));

  return { weekday, minuteOfDay };
}

function isScheduleActiveNow(startMinute, endMinute, activeDays, weekday, minuteOfDay) {
  if (startMinute === endMinute) {
    return activeDays.has(weekday);
  }

  if (startMinute < endMinute) {
    return (
      activeDays.has(weekday) && minuteOfDay >= startMinute && minuteOfDay < endMinute
    );
  }

  const previousWeekday = (weekday + 6) % 7;
  if (activeDays.has(weekday) && minuteOfDay >= startMinute) {
    return true;
  }

  return activeDays.has(previousWeekday) && minuteOfDay < endMinute;
}

async function fetchGlobalDailyLimitStatus(numericChildId, today) {
  const [limitRow, usageRows] = await Promise.all([
    ensureChildTimeLimitRow(numericChildId),
    prisma.dailyUsage.findMany({
      where: { childId: numericChildId, date: today },
      select: { duration: true },
    }),
  ]);

  const usedSeconds = usageRows.reduce((sum, row) => sum + Number(row.duration ?? 0), 0);

  const limitSeconds = toSafeSeconds(
    limitRow.dailyLimit,
    DEFAULT_TIME_LIMIT_SECONDS.dailyLimit,
  );
  const isBlocked = usedSeconds >= limitSeconds;
  return {
    isBlocked,
    usedSeconds,
    limitSeconds,
    remainingSeconds: Math.max(0, limitSeconds - usedSeconds),
  };
}

async function checkTimeLimit(childId, categoryId) {
  const today = getUBTodayDate();

  // 1. Тухайн өдрийн хэрэглээг авах
  const usage = await prisma.dailyUsage.findUnique({
    where: {
      childId_categoryId_date: {
        childId: Number(childId),
        categoryId: Number(categoryId),
        date: today,
      },
    },
  });

  const usedSeconds = usage ? usage.duration : 0;

  // 2. Хүүхдийн тохиргоог шалгах
  const setting = await prisma.childCategorySetting.findUnique({
    where: {
      childId_categoryId: {
        childId: Number(childId),
        categoryId: Number(categoryId),
      },
    },
  });

  // --- ШИНЭЧЛЭЛТ: BLOCKED төлөвийг шалгах ---
  if (!setting) {
    return { isBlocked: false, remainingSeconds: null };
  }

  // Хэрэв эцэг эх шууд БЛОКЛОСОН бол хугацаа харахгүй шууд хаана
  if (setting.status === "BLOCKED") {
    return {
      isBlocked: true,
      usedSeconds,
      limitSeconds: 0,
      remainingSeconds: 0,
    };
  }

  // Хэрэв хязгаар тогтоогоогүй бол (ALLOWED)
  if (setting.status !== "LIMITED" || !setting.timeLimit) {
    return { isBlocked: false, remainingSeconds: null };
  }

  // 3. LIMITED үед хугацаа шалгах
  const limitSeconds = setting.timeLimit * 60;
  const isBlocked = usedSeconds >= limitSeconds;

  return {
    isBlocked,
    usedSeconds,
    limitSeconds,
    remainingSeconds: Math.max(0, limitSeconds - usedSeconds),
  };
}

async function checkGlobalDailyLimit(childId) {
  const numericChildId = Number(childId);
  const today = getUBTodayDate();

  try {
    return await fetchGlobalDailyLimitStatus(numericChildId, today);
  } catch (error) {
    if (isTableMissingError(error)) {
      await ensureTimeLimitTables();
      return await fetchGlobalDailyLimitStatus(numericChildId, today);
    }
    throw error;
  }
}

async function checkBedtimeSchedule(childId) {
  const numericChildId = Number(childId);
  const runCheck = async () => {
    const schedule = await fetchBedtimeSchedule(numericChildId);
    const { weekday, minuteOfDay } = getCurrentUBWeekdayAndMinute();
    const schoolNightDays = new Set([1, 2, 3, 4]); // Mon-Thu
    const weekendDays = new Set([5, 6, 0]); // Fri-Sun

    const schoolNightActive = isScheduleActiveNow(
      schedule.schoolNightStartMinute,
      schedule.schoolNightEndMinute,
      schoolNightDays,
      weekday,
      minuteOfDay,
    );
    const weekendActive = isScheduleActiveNow(
      schedule.weekendStartMinute,
      schedule.weekendEndMinute,
      weekendDays,
      weekday,
      minuteOfDay,
    );

    return {
      isBlocked: schoolNightActive || weekendActive,
      scheduleType: schoolNightActive
        ? "SCHOOL_NIGHT"
        : weekendActive
          ? "WEEKEND"
          : null,
    };
  };

  try {
    return await runCheck();
  } catch (error) {
    if (isTableMissingError(error)) {
      await ensureTimeLimitTables();
      return await runCheck();
    }
    throw error;
  }
}

module.exports = {
  getUBTodayDate,
  getUBCurrentTime,
  checkTimeLimit,
  checkGlobalDailyLimit,
  checkBedtimeSchedule,
};
