const express = require("express");
const { randomBytes } = require("crypto");
const prisma = require("../lib/prisma");
const { getSessionFromRequest, unauthorizedJson } = require("../lib/session");
const { sendEmail, canSendEmail } = require("../lib/email");

const router = express.Router();

const ACTION_VERB_REGEX = /\b(block|ban|limit|set|change|update|restrict|хязгаар|блок)\b/i;
const BLOCK_INTENT_REGEX = /\b(block|ban|restrict|blocked|блок)\b/i;
const LIMIT_INTENT_REGEX = /\b(limit|set|change|update|daily|session|weekday|weekend|хязгаар)\b/i;
const WEEKLY_SUMMARY_INTENT_REGEX =
  /\b(weekly|this week|last week|7[- ]?day|7 day|week|долоо хоног)\b.*\b(summary|report|behavior|behaviour|activity|usage|тайлан|хураангуй)\b|\b(summary|report|behavior|behaviour|activity|usage|тайлан|хураангуй)\b.*\b(weekly|this week|last week|7[- ]?day|7 day|week|долоо хоног)\b/i;
const BLOCKED_LIST_INTENT_REGEX =
  /\b(all blocked|blocked list|blocked sites?|blocked domains?|blocked categories?|show blocked|blocked)\b|\b(blocklogdson|blocklogson|blocked)\b/i;

const TABLE_NOT_FOUND_CODE = "P2021";
const AI_EMAIL_ACTION_EXPIRY_HOURS = 24;

const SUPPORTED_ACTION_TYPES = new Set([
  "BLOCK_DOMAIN",
  "BLOCK_CATEGORY",
  "SET_WEEKDAY_LIMIT",
  "SET_WEEKEND_LIMIT",
  "SET_SESSION_LIMIT",
  "SET_CATEGORY_LIMIT",
  "SET_DAILY_LIMIT", // backward compatibility
]);

const AI_EMAIL_ACTION_DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "AiPendingEmailAction" (
    "id" SERIAL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "parentId" INTEGER NOT NULL,
    "selectedChildId" INTEGER,
    "actions" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AiPendingEmailAction_token_key" ON "AiPendingEmailAction"("token")`,
  `CREATE INDEX IF NOT EXISTS "AiPendingEmailAction_parentId_status_idx" ON "AiPendingEmailAction"("parentId", "status")`,
  `CREATE INDEX IF NOT EXISTS "AiPendingEmailAction_expiresAt_idx" ON "AiPendingEmailAction"("expiresAt")`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiPendingEmailAction_parentId_fkey') THEN
      ALTER TABLE "AiPendingEmailAction"
      ADD CONSTRAINT "AiPendingEmailAction_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
];

const isPrismaTableMissingError = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === TABLE_NOT_FOUND_CODE;

const ensureAiEmailActionTable = async () => {
  for (const statement of AI_EMAIL_ACTION_DDL_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
};

const toSafeDomain = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

const toSafeMinutes = (value, fallbackMinutes) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackMinutes;
  return Math.max(1, Math.round(numeric));
};

const toMinutesFromSeconds = (seconds) => {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric / 60);
};

const parseModelResponse = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.reply !== "string") return null;
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return { reply: parsed.reply, actions };
  } catch {
    return null;
  }
};

const callGemini = async (prompt) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          responseMimeType: "application/json",
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
};

const normalizeActions = (actions) => {
  const list = Array.isArray(actions) ? actions : [];
  const normalized = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").trim().toUpperCase();
    if (!SUPPORTED_ACTION_TYPES.has(type)) continue;

    if (type === "SET_DAILY_LIMIT") {
      normalized.push({
        type: "SET_WEEKDAY_LIMIT",
        childId: item.childId,
        childName: item.childName,
        minutes: item.minutes,
      });
      normalized.push({
        type: "SET_WEEKEND_LIMIT",
        childId: item.childId,
        childName: item.childName,
        minutes: item.minutes,
      });
      continue;
    }

    normalized.push({
      type,
      childId: item.childId,
      childName: item.childName,
      domain: item.domain,
      categoryName: item.categoryName,
      minutes: item.minutes,
    });
  }

  return normalized;
};

const parseStoredActions = (value) => {
  if (Array.isArray(value)) return normalizeActions(value);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return normalizeActions(parsed);
    } catch {
      return [];
    }
  }
  return [];
};

const formatMinutesCompact = (minutes) => {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours > 0 && rest > 0) return `${hours}h ${rest}m`;
  if (hours > 0) return `${hours}h`;
  return `${rest}m`;
};

