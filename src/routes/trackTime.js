const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { getUBTodayDate, checkTimeLimit } = require("../lib/timeUtils");

const TRACK_INCREMENT_SEC = 60;
const ISO_WITH_TIMEZONE_REGEX = /(Z|[+-]\d{2}:\d{2})$/i;
const ISO_WITHOUT_TIMEZONE_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const normalizeTimeZone = (value) => {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return null;
  }
};

const getDateTimePartsInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
};

const parseNaiveIsoToUtc = (value, timeZone, timezoneOffsetMinutes) => {
  const match = value.match(ISO_WITHOUT_TIMEZONE_REGEX);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = "0", msRaw = "0"] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(msRaw.padEnd(3, "0"));

  if (
    ![year, month, day, hour, minute, second, millisecond].every((item) => Number.isFinite(item))
  ) {
    return null;
  }

  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (Number.isFinite(Number(timezoneOffsetMinutes))) {
    return new Date(naiveUtcMs + Number(timezoneOffsetMinutes) * 60 * 1000);
  }

  const safeTimeZone = normalizeTimeZone(timeZone ?? null);
  if (!safeTimeZone) {
    return new Date(naiveUtcMs);
  }

  let guessMs = naiveUtcMs;
  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  for (let i = 0; i < 3; i += 1) {
    const currentParts = getDateTimePartsInTimeZone(new Date(guessMs), safeTimeZone);
    const currentLocalMs = Date.UTC(
      currentParts.year,
      currentParts.month - 1,
      currentParts.day,
      currentParts.hour,
      currentParts.minute,
      currentParts.second,
      millisecond,
    );
    const diff = targetLocalMs - currentLocalMs;
    if (diff === 0) break;
    guessMs += diff;
  }

  return new Date(guessMs);
};

const parseVisitedAt = (visitedAt, timeZone, timezoneOffsetMinutes) => {
  if (visitedAt === null || visitedAt === undefined || visitedAt === "") return null;

  if (visitedAt instanceof Date) {
    return Number.isNaN(visitedAt.getTime()) ? null : visitedAt;
  }

  if (typeof visitedAt === "number" || (typeof visitedAt === "string" && /^\d+$/.test(visitedAt))) {
    const numericDate = new Date(Number(visitedAt));
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }

  if (typeof visitedAt !== "string") return null;
  const raw = visitedAt.trim();
  if (!raw) return null;

  if (ISO_WITH_TIMEZONE_REGEX.test(raw)) {
    const zoned = new Date(raw);
    return Number.isNaN(zoned.getTime()) ? null : zoned;
  }

  const parsedNaive = parseNaiveIsoToUtc(raw, timeZone, timezoneOffsetMinutes);
  if (parsedNaive && !Number.isNaN(parsedNaive.getTime())) {
    return parsedNaive;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

router.post("/", async (req, res) => {
  const { childId, url, visitedAt, timeZone, timezoneOffsetMinutes } = req.body;

  const durationInput = Number(req.body?.duration);
  const incrementSeconds =
    Number.isFinite(durationInput) && durationInput > 0
      ? Math.min(Math.floor(durationInput), 300)
      : TRACK_INCREMENT_SEC;

  if (!childId || !url) {
    return res.status(400).json({ status: "ERROR", message: "Missing data" });
  }

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, "");
    const today = getUBTodayDate();
    if (!(today instanceof Date)) {
      throw new Error("getUBTodayDate must return a Date object");
    }

    const exactTime = parseVisitedAt(visitedAt, timeZone, timezoneOffsetMinutes) ?? new Date();

    let categoryName = "Uncategorized";
    const catalog = await prisma.urlCatalog.findUnique({ where: { domain } });
    if (catalog) categoryName = catalog.categoryName;

    const category = await prisma.categoryCatalog.upsert({
      where: { name: categoryName },
      update: {},
      create: { name: categoryName },
    });

    await prisma.$transaction(async (tx) => {
      await tx.dailyUsage.upsert({
        where: {
          childId_categoryId_date: {
            childId: Number(childId),
            categoryId: category.id,
            date: today,
          },
        },
        update: { duration: { increment: incrementSeconds } },
        create: {
          childId: Number(childId),
          categoryId: category.id,
          date: today,
          duration: incrementSeconds,
        },
      });

      const recentHistory = await tx.history.findFirst({
        where: {
          childId: Number(childId),
          domain,
          visitedAt: {
            gte: new Date(exactTime.getTime() - 5 * 60 * 1000),
          },
        },
        orderBy: { visitedAt: "desc" },
      });

      if (recentHistory) {
        await tx.history.update({
          where: { id: recentHistory.id },
          data: {
            duration: { increment: incrementSeconds },
            fullUrl: url,
            visitedAt: exactTime,
          },
        });
      } else {
        await tx.history.create({
          data: {
            childId: Number(childId),
            fullUrl: url,
            domain,
            categoryName,
            actionTaken: "ALLOWED",
            duration: incrementSeconds,
            visitedAt: exactTime,
          },
        });
      }
    });

    const timeStatus = await checkTimeLimit(Number(childId), category.id);
    if (timeStatus.isBlocked) {
      return res.json({
        status: "BLOCK",
        reason: timeStatus.reason || "TIME_LIMIT_EXCEEDED",
        category: categoryName,
      });
    }

    return res.json({ status: "OK", remaining: timeStatus.remainingSeconds });
  } catch (error) {
    console.error("TrackTime Error:", error.message);
    return res.status(500).json({ status: "ERROR" });
  }
});

module.exports = router;
