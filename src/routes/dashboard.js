const express = require("express");
const prisma = require("../lib/prisma");
const { getSessionFromRequest, unauthorizedJson } = require("../lib/session");

const router = express.Router();

const DEFAULT_TIMEZONE = "UTC";

const normalizeTimeZone = (value) => {
  if (!value) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

const getDateKey = (value, timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);

const getHour = (value, timeZone) =>
  Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(value)
  );

const getDayStart = (timeZone, value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = Number(parts.find(part => part.type === "year")?.value ?? 0);
  const month = Number(parts.find(part => part.type === "month")?.value ?? 1);
  const day = Number(parts.find(part => part.type === "day")?.value ?? 1);
  return new Date(Date.UTC(year, month - 1, day));
};

const normalizeRange = (range) => {
  if (range === "today" || range === "7d" || range === "30d" || range === "all") return range;
  return "7d";
};

const parseRangeDays = (range) => {
  switch (range) {
    case "today":
      return 1;
    case "30d":
      return 30;
    case "7d":
    default:
      return 7;
  }
};

const toDateKey = (value, timeZone) => getDateKey(value, timeZone);

const formatHourLabel = (hour) => {
  const normalized = hour % 24;
  const display = normalized % 12 === 0 ? 12 : normalized % 12;
  const suffix = normalized < 12 ? "am" : "pm";
  return `${display}${suffix}`;
};

const buildHourLabels = (bucketHours) => {
  const labels = [];
  for (let hour = 0; hour < 24; hour += bucketHours) {
    const endHour = (hour + bucketHours) % 24;
    labels.push({
      key: hour,
      label: `${formatHourLabel(hour)}-${formatHourLabel(endHour)}`,
    });
  }
  return labels;
};

const buildDayLabels = (days, timeZone) => {
  const labels = [];
  const today = getDayStart(timeZone, new Date());
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - i);
    const key = toDateKey(date, timeZone);
    let label = "";
    if (days === 1) {
      label = "Today";
    } else if (days <= 7) {
      label = date.toLocaleDateString("en-US", { weekday: "short", timeZone });
    } else {
      label = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone,
      });
    }
    labels.push({ key, label, date });
  }
  return labels;
};

const buildDayLabelsBetween = (startDate, endDate, timeZone) => {
  const labels = [];
  const start = getDayStart(timeZone, startDate);
  const end = getDayStart(timeZone, endDate);
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const key = toDateKey(cursor, timeZone);
    const label = cursor.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "2-digit",
      timeZone,
    });
    labels.push({ key, label, date: new Date(cursor) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
};

const secondsToMinutes = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds / 60;
};

const secondsToTimelineMinutes = (seconds) => {
  const safe = Math.max(0, Number(seconds ?? 0));
  if (safe <= 0) return 0;
  return Math.max(1, Math.round(secondsToMinutes(safe)));
};

const normalizeCategoryName = (value) => {
  const raw = (value ?? "").trim();
  if (!raw) return "Other";
  const lowered = raw.toLowerCase();
  if (lowered === "custom" || lowered === "uncategorized") {
    return "Other";
  }
  return raw;
};

const toFaviconUrl = (domain) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

const toRiskLevel = (safetyScore) => {
  if (safetyScore >= 80) return "Safe";
  if (safetyScore >= 50) return "Suspicious";
  return "Dangerous";
};

