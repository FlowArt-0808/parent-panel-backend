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

const getDayStart = (timeZone, value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? 0);
  const month = Number(parts.find((part) => part.type === "month")?.value ?? 1);
  const day = Number(parts.find((part) => part.type === "day")?.value ?? 1);
  return new Date(Date.UTC(year, month - 1, day));
};

// CREATE child
router.post("/", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const { name, age, gender, pin } = req.body ?? {};
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const parsedAge =
      age === undefined || age === null || age === ""
        ? null
        : Number.parseInt(age, 10);

    if (!trimmedName) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (Number.isNaN(parsedAge)) {
      return res.status(400).json({ error: "Invalid age" });
    }

    const child = await prisma.child.create({
      data: {
        name: trimmedName,
        age: parsedAge ?? undefined,
        gender: gender ?? undefined,
        pin,
        parentId: session.userId,
      },
    });

    return res.json(child);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error creating child";
    return res.status(500).json({ error: message });
  }
});

// READ children of parent
router.get("/", async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return unauthorizedJson(res);
  }

  const timeZone = normalizeTimeZone(req.query?.timeZone);
  const todayKey = getDateKey(new Date(), timeZone);
  const todayStart = getDayStart(timeZone, new Date());

  const children = await prisma.child.findMany({
    where: { parentId: session.userId },
  });

  if (children.length === 0) {
    return res.json([]);
  }

  const childIds = children.map((child) => child.id);
  const todayHistory = await prisma.history.findMany({
    where: {
      childId: { in: childIds },
      visitedAt: { gte: todayStart },
    },
    select: { childId: true, duration: true, visitedAt: true },
  });

  const todaySecondsByChild = new Map();
  for (const row of todayHistory) {
    if (!row.visitedAt) continue;
    const visitedAt = new Date(row.visitedAt);
    if (Number.isNaN(visitedAt.getTime())) continue;
    if (getDateKey(visitedAt, timeZone) !== todayKey) continue;

    const current = todaySecondsByChild.get(row.childId) ?? 0;
    todaySecondsByChild.set(row.childId, current + Math.max(0, Number(row.duration ?? 0)));
  }

  const enriched = children.map((child) => ({
    ...child,
    todayUsageMinutes: Math.round((todaySecondsByChild.get(child.id) ?? 0) / 60),
  }));

  return res.json(enriched);
});

// UPDATE child
router.put("/", async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return unauthorizedJson(res);
  }

  const { id, name, age, pin } = req.body ?? {};
  const childId = Number(id);
  if (!Number.isInteger(childId) || childId <= 0) {
    return res.status(400).json({ error: "Invalid child id." });
  }

  const child = await prisma.child.findUnique({
    where: { id: childId },
    select: { id: true, parentId: true },
  });
  if (!child || child.parentId !== session.userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const updated = await prisma.child.update({
    where: { id: childId },
    data: { name, age, pin },
  });

  return res.json(updated);
});

// DELETE child
router.delete("/", async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return unauthorizedJson(res);
  }

  const { id } = req.body ?? {};
  const childId = Number(id);
  if (!Number.isInteger(childId) || childId <= 0) {
    return res.status(400).json({ error: "Invalid child id." });
  }

  const child = await prisma.child.findUnique({
    where: { id: childId },
    select: { id: true, parentId: true },
  });
  if (!child || child.parentId !== session.userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await prisma.child.delete({
    where: { id: childId },
  });

  return res.json({ success: true });
});

module.exports = router;
