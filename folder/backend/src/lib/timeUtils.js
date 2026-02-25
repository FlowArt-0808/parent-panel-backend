const prisma = require("./prisma");

const UB_TIMEZONE = "Asia/Ulaanbaatar";

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

function isWithinDowntime(nowMinutes, startMinutes, endMinutes) {
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

async function checkTimeLimit(childId, categoryId) {
  const today = getUBTodayDate();
  const nowMinutes = getUBTimeMinutes();
  const weekday = today.getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const isDowntimeWeekend = weekday === 5 || weekday === 6 || weekday === 0;

  const [usage, setting, totalUsage, childLimit] = await Promise.all([
    prisma.dailyUsage.findUnique({
      where: {
        childId_categoryId_date: {
          childId: Number(childId),
          categoryId: Number(categoryId),
          date: today,
        },
      },
    }),
    prisma.childCategorySetting.findUnique({
      where: {
        childId_categoryId: {
          childId: Number(childId),
          categoryId: Number(categoryId),
        },
      },
    }),
    prisma.dailyUsage.aggregate({
      where: {
        childId: Number(childId),
        date: today,
      },
      _sum: { duration: true },
    }),
    prisma.childTimeLimit.findUnique({
      where: { childId: Number(childId) },
    }),
  ]);

  const usedSeconds = usage ? usage.duration : 0;
  const totalSeconds = totalUsage?._sum?.duration ?? 0;

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

  if (limitConfig.downtimeEnabled) {
    const start = isDowntimeWeekend ? limitConfig.downtimeWeekendStart : limitConfig.downtimeWeekdayStart;
    const end = isDowntimeWeekend ? limitConfig.downtimeWeekendEnd : limitConfig.downtimeWeekdayEnd;
    if (isWithinDowntime(nowMinutes, start, end)) {
      return {
        isBlocked: true,
        reason: "DOWNTIME",
        remainingSeconds: 0,
      };
    }
  }

  const dayLimitMinutes = isWeekend ? limitConfig.weekendLimit : limitConfig.weekdayLimit;
  const effectiveDayLimitMinutes = Number.isFinite(dayLimitMinutes) && dayLimitMinutes > 0
    ? dayLimitMinutes
    : limitConfig.dailyLimit;
  const dailyLimitSeconds = Number.isFinite(effectiveDayLimitMinutes) && effectiveDayLimitMinutes > 0
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

  if (setting && setting.status === "LIMITED" && setting.timeLimit) {
    const limitSeconds = setting.timeLimit * 60;
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