router.get("/", async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return unauthorizedJson(res);
  }

  const childIdParam = req.query?.childId;
  const range = normalizeRange(req.query?.range);
  const timeZone = normalizeTimeZone(req.query?.timeZone);

  const childId = childIdParam ? Number.parseInt(childIdParam, 10) : null;
  if (!childId || Number.isNaN(childId)) {
    return res.status(400).json({ error: "Invalid childId" });
  }

  const child = await prisma.child.findUnique({
    where: { id: childId },
    select: { id: true, parentId: true },
  });

  if (!child || child.parentId !== session.userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const days = range === "all" ? null : parseRangeDays(range);
  const start = days ? getDayStart(timeZone, new Date()) : null;
  if (start && days) {
    start.setUTCDate(start.getUTCDate() - (days - 1));
  }

  const historyStart =
    range === "all"
      ? null
      : range === "today" && start
        ? new Date(start.getTime() - 24 * 60 * 60 * 1000)
        : start;

  const historyWhere = { childId };
  if (historyStart) {
    historyWhere.visitedAt = { gte: historyStart };
  }

  const alertsWhere = { childId };
  if (start) {
    alertsWhere.createdAt = { gte: start };
  }

  const [history, alerts, blockedSitesCount] = await Promise.all([
    prisma.history.findMany({
      where: historyWhere,
      select: {
        categoryName: true,
        fullUrl: true,
        duration: true,
        domain: true,
        actionTaken: true,
        visitedAt: true,
      },
    }),
    prisma.alert.findMany({
      where: alertsWhere,
      select: { type: true },
    }),
    prisma.childUrlSetting.count({
      where: {
        childId,
        status: "BLOCKED",
      },
    }),
  ]);

  const todayKey = getDateKey(new Date(), timeZone);
  const todaySeconds = history.reduce((sum, entry) => {
    if (!entry.visitedAt) return sum;
    const visitedAt = new Date(entry.visitedAt);
    if (Number.isNaN(visitedAt.getTime())) return sum;
    if (toDateKey(visitedAt, timeZone) !== todayKey) return sum;
    return sum + Math.max(0, Number(entry.duration ?? 0));
  }, 0);

  const historyInRange =
    range === "today"
      ? history.filter((entry) => {
          if (!entry.visitedAt) return false;
          const visitedAt = new Date(entry.visitedAt);
          if (Number.isNaN(visitedAt.getTime())) return false;
          return toDateKey(visitedAt, timeZone) === todayKey;
        })
      : history;

  const rangeTotalSeconds = historyInRange.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.duration ?? 0)),
    0,
  );

  let usageTimeline = [];

  if (range === "today") {
    const bucketHours = 2;
    const hourLabels = buildHourLabels(bucketHours);
    const hourTotals = new Map(hourLabels.map(item => [item.key, 0]));
    const bucketSites = new Map();

    const todayBucketKey = getDateKey(new Date(), timeZone);

    for (const entry of historyInRange) {
      if (!entry.visitedAt) continue;
      const visited = new Date(entry.visitedAt);
      if (Number.isNaN(visited.getTime())) continue;
      if (getDateKey(visited, timeZone) !== todayBucketKey) continue;
      const hour = getHour(visited, timeZone);
      const bucket = Math.floor(hour / bucketHours) * bucketHours;
      hourTotals.set(bucket, (hourTotals.get(bucket) ?? 0) + (entry.duration ?? 0));

      const url = typeof entry.fullUrl === "string" && entry.fullUrl ? entry.fullUrl : "";
      if (!url) continue;
      if (!bucketSites.has(bucket)) {
        bucketSites.set(bucket, new Map());
      }
      const byUrl = bucketSites.get(bucket);
      if (!byUrl) continue;
      const leftAtMs = visited.getTime();
      const enteredAtMs = leftAtMs - Math.max(0, Number(entry.duration ?? 0)) * 1000;
      const current = byUrl.get(url);
      byUrl.set(url, {
        url,
        domain: entry.domain || "-",
        category: normalizeCategoryName(entry.categoryName),
        seconds: (current?.seconds ?? 0) + (entry.duration ?? 0),
        enteredAtMs: Math.min(current?.enteredAtMs ?? enteredAtMs, enteredAtMs),
        leftAtMs: Math.max(current?.leftAtMs ?? leftAtMs, leftAtMs),
      });
    }

    usageTimeline = hourLabels.map(item => ({
      day: item.label,
      minutes: secondsToTimelineMinutes(hourTotals.get(item.key) ?? 0),
      sites: Array.from((bucketSites.get(item.key) ?? new Map()).values())
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 8)
        .map((site) => ({
          url: site.url,
          domain: site.domain,
          category: site.category,
          minutes: Math.max(1, Math.round(secondsToMinutes(site.seconds))),
          logoUrl: toFaviconUrl(site.domain),
          enteredAt: new Date(site.enteredAtMs).toISOString(),
          leftAt: new Date(site.leftAtMs).toISOString(),
        })),
    }));

  } else if (range === "all") {
    const firstVisitedAt = history.reduce((oldest, entry) => {
      if (!entry.visitedAt) return oldest;
      const candidate = new Date(entry.visitedAt);
      if (Number.isNaN(candidate.getTime())) return oldest;
      if (!oldest || candidate.getTime() < oldest.getTime()) return candidate;
      return oldest;
    }, null);

    const allTimeLabels = buildDayLabelsBetween(firstVisitedAt ?? new Date(), new Date(), timeZone);
    const allTimeTotals = new Map(allTimeLabels.map((item) => [item.key, 0]));
    const allTimeSites = new Map();

    for (const entry of historyInRange) {
      if (!entry.visitedAt) continue;
      const visitedAt = new Date(entry.visitedAt);
      if (Number.isNaN(visitedAt.getTime())) continue;
      const key = toDateKey(visitedAt, timeZone);
      if (!allTimeTotals.has(key)) continue;
      allTimeTotals.set(key, (allTimeTotals.get(key) ?? 0) + (entry.duration ?? 0));

      const url = typeof entry.fullUrl === "string" && entry.fullUrl ? entry.fullUrl : "";
      if (!url) continue;
      if (!allTimeSites.has(key)) {
        allTimeSites.set(key, new Map());
      }
      const byUrl = allTimeSites.get(key);
      if (!byUrl) continue;
      const leftAtMs = visitedAt.getTime();
      const enteredAtMs = leftAtMs - Math.max(0, Number(entry.duration ?? 0)) * 1000;
      const current = byUrl.get(url);
      byUrl.set(url, {
        url,
        domain: entry.domain || "-",
        category: normalizeCategoryName(entry.categoryName),
        seconds: (current?.seconds ?? 0) + (entry.duration ?? 0),
        enteredAtMs: Math.min(current?.enteredAtMs ?? enteredAtMs, enteredAtMs),
        leftAtMs: Math.max(current?.leftAtMs ?? leftAtMs, leftAtMs),
      });
    }

    usageTimeline = allTimeLabels.map((item) => ({
      day: item.label,
      minutes: secondsToTimelineMinutes(allTimeTotals.get(item.key) ?? 0),
      sites: Array.from((allTimeSites.get(item.key) ?? new Map()).values())
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 8)
        .map((site) => ({
          url: site.url,
          domain: site.domain,
          category: site.category,
          minutes: Math.max(1, Math.round(secondsToMinutes(site.seconds))),
          logoUrl: toFaviconUrl(site.domain),
          enteredAt: new Date(site.enteredAtMs).toISOString(),
          leftAt: new Date(site.leftAtMs).toISOString(),
        })),
    }));

  } else {
    const rangeDays = days ?? 7;
    const labels = buildDayLabels(rangeDays, timeZone);
    const dayTotals = new Map(labels.map((item) => [item.key, 0]));
    for (const entry of historyInRange) {
      if (!entry.visitedAt) continue;
      const key = toDateKey(new Date(entry.visitedAt), timeZone);
      if (dayTotals.has(key)) {
        dayTotals.set(key, (dayTotals.get(key) ?? 0) + (entry.duration ?? 0));
      }
    }

    const daySites = new Map();
    for (const entry of historyInRange) {
      if (!entry.visitedAt) continue;
      const key = toDateKey(new Date(entry.visitedAt), timeZone);
      if (!dayTotals.has(key)) continue;
      const url = typeof entry.fullUrl === "string" && entry.fullUrl ? entry.fullUrl : "";
      if (!url) continue;
      if (!daySites.has(key)) {
        daySites.set(key, new Map());
      }
      const byUrl = daySites.get(key);
      if (!byUrl) continue;
      const visitedAt = new Date(entry.visitedAt);
      const leftAtMs = visitedAt.getTime();
      const enteredAtMs = leftAtMs - Math.max(0, Number(entry.duration ?? 0)) * 1000;
      const current = byUrl.get(url);
      byUrl.set(url, {
        url,
        domain: entry.domain || "-",
        category: normalizeCategoryName(entry.categoryName),
        seconds: (current?.seconds ?? 0) + (entry.duration ?? 0),
        enteredAtMs: Math.min(current?.enteredAtMs ?? enteredAtMs, enteredAtMs),
        leftAtMs: Math.max(current?.leftAtMs ?? leftAtMs, leftAtMs),
      });
    }

    usageTimeline = labels.map(item => ({
      day: item.label,
      minutes: secondsToTimelineMinutes(dayTotals.get(item.key) ?? 0),
      sites: Array.from((daySites.get(item.key) ?? new Map()).values())
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 8)
        .map((site) => ({
          url: site.url,
          domain: site.domain,
          category: site.category,
          minutes: Math.max(1, Math.round(secondsToMinutes(site.seconds))),
          logoUrl: toFaviconUrl(site.domain),
          enteredAt: new Date(site.enteredAtMs).toISOString(),
          leftAt: new Date(site.leftAtMs).toISOString(),
        })),
    }));
  }

  const categoryTotals = new Map();
  const categoryWebsiteSeconds = new Map();
  for (const entry of historyInRange) {
    const name = normalizeCategoryName(entry.categoryName);
    const duration = Math.max(0, Number(entry.duration ?? 0));
    categoryTotals.set(name, (categoryTotals.get(name) ?? 0) + duration);

    const url = typeof entry.fullUrl === "string" ? entry.fullUrl : "";
    if (!url) continue;
    const domain = entry.domain || "-";
    const key = `${name}|${url}`;
    const current = categoryWebsiteSeconds.get(key);
    categoryWebsiteSeconds.set(key, {
      category: name,
      url,
      domain,
      seconds: (current?.seconds ?? 0) + duration,
    });
  }

  const palette = ["#007AFF", "#5856D6", "#FF2D55", "#FF9500", "#8E8E93", "#34C759"];
  const categoryData = Array.from(categoryTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], index) => ({
      name,
      value,
      color: palette[index % palette.length],
    }));

  const uniqueDomains = [...new Set(history.map((item) => item.domain).filter(Boolean))];
  const domainCatalog = uniqueDomains.length
    ? await prisma.urlCatalog.findMany({
        where: { domain: { in: uniqueDomains } },
        select: { domain: true, safetyScore: true },
      })
    : [];

  const safetyScoreByDomain = new Map(
    domainCatalog.map((item) => [
      item.domain,
      Number.isFinite(Number(item.safetyScore)) ? Number(item.safetyScore) : 50,
    ]),
  );

  const riskCounts = { Safe: 0, Suspicious: 0, Dangerous: 0 };
  const riskVisitCounts = { Safe: 0, Suspicious: 0, Dangerous: 0 };
  const riskWebsiteSeconds = new Map();
  let weightedSafetyNumerator = 0;
  let totalExposureSeconds = 0;
  let blockedEvents = 0;
  let dangerousBlockedEvents = 0;

  for (const entry of historyInRange) {
    const duration = Math.max(0, Number(entry.duration ?? 0));
    const score = entry.domain ? (safetyScoreByDomain.get(entry.domain) ?? 50) : 50;
    weightedSafetyNumerator += score * duration;
    totalExposureSeconds += duration;

    const level = toRiskLevel(score);
    riskVisitCounts[level] += 1;

    if (level === "Safe") {
      riskCounts.Safe += duration;
    } else if (level === "Suspicious") {
      riskCounts.Suspicious += duration;
    } else {
      riskCounts.Dangerous += duration;
    }

    const url = typeof entry.fullUrl === "string" ? entry.fullUrl : "";
    if (url) {
      const category = normalizeCategoryName(entry.categoryName);
      const domain = entry.domain || "-";
      const key = `${level}|${url}`;
      const current = riskWebsiteSeconds.get(key);
      riskWebsiteSeconds.set(key, {
        level,
        category,
        url,
        domain,
        safetyScore: Math.round(score),
        seconds: (current?.seconds ?? 0) + duration,
      });
    }

    if (entry.actionTaken === "BLOCKED") {
      blockedEvents += 1;
      if (score < 50) {
        dangerousBlockedEvents += 1;
      }
    }
  }

  const dangerousAlerts = alerts.filter((item) => item.type === "DANGEROUS_CONTENT").length;
  const suspiciousAlerts = alerts.filter((item) => item.type === "SUSPICIOUS_ACTIVITY").length;
  const weightedAverageSafety = totalExposureSeconds > 0 ? weightedSafetyNumerator / totalExposureSeconds : 100;
  const dangerousMinutes = secondsToMinutes(riskCounts.Dangerous);
  const safetyPenalty =
    blockedEvents * 2 +
    dangerousBlockedEvents * 3 +
    Math.round(dangerousMinutes / 20) +
    dangerousAlerts * 2 +
    suspiciousAlerts;

  const riskData = [
    {
      level: "Safe",
      count: Math.round(secondsToMinutes(riskCounts.Safe)),
      visits: riskVisitCounts.Safe,
      color: "#34C759",
    },
    {
      level: "Suspicious",
      count: Math.round(secondsToMinutes(riskCounts.Suspicious)),
      visits: riskVisitCounts.Suspicious,
      color: "#FF9500",
    },
    {
      level: "Dangerous",
      count: Math.round(secondsToMinutes(riskCounts.Dangerous)),
      visits: riskVisitCounts.Dangerous,
      color: "#FF3B30",
    },
  ];

  const safetyScore = Math.max(0, Math.min(100, Math.round(weightedAverageSafety - safetyPenalty)));

  const totalSeconds = rangeTotalSeconds;
  const categoryWebsiteDetails = Array.from(categoryWebsiteSeconds.values())
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 200)
    .map((item) => ({
      category: item.category,
      url: item.url,
      domain: item.domain,
      minutes: Math.max(1, Math.round(secondsToMinutes(item.seconds))),
      logoUrl: toFaviconUrl(item.domain),
    }));

  const riskWebsiteDetails = Array.from(riskWebsiteSeconds.values())
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 200)
    .map((item) => ({
      level: item.level,
      category: item.category,
      url: item.url,
      domain: item.domain,
      minutes: Math.max(1, Math.round(secondsToMinutes(item.seconds))),
      safetyScore: item.safetyScore,
      logoUrl: toFaviconUrl(item.domain),
    }));

  return res.json({
    childId,
    usageTimeline,
    categoryData,
    riskData,
    safetyScore,
    blockedSites: blockedSitesCount,
    rangeUsageMinutes: Math.round(secondsToMinutes(totalSeconds)),
    todayUsageMinutes: Math.round(secondsToMinutes(todaySeconds)),
    categoryWebsiteDetails,
    riskWebsiteDetails,
  });
});

module.exports = router;
