const express = require("express");
const prisma = require("../lib/prisma");
const { getSessionFromRequest, unauthorizedJson } = require("../lib/session");

const router = express.Router();

const ACTION_VERB_REGEX = /\b(block|ban|limit|set|change|update|restrict)\b/i;
const BLOCK_INTENT_REGEX = /\b(block|ban|restrict)\b/i;
const LIMIT_INTENT_REGEX = /\b(limit|set|change|update|daily|session)\b/i;
const TABLE_NOT_FOUND_CODE = "P2021";

const isPrismaTableMissingError = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === TABLE_NOT_FOUND_CODE;

const toSafeDomain = (value) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

const toSafeMinutes = (value, fallbackMinutes) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallbackMinutes;
  return Math.max(1, Math.round(numeric));
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

const buildQuickSummary = async (parentId, selectedChildId) => {
  const children = await prisma.child.findMany({
    where: { parentId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const childIds = children.map((child) => child.id);
  if (childIds.length === 0) {
    return {
      children,
      summary: "No children profiles found yet.",
    };
  }

  const recentHistory = await prisma.history.findMany({
    where: {
      childId: selectedChildId && childIds.includes(selectedChildId) ? selectedChildId : { in: childIds },
    },
    orderBy: { visitedAt: "desc" },
    take: 60,
    select: {
      childId: true,
      domain: true,
      categoryName: true,
      duration: true,
      actionTaken: true,
      visitedAt: true,
    },
  });

  let childTimeLimits = [];
  try {
    childTimeLimits = await prisma.childTimeLimit.findMany({
      where: { childId: { in: childIds } },
      select: { childId: true, dailyLimit: true, sessionLimit: true },
    });
  } catch (error) {
    if (!isPrismaTableMissingError(error)) {
      throw error;
    }
  }

  const usageByChild = new Map();
  const blockedByChild = new Map();

  for (const row of recentHistory) {
    usageByChild.set(row.childId, (usageByChild.get(row.childId) ?? 0) + Number(row.duration ?? 0));
    if (row.actionTaken === "BLOCKED") {
      blockedByChild.set(row.childId, (blockedByChild.get(row.childId) ?? 0) + 1);
    }
  }

  const limitByChild = new Map(childTimeLimits.map((item) => [item.childId, item]));
  const summaryLines = children.map((child) => {
    const usageMinutes = usageByChild.get(child.id) ?? 0;
    const blocked = blockedByChild.get(child.id) ?? 0;
    const limits = limitByChild.get(child.id);
    const dailyMinutes = toSafeMinutes(limits?.dailyLimit, 240);
    const sessionMinutes = toSafeMinutes(limits?.sessionLimit, 60);
    const daily = Math.round(dailyMinutes);
    const session = Math.round(sessionMinutes);
    return `${child.name} (id:${child.id}): recent usage ${usageMinutes}m, blocked events ${blocked}, daily limit ${daily}m, session limit ${session}m`;
  });

  const topDomains = recentHistory
    .reduce((map, item) => {
      if (!item.domain) return map;
      map.set(item.domain, (map.get(item.domain) ?? 0) + Number(item.duration ?? 0));
      return map;
    }, new Map())
    .entries();

  const domainList = [...topDomains]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, minutes]) => `${domain} (${minutes}m)`)
    .join(", ");

  return {
    children,
    summary: `${summaryLines.join("\n")}
Top domains: ${domainList || "none"}`,
  };
};

