const prisma = require("./prisma");

const UB_TIMEZONE = "Asia/Ulaanbaatar";
const TABLE_NOT_FOUND_CODE = "P2021";

const isPrismaTableMissingError = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === TABLE_NOT_FOUND_CODE;

const getUBDateParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: UB_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = Number(parts.find(part => part.type === "year")?.value ?? 0);
  const month = Number(parts.find(part => part.type === "month")?.value ?? 1);
  const day = Number(parts.find(part => part.type === "day")?.value ?? 1);
  return { year, month, day };
};

const getUBDateTimeParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: UB_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const year = Number(parts.find(part => part.type === "year")?.value ?? 0);
  const month = Number(parts.find(part => part.type === "month")?.value ?? 1);
  const day = Number(parts.find(part => part.type === "day")?.value ?? 1);
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? 0);
  const second = Number(parts.find(part => part.type === "second")?.value ?? 0);
  return { year, month, day, hour, minute, second };
};

// Улаанбаатарын цагаар "Өнөөдөр"-ийн огноог UTC 00:00 дээр тогтвортой авна
// Энэ нь DB-ийн DATE талбарт зөв өдөр буухад тусална.
function getUBTodayDate() {
  const { year, month, day } = getUBDateParts();
  return new Date(Date.UTC(year, month - 1, day));
}

// Улаанбаатарын яг одоогийн цагийг авах (History visitedAt-д зориулж)
function getUBCurrentTime() {
  const { year, month, day, hour, minute, second } = getUBDateTimeParts();
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function getUBTimeMinutes(value = new Date()) {
  const { hour, minute } = getUBDateTimeParts(value);
  return hour * 60 + minute;
}


const DEFAULT_BEDTIME_SCHEDULE = {
  schoolNightStartMinute: 21 * 60,
  schoolNightEndMinute: 7 * 60,
  weekendStartMinute: 22 * 60,
  weekendEndMinute: 8 * 60,
};

const toMinuteOfDay = (value, fallbackMinute) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackMinute;
  const rounded = Math.round(numeric);
  return Math.max(0, Math.min(1439, rounded));
};

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

const isMissingBedtimeTableError = (error) => {
  if (isPrismaTableMissingError(error)) return true;
  const message = typeof error?.message === "string" ? error.message : "";
  return /ChildBedtimeSchedule|does not exist|no such table/i.test(message);
};

const getBedtimeSchedule = async (childId) => {
  try {
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
    return normalizeBedtimeSchedule(rows?.[0]);
  } catch (error) {
    if (isMissingBedtimeTableError(error)) {
      return normalizeBedtimeSchedule(null);
    }
    throw error;
  }
};