const buildAssistantContext = async (parentId, selectedChildId) => {
  const children = await prisma.child.findMany({
    where: { parentId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const childIds = children.map((child) => child.id);
  if (childIds.length === 0) {
    return {
      children,
      targetChildIds: [],
      childInsights: [],
      summaryText: "No children profiles found yet.",
    };
  }

  const targetChildIds =
    selectedChildId && childIds.includes(selectedChildId)
      ? [selectedChildId]
      : childIds;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [recentHistory, childTimeLimits, blockedUrlSettings, blockedCategorySettings] =
    await Promise.all([
      prisma.history.findMany({
        where: {
          childId: { in: targetChildIds },
          visitedAt: { gte: sevenDaysAgo },
        },
        orderBy: { visitedAt: "desc" },
        take: 5000,
        select: {
          childId: true,
          domain: true,
          duration: true,
          actionTaken: true,
          visitedAt: true,
        },
      }),
      prisma.childTimeLimit.findMany({
        where: { childId: { in: targetChildIds } },
        select: {
          childId: true,
          dailyLimit: true,
          weekdayLimit: true,
          weekendLimit: true,
          sessionLimit: true,
        },
      }),
      prisma.childUrlSetting.findMany({
        where: {
          childId: { in: targetChildIds },
          status: "BLOCKED",
        },
        select: {
          childId: true,
          urlId: true,
          timeLimit: true,
        },
      }),
      prisma.childCategorySetting.findMany({
        where: {
          childId: { in: targetChildIds },
          status: "BLOCKED",
        },
        select: {
          childId: true,
          categoryId: true,
          timeLimit: true,
        },
      }),
    ]);

  const urlIds = blockedUrlSettings.map((item) => item.urlId);
  const categoryIds = blockedCategorySettings.map((item) => item.categoryId);

  const [urlCatalog, categoryCatalog] = await Promise.all([
    urlIds.length
      ? prisma.urlCatalog.findMany({
          where: { id: { in: urlIds } },
          select: { id: true, domain: true },
        })
      : [],
    categoryIds.length
      ? prisma.categoryCatalog.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const urlDomainById = new Map(urlCatalog.map((item) => [item.id, item.domain]));
  const categoryNameById = new Map(categoryCatalog.map((item) => [item.id, item.name]));
  const timeLimitByChild = new Map(childTimeLimits.map((item) => [item.childId, item]));

  const usageSecondsByChild = new Map();
  const blockedEventsByChild = new Map();
  const topDomainsByChild = new Map();

  for (const row of recentHistory) {
    const childUsageSeconds = (usageSecondsByChild.get(row.childId) ?? 0) + Number(row.duration ?? 0);
    usageSecondsByChild.set(row.childId, childUsageSeconds);

    if (row.actionTaken === "BLOCKED") {
      blockedEventsByChild.set(row.childId, (blockedEventsByChild.get(row.childId) ?? 0) + 1);
    }

    if (row.domain) {
      const domainMap = topDomainsByChild.get(row.childId) ?? new Map();
      domainMap.set(row.domain, (domainMap.get(row.domain) ?? 0) + Number(row.duration ?? 0));
      topDomainsByChild.set(row.childId, domainMap);
    }
  }

  const blockedSitesByChild = new Map();
  for (const setting of blockedUrlSettings) {
    const domain = urlDomainById.get(setting.urlId);
    if (!domain) continue;
    const list = blockedSitesByChild.get(setting.childId) ?? [];
    list.push(domain);
    blockedSitesByChild.set(setting.childId, list);
  }

  const blockedCategoriesByChild = new Map();
  for (const setting of blockedCategorySettings) {
    const name = categoryNameById.get(setting.categoryId);
    if (!name) continue;
    const list = blockedCategoriesByChild.get(setting.childId) ?? [];
    list.push(name);
    blockedCategoriesByChild.set(setting.childId, list);
  }

  const childInsights = children
    .filter((child) => targetChildIds.includes(child.id))
    .map((child) => {
      const usageSeconds = usageSecondsByChild.get(child.id) ?? 0;
      const usageMinutes = toMinutesFromSeconds(usageSeconds);
      const blockedEvents = blockedEventsByChild.get(child.id) ?? 0;
      const limits = timeLimitByChild.get(child.id);

      const topDomainsMap = topDomainsByChild.get(child.id) ?? new Map();
      const topDomains = [...topDomainsMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([domain, seconds]) => ({
          domain,
          minutes: toMinutesFromSeconds(seconds),
        }));

      const blockedSites = [...new Set(blockedSitesByChild.get(child.id) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      );
      const blockedCategories = [...new Set(blockedCategoriesByChild.get(child.id) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      );

      return {
        childId: child.id,
        childName: child.name,
        usageSeconds,
        usageMinutes,
        blockedEvents,
        limits: {
          weekdayLimit: toSafeMinutes(limits?.weekdayLimit, 180),
          weekendLimit: toSafeMinutes(limits?.weekendLimit, 300),
          sessionLimit: toSafeMinutes(limits?.sessionLimit, 60),
          dailyLimit: toSafeMinutes(limits?.dailyLimit, 240),
        },
        topDomains,
        blockedSites,
        blockedCategories,
      };
    });

  const summaryLines = childInsights.map((item) => {
    const top = item.topDomains.length
      ? item.topDomains.slice(0, 4).map((d) => `${d.domain} (${d.minutes}m)`).join(", ")
      : "none";

    return [
      `${item.childName} (id:${item.childId})`,
      `- Weekly usage: ${item.usageMinutes} minutes`,
      `- Blocked events (7d): ${item.blockedEvents}`,
      `- Limits: weekday ${item.limits.weekdayLimit}m, weekend ${item.limits.weekendLimit}m, session ${item.limits.sessionLimit}m`,
      `- Top domains: ${top}`,
      `- Blocked sites: ${item.blockedSites.length}`,
      `- Blocked categories: ${item.blockedCategories.length}`,
    ].join("\n");
  });

  return {
    children,
    targetChildIds,
    childInsights,
    summaryText: summaryLines.join("\n\n") || "No usage data for the last 7 days.",
  };
};

const resolveChildId = (action, children, selectedChildId) => {
  if (typeof action.childId === "number") {
    const found = children.find((child) => child.id === action.childId);
    if (found) return found.id;
  }
  if (action.childName) {
    const target = String(action.childName).trim().toLowerCase();
    const found = children.find((child) => child.name.trim().toLowerCase() === target);
    if (found) return found.id;
  }
  if (selectedChildId && children.some((child) => child.id === selectedChildId)) {
    return selectedChildId;
  }
  return null;
};

const resolveChildIdFromMessage = (message, children, selectedChildId) => {
  const lower = String(message ?? "").toLowerCase();
  const nameMatch = children.find((child) => lower.includes(child.name.toLowerCase()));
  if (nameMatch) return nameMatch.id;
  if (selectedChildId && children.some((child) => child.id === selectedChildId)) {
    return selectedChildId;
  }
  if (children.length === 1) return children[0].id;
  return null;
};

const describeAction = (action, children, selectedChildId) => {
  const childId = resolveChildId(action, children, selectedChildId);
  const childName = childId ? children.find((item) => item.id === childId)?.name ?? `child ${childId}` : "selected child";

  if (action.type === "BLOCK_DOMAIN") return `Block domain ${action.domain ?? "unknown"} for ${childName}`;
  if (action.type === "BLOCK_CATEGORY") return `Block category ${action.categoryName ?? "unknown"} for ${childName}`;
  if (action.type === "SET_WEEKDAY_LIMIT") return `Set weekday limit to ${Math.round(Number(action.minutes) || 0)}m for ${childName}`;
  if (action.type === "SET_WEEKEND_LIMIT") return `Set weekend limit to ${Math.round(Number(action.minutes) || 0)}m for ${childName}`;
  if (action.type === "SET_CATEGORY_LIMIT") {
    return `Set category ${action.categoryName ?? "unknown"} limit to ${Math.round(Number(action.minutes) || 0)}m for ${childName}`;
  }
  return `Set session limit to ${Math.round(Number(action.minutes) || 0)}m for ${childName}`;
};

const extractCategoryName = (message) => {
  const text = String(message ?? "").trim();
  const quoted = text.match(/["'“”]([^"'“”]{2,60})["'“”]/);
  if (quoted?.[1]) return quoted[1].trim();

  const categoryMatch = text.match(/(?:category|ангилал)\s*(?:for|to|:)?\s*([a-zA-Z][a-zA-Z\s-]{1,40})/i);
  if (categoryMatch?.[1]) return categoryMatch[1].trim();

  return null;
};

const maybeDeterministicReply = (message, context, selectedChildId) => {
  const text = String(message ?? "").trim();
  if (!text) return null;

  const childId = resolveChildIdFromMessage(text, context.children, selectedChildId);

  if (WEEKLY_SUMMARY_INTENT_REGEX.test(text)) {
    if (!childId) {
      return {
        reply: `Here is the weekly behavior summary (last 7 days):\n\n${context.summaryText}`,
        actions: [],
      };
    }

    const childInsight = context.childInsights.find((item) => item.childId === childId);
    if (!childInsight) {
      return {
        reply: "I couldn't find weekly usage data for that child in the last 7 days.",
        actions: [],
      };
    }

    const domains = childInsight.topDomains.length
      ? childInsight.topDomains.map((item) => `${item.domain} (${item.minutes}m)`).join(", ")
      : "none";

    return {
      reply: [
        `${childInsight.childName} weekly summary (last 7 days):`,
        `- Usage: ${childInsight.usageMinutes} minutes`,
        `- Blocked events: ${childInsight.blockedEvents}`,
        `- Limits: weekday ${childInsight.limits.weekdayLimit}m, weekend ${childInsight.limits.weekendLimit}m, session ${childInsight.limits.sessionLimit}m`,
        `- Top domains: ${domains}`,
      ].join("\n"),
      actions: [],
    };
  }

  if (BLOCKED_LIST_INTENT_REGEX.test(text)) {
    if (!childId) {
      const perChild = context.childInsights.map((item) => {
        const blockedSites = item.blockedSites.length ? item.blockedSites.join(", ") : "none";
        const blockedCategories = item.blockedCategories.length ? item.blockedCategories.join(", ") : "none";
        return [
          `${item.childName}:`,
          `- Blocked sites: ${blockedSites}`,
          `- Blocked categories: ${blockedCategories}`,
        ].join("\n");
      });

      return {
        reply: `Current blocked sites and categories:\n\n${perChild.join("\n\n") || "No blocked settings found."}`,
        actions: [],
      };
    }

    const childInsight = context.childInsights.find((item) => item.childId === childId);
    if (!childInsight) {
      return {
        reply: "I couldn't find blocked settings for that child.",
        actions: [],
      };
    }

    const blockedSites = childInsight.blockedSites.length
      ? childInsight.blockedSites.join(", ")
      : "none";
    const blockedCategories = childInsight.blockedCategories.length
      ? childInsight.blockedCategories.join(", ")
      : "none";

    return {
      reply: [
        `${childInsight.childName} blocked settings:`,
        `- Blocked sites: ${blockedSites}`,
        `- Blocked categories: ${blockedCategories}`,
      ].join("\n"),
      actions: [],
    };
  }

  return null;
};

const fallbackAssistant = (message, summaryText) => {
  const text = String(message ?? "").toLowerCase();
  const numeric = text.match(/(\d{1,4})\s*(min|minute|minutes|m)\b/i);
  const minutes = numeric ? Number(numeric[1]) : null;
  const domainMatch = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  const summaryIntentRegex =
    /\b(summary|activity|activities|usage|report|reports|safety|risk|internet|online|dashboard|weekly|week)\b/i;
  const casualChatRegex =
    /\b(hello|hi|hey|how are you|joke|story|explain|translate|movie|music|travel|code|help|what is|who is)\b/i;

  const isWeekdayRequest = /\b(weekday|weekdays|school day|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday)\b/i.test(text);
  const isWeekendRequest = /\b(weekend|weekends|sat|saturday|sun|sunday)\b/i.test(text);
  const isDailyRequest = /\b(daily|per day|өдөр|өдрийн)\b/i.test(text);
  const isSessionRequest = /\b(session|one session|нэг удаа)\b/i.test(text);
  const isCategoryLimitRequest =
    /\b(category|ангилал)\b/i.test(text) && /\b(limit|set|хязгаар)\b/i.test(text);

  if (BLOCK_INTENT_REGEX.test(text) && domainMatch) {
    return {
      reply: `I can block ${domainMatch[0]}. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "BLOCK_DOMAIN", domain: domainMatch[0] }],
    };
  }

  if (isCategoryLimitRequest && minutes) {
    const categoryName = extractCategoryName(message);
    if (categoryName) {
      return {
        reply: `I can set ${categoryName} category limit to ${minutes} minutes. Please confirm and I will apply it.`,
        actions: [{ type: "SET_CATEGORY_LIMIT", categoryName, minutes }],
      };
    }
  }

  if (LIMIT_INTENT_REGEX.test(text) && minutes && isWeekdayRequest) {
    return {
      reply: `I can set weekday limit to ${minutes} minutes. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "SET_WEEKDAY_LIMIT", minutes }],
    };
  }

  if (LIMIT_INTENT_REGEX.test(text) && minutes && isWeekendRequest) {
    return {
      reply: `I can set weekend limit to ${minutes} minutes. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "SET_WEEKEND_LIMIT", minutes }],
    };
  }

  if (LIMIT_INTENT_REGEX.test(text) && minutes && isSessionRequest) {
    return {
      reply: `I can set session limit to ${minutes} minutes. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "SET_SESSION_LIMIT", minutes }],
    };
  }

  if (LIMIT_INTENT_REGEX.test(text) && minutes && isDailyRequest) {
    return {
      reply: `I can set both weekday and weekend limits to ${minutes} minutes. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [
        { type: "SET_WEEKDAY_LIMIT", minutes },
        { type: "SET_WEEKEND_LIMIT", minutes },
      ],
    };
  }

  if (summaryIntentRegex.test(text)) {
    return {
      reply: `Here is a live summary from your data (last 7 days):\n\n${summaryText}`,
      actions: [],
    };
  }

  if (casualChatRegex.test(text)) {
    return {
      reply:
        "Absolutely. I can chat about general topics too. Ask me anything, and if you want parental-control changes, I can apply them with confirmation.",
      actions: [],
    };
  }

  return {
    reply:
      "I can help with general chat and parental controls. Ask for a weekly summary, blocked lists, or changes like weekday/weekend/session/category limits.",
    actions: [],
  };
};

const upsertChildTimeLimitField = async ({ childId, patch }) => {
  const existing = await prisma.childTimeLimit.findUnique({ where: { childId } });
  const base = {
    dailyLimit: toSafeMinutes(existing?.dailyLimit, 240),
    weekdayLimit: toSafeMinutes(existing?.weekdayLimit, 180),
    weekendLimit: toSafeMinutes(existing?.weekendLimit, 300),
    sessionLimit: toSafeMinutes(existing?.sessionLimit, 60),
    breakEvery: toSafeMinutes(existing?.breakEvery, 45),
    breakDuration: toSafeMinutes(existing?.breakDuration, 10),
    focusMode: existing?.focusMode ?? false,
    downtimeEnabled: existing?.downtimeEnabled ?? true,
  };

  const merged = {
    ...base,
    ...patch,
  };

  merged.dailyLimit = Math.max(1, Math.round(Math.max(merged.dailyLimit, merged.weekdayLimit, merged.weekendLimit)));

  await prisma.childTimeLimit.upsert({
    where: { childId },
    update: {
      dailyLimit: merged.dailyLimit,
      weekdayLimit: merged.weekdayLimit,
      weekendLimit: merged.weekendLimit,
      sessionLimit: merged.sessionLimit,
      breakEvery: merged.breakEvery,
      breakDuration: merged.breakDuration,
      focusMode: merged.focusMode,
      downtimeEnabled: merged.downtimeEnabled,
    },
    create: {
      childId,
      dailyLimit: merged.dailyLimit,
      weekdayLimit: merged.weekdayLimit,
      weekendLimit: merged.weekendLimit,
      sessionLimit: merged.sessionLimit,
      breakEvery: merged.breakEvery,
      breakDuration: merged.breakDuration,
      focusMode: merged.focusMode,
      downtimeEnabled: merged.downtimeEnabled,
    },
  });
};

const executeActions = async (actions, children, selectedChildId) => {
  const executed = [];
  const errors = [];
  const normalizedActions = normalizeActions(actions);

  for (const action of normalizedActions) {
    const childId = resolveChildId(action, children, selectedChildId);
    if (!childId) {
      errors.push(`Could not resolve target child for ${action.type}.`);
      continue;
    }

    if (action.type === "BLOCK_DOMAIN") {
      const rawDomain = action.domain ? toSafeDomain(action.domain) : "";
      if (!rawDomain) {
        errors.push("Missing or invalid domain for block action.");
        continue;
      }

      const url = await prisma.urlCatalog.upsert({
        where: { domain: rawDomain },
        update: {},
        create: {
          domain: rawDomain,
          categoryName: "Custom",
          safetyScore: 100,
          tags: ["ai-action"],
          updatedAt: new Date(),
        },
      });

      await prisma.childUrlSetting.upsert({
        where: { childId_urlId: { childId, urlId: url.id } },
        update: { status: "BLOCKED", timeLimit: -1 },
        create: { childId, urlId: url.id, status: "BLOCKED", timeLimit: -1 },
      });

      const child = children.find((item) => item.id === childId);
      executed.push(`Blocked ${rawDomain} for ${child?.name ?? `child ${childId}`}.`);
      continue;
    }

    if (action.type === "BLOCK_CATEGORY") {
      const name = String(action.categoryName ?? "").trim();
      if (!name) {
        errors.push("Missing category name for block-category action.");
        continue;
      }

      const category = await prisma.categoryCatalog.upsert({
        where: { name },
        update: {},
        create: { name },
      });

      await prisma.childCategorySetting.upsert({
        where: { childId_categoryId: { childId, categoryId: category.id } },
        update: { status: "BLOCKED", timeLimit: -1 },
        create: { childId, categoryId: category.id, status: "BLOCKED", timeLimit: -1 },
      });

      const child = children.find((item) => item.id === childId);
      executed.push(`Blocked ${name} category for ${child?.name ?? `child ${childId}`}.`);
      continue;
    }

    if (
      action.type === "SET_WEEKDAY_LIMIT" ||
      action.type === "SET_WEEKEND_LIMIT" ||
      action.type === "SET_SESSION_LIMIT"
    ) {
      const minutes = Number(action.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        errors.push(`Invalid minutes for ${action.type}.`);
        continue;
      }

      try {
        if (action.type === "SET_WEEKDAY_LIMIT") {
          await upsertChildTimeLimitField({
            childId,
            patch: { weekdayLimit: Math.round(minutes) },
          });
        }

        if (action.type === "SET_WEEKEND_LIMIT") {
          await upsertChildTimeLimitField({
            childId,
            patch: { weekendLimit: Math.round(minutes) },
          });
        }

        if (action.type === "SET_SESSION_LIMIT") {
          await upsertChildTimeLimitField({
            childId,
            patch: { sessionLimit: Math.round(minutes) },
          });
        }
      } catch (error) {
        if (isPrismaTableMissingError(error)) {
          errors.push(
            "Time-limit table is missing in current database. Run your existing DB migration/push workflow.",
          );
          continue;
        }
        throw error;
      }

      const child = children.find((item) => item.id === childId);
      if (action.type === "SET_WEEKDAY_LIMIT") {
        executed.push(`Set weekday limit to ${Math.round(minutes)}m for ${child?.name ?? `child ${childId}`}.`);
      } else if (action.type === "SET_WEEKEND_LIMIT") {
        executed.push(`Set weekend limit to ${Math.round(minutes)}m for ${child?.name ?? `child ${childId}`}.`);
      } else {
        executed.push(`Set session limit to ${Math.round(minutes)}m for ${child?.name ?? `child ${childId}`}.`);
      }
      continue;
    }

    if (action.type === "SET_CATEGORY_LIMIT") {
      const minutes = Number(action.minutes);
      const name = String(action.categoryName ?? "").trim();
      if (!name) {
        errors.push("Missing category name for set-category-limit action.");
        continue;
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        errors.push("Invalid minutes for SET_CATEGORY_LIMIT.");
        continue;
      }

      const roundedMinutes = Math.round(minutes);
      const category = await prisma.categoryCatalog.upsert({
        where: { name },
        update: {},
        create: { name },
      });

      let categoryLimitPersisted = false;
      try {
        await prisma.childCategoryLimit.upsert({
          where: { childId_name: { childId, name } },
          update: { minutes: roundedMinutes },
          create: { childId, name, minutes: roundedMinutes },
        });
        categoryLimitPersisted = true;
      } catch (error) {
        if (!isPrismaTableMissingError(error)) {
          throw error;
        }
      }

      await prisma.childCategorySetting.upsert({
        where: { childId_categoryId: { childId, categoryId: category.id } },
        update: {
          status: "LIMITED",
          timeLimit: roundedMinutes,
        },
        create: {
          childId,
          categoryId: category.id,
          status: "LIMITED",
          timeLimit: roundedMinutes,
        },
      });

      const child = children.find((item) => item.id === childId);
      if (categoryLimitPersisted) {
        executed.push(`Set ${name} category limit to ${roundedMinutes}m for ${child?.name ?? `child ${childId}`}.`);
      } else {
        executed.push(`Set ${name} category limit to ${roundedMinutes}m for ${child?.name ?? `child ${childId}`} (legacy mode).`);
      }
      continue;
    }
  }

  return { executed, errors };
};

const getPublicBackendBaseUrl = (req) => {
  const fromEnv = process.env.BACKEND_PUBLIC_URL || process.env.PUBLIC_BACKEND_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" && forwardedProto.length > 0
    ? forwardedProto.split(",")[0]
    : req.protocol;

  const forwardedHost = req.headers["x-forwarded-host"];
  const host =
    (typeof forwardedHost === "string" && forwardedHost.length > 0
      ? forwardedHost.split(",")[0]
      : req.get("host")) || "";

  return host ? `${proto || "https"}://${host}` : "";
};

const createPendingEmailAction = async ({ parentId, selectedChildId, actions }) => {
  await ensureAiEmailActionTable();
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + AI_EMAIL_ACTION_EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.$executeRawUnsafe(
    `INSERT INTO "AiPendingEmailAction" (
      "token",
      "parentId",
      "selectedChildId",
      "actions",
      "status",
      "createdAt",
      "updatedAt",
      "expiresAt"
    ) VALUES ($1, $2, $3, CAST($4 AS jsonb), $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $6)`,
    token,
    parentId,
    selectedChildId,
    JSON.stringify(actions),
    "PENDING",
    expiresAt,
  );

  return { token, expiresAt };
};

const sendPendingActionsEmail = async ({ req, parent, actions, children, selectedChildId }) => {
  if (!parent?.email) {
    return { emailSent: false, reason: "Parent email is missing." };
  }
  if (!canSendEmail()) {
    return { emailSent: false, reason: "SMTP is not configured." };
  }

  try {
    const { token, expiresAt } = await createPendingEmailAction({
      parentId: parent.id,
      selectedChildId,
      actions,
    });

    const baseUrl = getPublicBackendBaseUrl(req);
    if (!baseUrl) {
      return { emailSent: false, reason: "Public backend URL could not be resolved." };
    }

    const approveUrl = `${baseUrl}/api/ai/assistant/email-action?token=${encodeURIComponent(token)}&decision=approve`;
    const rejectUrl = `${baseUrl}/api/ai/assistant/email-action?token=${encodeURIComponent(token)}&decision=reject`;
    const actionLines = actions
      .map((action) => `- ${describeAction(action, children, selectedChildId)}`)
      .join("\n");

    const text = [
      `Hello ${parent.name || "Parent"},`,
      "",
      "Safe-kid AI assistant prepared new actions and is waiting for confirmation:",
      actionLines,
      "",
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`,
      "",
      `This request expires at ${expiresAt.toISOString()}.`,
    ].join("\n");

    const emailResult = await sendEmail({
      to: parent.email,
      subject: "Safe-kid action confirmation",
      text,
    });

    return {
      emailSent: Boolean(emailResult.sent),
      reason: emailResult.reason || null,
      expiresAt,
    };
  } catch (error) {
    return {
      emailSent: false,
      reason: error instanceof Error ? error.message : "Failed to create email action request.",
    };
  }
};

const sendActionResultEmail = async ({ parent, executed, errors }) => {
  if (!parent?.email) return { sent: false, reason: "Parent email is missing." };
  if (!executed.length && !errors.length) return { sent: false, reason: "No action result to send." };

  const lines = [
    `Hello ${parent.name || "Parent"},`,
    "",
    "Safe-kid assistant has finished applying your confirmed actions.",
    "",
  ];

  if (executed.length) {
    lines.push("Applied:");
    for (const item of executed) lines.push(`- ${item}`);
    lines.push("");
  }

  if (errors.length) {
    lines.push("Could not apply:");
    for (const item of errors) lines.push(`- ${item}`);
    lines.push("");
  }

  return sendEmail({
    to: parent.email,
    subject: "Safe-kid action results",
    text: lines.join("\n"),
  });
};

const renderHtmlPage = ({ title, lines }) => {
  const safeTitle = String(title ?? "Safe-kid");
  const body = (Array.isArray(lines) ? lines : [])
    .map((line) => `<p style=\"margin: 6px 0;\">${String(line)}</p>`)
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>${safeTitle}</title>
  </head>
  <body style=\"font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #0f172a;\">
    <h2 style=\"margin-top: 0;\">${safeTitle}</h2>
    ${body}
  </body>
</html>`;
};

router.get("/email-action", async (req, res) => {
  try {
    const token = String(req.query?.token ?? "").trim();
    const decision = String(req.query?.decision ?? "").trim().toLowerCase();

    if (!token || !["approve", "reject"].includes(decision)) {
      return res
        .status(400)
        .type("html")
        .send(
          renderHtmlPage({
            title: "Invalid request",
            lines: ["The email action link is invalid."],
          }),
        );
    }

    await ensureAiEmailActionTable();

    const rows = await prisma.$queryRawUnsafe(
      `SELECT
        "id",
        "token",
        "parentId",
        "selectedChildId",
        "actions",
        "status",
        "expiresAt"
      FROM "AiPendingEmailAction"
      WHERE "token" = $1
      LIMIT 1`,
      token,
    );

    const pending = rows[0];
    if (!pending) {
      return res
        .status(404)
        .type("html")
        .send(
          renderHtmlPage({
            title: "Request not found",
            lines: ["This confirmation link does not exist or has already been removed."],
          }),
        );
    }

    if (pending.status !== "PENDING") {
      return res
        .status(200)
        .type("html")
        .send(
          renderHtmlPage({
            title: "Already processed",
            lines: [`This request has already been processed with status: ${pending.status}.`],
          }),
        );
    }

    if (new Date(pending.expiresAt).getTime() < Date.now()) {
      await prisma.$executeRawUnsafe(
        `UPDATE "AiPendingEmailAction"
         SET "status" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        pending.id,
      );

      return res
        .status(410)
        .type("html")
        .send(
          renderHtmlPage({
            title: "Request expired",
            lines: ["This confirmation link has expired."],
          }),
        );
    }

    if (decision === "reject") {
      await prisma.$executeRawUnsafe(
        `UPDATE "AiPendingEmailAction"
         SET "status" = 'REJECTED', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        pending.id,
      );

      return res
        .status(200)
        .type("html")
        .send(
          renderHtmlPage({
            title: "Actions rejected",
            lines: ["No changes were applied.", "You can return to the parent panel anytime."],
          }),
        );
    }

    const actions = parseStoredActions(pending.actions);
    if (actions.length === 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "AiPendingEmailAction"
         SET "status" = 'FAILED', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        pending.id,
      );

      return res
        .status(400)
        .type("html")
        .send(
          renderHtmlPage({
            title: "No valid actions",
            lines: ["The request payload is empty or invalid."],
          }),
        );
    }

    const children = await prisma.child.findMany({
      where: { parentId: Number(pending.parentId) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    const pendingSelectedChildId =
      Number.isInteger(Number(pending.selectedChildId)) && Number(pending.selectedChildId) > 0
        ? Number(pending.selectedChildId)
        : null;

    const { executed, errors } = await executeActions(actions, children, pendingSelectedChildId);
    const status = errors.length && !executed.length ? "FAILED" : "APPLIED";

    await prisma.$executeRawUnsafe(
      `UPDATE "AiPendingEmailAction"
       SET "status" = $1, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $2`,
      status,
      pending.id,
    );

    const parent = await prisma.user.findUnique({
      where: { id: Number(pending.parentId) },
      select: { id: true, email: true, name: true },
    });

    await sendActionResultEmail({ parent, executed, errors });

    const lines = [];
    if (executed.length) {
      lines.push("Applied actions:");
      executed.forEach((item) => lines.push(`• ${item}`));
    }
    if (errors.length) {
      if (lines.length) lines.push("");
      lines.push("Could not apply:");
      errors.forEach((item) => lines.push(`• ${item}`));
    }
    if (!lines.length) {
      lines.push("No changes were applied.");
    }

    return res.status(200).type("html").send(
      renderHtmlPage({
        title: "Actions processed",
        lines,
      }),
    );
  } catch (error) {
    return res.status(500).type("html").send(
      renderHtmlPage({
        title: "Error",
        lines: [error instanceof Error ? error.message : "Failed to process email action."],
      }),
    );
  }
});

router.post("/", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const payload = req.body ?? {};
    const selectedChildId = payload.selectedChildId ? Number(payload.selectedChildId) : null;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const chatHistory = Array.isArray(payload.chatHistory) ? payload.chatHistory.slice(-10) : [];
    const confirmActions = Boolean(payload.confirmActions);
    const actionsToConfirm = Array.isArray(payload.actionsToConfirm) ? payload.actionsToConfirm : [];

    if (!confirmActions && !message) {
      return res.status(400).json({ error: "Message is required." });
    }
    if (confirmActions && actionsToConfirm.length === 0) {
      return res.status(400).json({ error: "No actions provided for confirmation." });
    }

    const parent = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true },
    });

    const context = await buildAssistantContext(session.userId, selectedChildId);
    if (context.children.length === 0) {
      return res.json({
        reply: "I couldn't find any children for this account yet. Add a child profile first.",
        actionsApplied: [],
        actionErrors: [],
        requiresConfirmation: false,
        pendingActions: [],
      });
    }

    let assistantResult = null;
    if (!confirmActions) {
      const deterministic = maybeDeterministicReply(message, context, selectedChildId);
      if (deterministic) {
        assistantResult = deterministic;
      }

      if (!assistantResult) {
        const childDescriptor = context.children.map((child) => `${child.name} (id:${child.id})`).join(", ");
        const prompt = `You are a general-purpose AI assistant with optional parental-control tools.
Return strict JSON only, format:
{
  "reply": "string",
  "actions": [
    {
      "type": "BLOCK_DOMAIN|BLOCK_CATEGORY|SET_WEEKDAY_LIMIT|SET_WEEKEND_LIMIT|SET_SESSION_LIMIT|SET_CATEGORY_LIMIT",
      "childId": number optional,
      "childName": string optional,
      "domain": "example.com" optional,
      "categoryName": "Games" optional,
      "minutes": number optional
    }
  ]
}

Rules:
- Reply in the same language as the user's latest message.
- Use actions only when the user explicitly asks to change settings.
- If user asks analysis/report only, return empty actions.
- Do not invent children not in this list: ${childDescriptor}.
- Domain must be plain hostname only.
- For category limit actions, always include categoryName and minutes.
- Do NOT use SET_DAILY_LIMIT. If user asks "daily limit", convert to both SET_WEEKDAY_LIMIT and SET_WEEKEND_LIMIT with same minutes.
- Keep reply concise and actionable.

Current account weekly summary (last 7 days):
${context.summaryText}

Recent chat:
${chatHistory.map((item) => `${item.sender}: ${item.text}`).join("\n")}

User message:
${message}`;

        try {
          const raw = await callGemini(prompt);
          if (raw) {
            assistantResult = parseModelResponse(raw);
          }
        } catch {
          assistantResult = null;
        }

        if (!assistantResult) {
          assistantResult = fallbackAssistant(message, context.summaryText);
        }
      }
    }

    const candidateActions = normalizeActions(
      confirmActions ? actionsToConfirm : (assistantResult?.actions ?? []),
    );

    if (confirmActions && candidateActions.length === 0) {
      return res.status(400).json({ error: "No valid actions provided for confirmation." });
    }

    if (!confirmActions && candidateActions.length > 0) {
      const pendingEmailResult = await sendPendingActionsEmail({
        req,
        parent,
        actions: candidateActions,
        children: context.children,
        selectedChildId,
      });

      const emailHint = pendingEmailResult.emailSent
        ? "\n\nI also sent approve/reject links to your registered email."
        : "";

      return res.json({
        reply: `${assistantResult?.reply ?? "I found actions to apply."}\n\nPlease confirm before I apply these changes.${emailHint}`,
        actionsApplied: [],
        actionErrors: [],
        requiresConfirmation: true,
        pendingActions: candidateActions,
      });
    }

    const { executed, errors } = confirmActions
      ? await executeActions(candidateActions, context.children, selectedChildId)
      : { executed: [], errors: [] };

    if (confirmActions) {
      await sendActionResultEmail({ parent, executed, errors });
    }

    const actionAppendix =
      executed.length || errors.length
        ? `\n\n${[...executed, ...errors.map((item) => `Could not apply: ${item}`)].join("\n")}`
        : "";

    return res.json({
      reply: `${assistantResult?.reply ?? "Done."}${actionAppendix}`,
      actionsApplied: executed,
      actionErrors: errors,
      requiresConfirmation: false,
      pendingActions: [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI request failed.";
    return res.status(500).json({ error: message });
  }
});

module.exports = router;