const fallbackAssistant = (message, summary) => {
  const text = message.toLowerCase();
  const numeric = text.match(/(\d{2,3})\s*(min|minute|minutes|m)\b/i);
  const domainMatch = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  const summaryIntentRegex =
    /\b(summary|activity|activities|usage|report|reports|safety|risk|internet|online|dashboard)\b/i;
  const casualChatRegex =
    /\b(hello|hi|hey|how are you|joke|story|explain|translate|movie|music|travel|code|help|what is|who is)\b/i;

  if (BLOCK_INTENT_REGEX.test(text) && domainMatch) {
    return {
      reply: `I can block ${domainMatch[0]}. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "BLOCK_DOMAIN", domain: domainMatch[0] }],
    };
  }

  if (LIMIT_INTENT_REGEX.test(text) && /daily/i.test(text) && numeric) {
    return {
      reply: `I can set daily limit to ${numeric[1]} minutes. Please confirm and I will apply it to the selected child (or specify child name).`,
      actions: [{ type: "SET_DAILY_LIMIT", minutes: Number(numeric[1]) }],
    };
  }

  if (summaryIntentRegex.test(text)) {
    return {
      reply: `Here is a live summary from your data:
${summary}`,
      actions: [],
    };
  }

  if (casualChatRegex.test(text)) {
    return {
      reply:
        "Absolutely. I can chat about general topics too. Ask me anything, and if you want parental-control changes, I can do those with confirmation.",
      actions: [],
    };
  }

  return {
    reply:
      "I can help with both general chat and parental controls. Ask me any question, or request actions like blocking a domain or changing daily/session limits.",
    actions: [],
  };
};

const resolveChildId = (action, children, selectedChildId) => {
  if (typeof action.childId === "number") {
    const found = children.find((child) => child.id === action.childId);
    if (found) return found.id;
  }
  if (action.childName) {
    const target = action.childName.trim().toLowerCase();
    const found = children.find((child) => child.name.trim().toLowerCase() === target);
    if (found) return found.id;
  }
  if (selectedChildId && children.some((child) => child.id === selectedChildId)) {
    return selectedChildId;
  }
  return null;
};

const executeActions = async (actions, children, selectedChildId) => {
  const executed = [];
  const errors = [];

  for (const action of actions) {
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
      const name = action.categoryName?.trim();
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

    if (action.type === "SET_DAILY_LIMIT" || action.type === "SET_SESSION_LIMIT") {
      const minutes = Number(action.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        errors.push(`Invalid minutes for ${action.type}.`);
        continue;
      }

      try {
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

        await prisma.childTimeLimit.upsert({
          where: { childId },
          update:
            action.type === "SET_DAILY_LIMIT"
              ? { dailyLimit: Math.round(minutes) }
              : { sessionLimit: Math.round(minutes) },
          create:
            action.type === "SET_DAILY_LIMIT"
              ? { childId, ...base, dailyLimit: Math.round(minutes) }
              : { childId, ...base, sessionLimit: Math.round(minutes) },
        });
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
      if (action.type === "SET_DAILY_LIMIT") {
        executed.push(`Set daily limit to ${Math.round(minutes)}m for ${child?.name ?? `child ${childId}`}.`);
      } else {
        executed.push(`Set session limit to ${Math.round(minutes)}m for ${child?.name ?? `child ${childId}`}.`);
      }
    }
  }

  return { executed, errors };
};

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

    const { children, summary } = await buildQuickSummary(session.userId, selectedChildId);
    if (children.length === 0) {
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
      const childDescriptor = children.map((child) => `${child.name} (id:${child.id})`).join(", ");
      const prompt = `You are a general-purpose AI assistant with optional parental-control tools.
Return strict JSON only, format:
{
  "reply": "string",
  "actions": [
    {
      "type": "BLOCK_DOMAIN|BLOCK_CATEGORY|SET_DAILY_LIMIT|SET_SESSION_LIMIT",
      "childId": number optional,
      "childName": string optional,
      "domain": "example.com" optional,
      "categoryName": "Games" optional,
      "minutes": number optional
    }
  ]
}

Rules:
- You can freely chat on any topic. Do not limit yourself to parental-control-only responses.
- Understand and reply in the same language as the user's latest message.
- Use actions only when user explicitly asks to change dashboard settings for child safety controls.
- If user asks only analysis/general chat, return empty actions array.
- Do not invent children not in this list: ${childDescriptor}.
- Domain must be plain hostname only.
- Keep reply concise and actionable.

Current account summary:
${summary}

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
        assistantResult = fallbackAssistant(message, summary);
      }
    }

    const candidateActions = confirmActions ? actionsToConfirm : (assistantResult?.actions ?? []);
    const allowActions = confirmActions || ACTION_VERB_REGEX.test(message);

    if (!confirmActions && allowActions && candidateActions.length > 0) {
      return res.json({
        reply: `${assistantResult?.reply ?? "I found actions to apply."}

Please confirm before I apply these changes.`,
        actionsApplied: [],
        actionErrors: [],
        requiresConfirmation: true,
        pendingActions: candidateActions,
      });
    }

    const { executed, errors } = confirmActions
      ? await executeActions(candidateActions, children, selectedChildId)
      : { executed: [], errors: [] };

    const actionAppendix =
      executed.length || errors.length
        ? `

${[...executed, ...errors.map((item) => `Could not apply: ${item}`)].join("\n")}`
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