function isWithinDowntime(nowMinutes, startMinutes, endMinutes) {
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

async function checkTimeLimit(childId, categoryId) {
  const numericChildId = Number(childId);
  const numericCategoryId = Number(categoryId);
  const today = getUBTodayDate();
  const nowMinutes = getUBTimeMinutes();
  const weekday = today.getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const isDowntimeWeekend = weekday === 5 || weekday === 6 || weekday === 0;

  const [usage, setting, totalUsage, childLimit, categoryInfo, bedtimeSchedule] = await Promise.all([
    prisma.dailyUsage.findUnique({
      where: {
        childId_categoryId_date: {
          childId: numericChildId,
          categoryId: numericCategoryId,
          date: today,
        },
      },
    }),
    prisma.childCategorySetting.findUnique({
      where: {
        childId_categoryId: {
          childId: numericChildId,
          categoryId: numericCategoryId,
        },
      },
    }),
    prisma.dailyUsage.aggregate({
      where: {
        childId: numericChildId,
        date: today,
      },
      _sum: { duration: true },
    }),
    prisma.childTimeLimit.findUnique({
      where: { childId: numericChildId },
    }),
    prisma.categoryCatalog.findUnique({
      where: { id: numericCategoryId },
      select: { name: true },
    }),
    getBedtimeSchedule(numericChildId),
  ]);

  const usedSeconds = usage ? usage.duration : 0;
  const totalSeconds = totalUsage?._sum?.duration ?? 0;

  const legacyCategoryLimitMinutes =
    setting &&
    setting.status === "LIMITED" &&
    Number.isFinite(setting.timeLimit) &&
    setting.timeLimit > 0
      ? setting.timeLimit
      : null;

  let categoryLimitMinutes = null;
  if (categoryInfo?.name) {
    try {
      const categoryLimit = await prisma.childCategoryLimit.findFirst({
        where: {
          childId: numericChildId,
          name: {
            equals: categoryInfo.name,
            mode: "insensitive",
          },
        },
        select: { minutes: true },
      });
      const parsedMinutes = Number(categoryLimit?.minutes);
      if (Number.isFinite(parsedMinutes) && parsedMinutes > 0) {
        categoryLimitMinutes = parsedMinutes;
      }
    } catch (error) {
      if (!isPrismaTableMissingError(error)) {
        throw error;
      }
    }
  }

  const effectiveCategoryLimitMinutes = [legacyCategoryLimitMinutes, categoryLimitMinutes]
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((min, value) => (min === null ? value : Math.min(min, value)), null);

  const hasCategoryLimit = Number.isFinite(effectiveCategoryLimitMinutes) && effectiveCategoryLimitMinutes > 0;

  const hasCustomChildLimit = Boolean(childLimit) &&
    childLimit.createdAt instanceof Date &&
    childLimit.updatedAt instanceof Date &&
    childLimit.updatedAt.getTime() !== childLimit.createdAt.getTime();

  const hasGlobalLimits = hasCustomChildLimit && (
    childLimit.downtimeEnabled ||
    (Number.isFinite(childLimit.dailyLimit) && childLimit.dailyLimit > 0) ||
    (Number.isFinite(childLimit.weekdayLimit) && childLimit.weekdayLimit > 0) ||
    (Number.isFinite(childLimit.weekendLimit) && childLimit.weekendLimit > 0)
  );

  if (!hasGlobalLimits && !hasCategoryLimit) {
    return {
      isBlocked: false,
      remainingSeconds: null,
      usedSeconds,
    };
  }

  const limitConfig = childLimit ?? {
    dailyLimit: 240,
    weekdayLimit: 180,
    weekendLimit: 300,
    downtimeEnabled: true,
    downtimeWeekdayStart: 1260,
    downtimeWeekdayEnd: 420,
    downtimeWeekendStart: 1320,
    downtimeWeekendEnd: 480,
  };

  const bedtimeConfig = bedtimeSchedule ?? DEFAULT_BEDTIME_SCHEDULE;

  if (hasGlobalLimits && limitConfig.downtimeEnabled) {
    const start = isDowntimeWeekend ? bedtimeConfig.weekendStartMinute : bedtimeConfig.schoolNightStartMinute;
    const end = isDowntimeWeekend ? bedtimeConfig.weekendEndMinute : bedtimeConfig.schoolNightEndMinute;
    if (isWithinDowntime(nowMinutes, start, end)) {
      return {
        isBlocked: true,
        reason: "DOWNTIME",
        remainingSeconds: 0,
      };
    }
  }

  let dailyLimitSeconds = null;
  if (hasGlobalLimits) {
    const dayLimitMinutes = isWeekend ? limitConfig.weekendLimit : limitConfig.weekdayLimit;
    const effectiveDayLimitMinutes = Number.isFinite(dayLimitMinutes) && dayLimitMinutes > 0
      ? dayLimitMinutes
      : limitConfig.dailyLimit;
    dailyLimitSeconds = Number.isFinite(effectiveDayLimitMinutes) && effectiveDayLimitMinutes > 0
      ? effectiveDayLimitMinutes * 60
      : null;

    if (dailyLimitSeconds !== null && totalSeconds >= dailyLimitSeconds) {
      return {
        isBlocked: true,
        reason: "DAILY_LIMIT",
        remainingSeconds: 0,
        usedSeconds,
        limitSeconds: dailyLimitSeconds,
      };
    }
  }

  if (setting && setting.status === "BLOCKED") {
    return {
      isBlocked: true,
      reason: "CATEGORY_BLOCKED",
      usedSeconds,
      limitSeconds: 0,
      remainingSeconds: 0,
    };
  }

  const remainingCandidates = [];
  if (dailyLimitSeconds !== null) {
    remainingCandidates.push(Math.max(0, dailyLimitSeconds - totalSeconds));
  }

  if (hasCategoryLimit) {
    const limitSeconds = effectiveCategoryLimitMinutes * 60;
    const categoryRemaining = Math.max(0, limitSeconds - usedSeconds);
    remainingCandidates.push(categoryRemaining);
    if (usedSeconds >= limitSeconds) {
      return {
        isBlocked: true,
        reason: "CATEGORY_LIMIT",
        usedSeconds,
        limitSeconds,
        remainingSeconds: 0,
      };
    }
  }

  const remainingSeconds = remainingCandidates.length
    ? Math.min(...remainingCandidates)
    : null;

  return {
    isBlocked: false,
    remainingSeconds,
    usedSeconds,
  };
}

module.exports = {
  getUBTodayDate,
  getUBCurrentTime,
  checkTimeLimit,
};
