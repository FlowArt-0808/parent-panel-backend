const express = require("express");
const prisma = require("../lib/prisma");
const { getSessionFromRequest, unauthorizedJson } = require("../lib/session");
const { filterRestrictedCategories } = require("../lib/categoryFilters");

const router = express.Router();

const requireChild = async (childId, parentId) => {
  const child = await prisma.child.findUnique({
    where: { id: childId },
    select: { id: true, parentId: true },
  });
  if (!child || child.parentId !== parentId) {
    return null;
  }
  return child;
};

const getBlockedSource = (timeLimit) => (timeLimit === -1 ? "AI" : "PARENT");

router.get("/", async (req, res) => {
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

  const [categories, categorySettings, urlSettings] = await Promise.all([
    prisma.categoryCatalog.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.childCategorySetting.findMany({
      where: { childId },
      select: { categoryId: true, status: true, timeLimit: true },
    }),
    prisma.childUrlSetting.findMany({
      where: { childId, status: "BLOCKED" },
      select: { urlId: true, timeLimit: true },
    }),
  ]);

  const urlIds = urlSettings.map((setting) => setting.urlId);
  const urlCatalog = urlIds.length
    ? await prisma.urlCatalog.findMany({
        where: { id: { in: urlIds } },
        select: { id: true, domain: true },
      })
    : [];

  const visibleCategories = filterRestrictedCategories(categories);
  const statusMap = new Map(categorySettings.map((setting) => [setting.categoryId, setting.status]));
  const sourceByCategoryId = new Map(
    categorySettings
      .filter((setting) => setting.status === "BLOCKED")
      .map((setting) => [setting.categoryId, getBlockedSource(setting.timeLimit)]),
  );
  const sourceByUrlId = new Map(urlSettings.map((setting) => [setting.urlId, getBlockedSource(setting.timeLimit)]));

  const categoriesWithStatus = visibleCategories.map((category) => ({
    id: category.id,
    name: category.name,
    status: statusMap.get(category.id) ?? "ALLOWED",
    source: sourceByCategoryId.get(category.id) ?? null,
  }));

  return res.json({
    categories: categoriesWithStatus,
    blockedSites: urlCatalog
      .map((site) => ({
        id: site.id,
        domain: site.domain,
        source: sourceByUrlId.get(site.id) ?? "PARENT",
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
  });
});

router.post("/", async (req, res) => {
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

  if (payload?.categoryId) {
    const categoryId = Number.parseInt(String(payload.categoryId), 10);
    if (Number.isNaN(categoryId)) {
      return res.status(400).json({ error: "Invalid categoryId" });
    }
    const enabled = Boolean(payload.enabled);
    const setting = await prisma.childCategorySetting.upsert({
      where: {
        childId_categoryId: { childId, categoryId },
      },
      update: {
        status: enabled ? "BLOCKED" : "ALLOWED",
        timeLimit: null,
      },
      create: {
        childId,
        categoryId,
        status: enabled ? "BLOCKED" : "ALLOWED",
        timeLimit: null,
      },
    });
    return res.json(setting);
  }

  if (payload?.domain) {
    const rawDomain = String(payload.domain).trim().toLowerCase();
    if (!rawDomain) {
      return res.status(400).json({ error: "Invalid domain" });
    }

    const url = await prisma.urlCatalog.upsert({
      where: { domain: rawDomain },
      update: {},
      create: {
        domain: rawDomain,
        categoryName: "Custom",
        safetyScore: 100,
        tags: ["manual"],
        updatedAt: new Date(),
      },
    });

    const setting = await prisma.childUrlSetting.upsert({
      where: {
        childId_urlId: { childId, urlId: url.id },
      },
      update: {
        status: "BLOCKED",
        timeLimit: null,
      },
      create: {
        childId,
        urlId: url.id,
        status: "BLOCKED",
        timeLimit: null,
      },
    });
    return res.json(setting);
  }

  return res.status(400).json({ error: "Invalid payload" });
});

router.delete("/", async (req, res) => {
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

  const toDomain = (value) =>
    value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  if (payload?.domain) {
    const domain = toDomain(String(payload.domain));
    if (!domain) {
      return res.status(400).json({ error: "Invalid domain" });
    }
    const url = await prisma.urlCatalog.findUnique({
      where: { domain },
      select: { id: true },
    });
    if (!url) {
      return res.json({ success: true, removed: 0 });
    }
    const removed = await prisma.childUrlSetting.deleteMany({
      where: { childId, urlId: url.id },
    });
    return res.json({ success: true, removed: removed.count });
  }

  if (Array.isArray(payload?.domains)) {
    const rawDomains = payload.domains.filter((value) => typeof value === "string");
    const normalized = rawDomains.map((value) => toDomain(value)).filter((value) => value.length > 0);
    const uniqueDomains = [...new Set(normalized)];
    if (uniqueDomains.length === 0) {
      return res.status(400).json({ error: "Invalid domains" });
    }
    const urls = await prisma.urlCatalog.findMany({
      where: { domain: { in: uniqueDomains } },
      select: { id: true },
    });
    const urlIds = urls.map((item) => item.id);
    if (urlIds.length === 0) {
      return res.json({ success: true, removed: 0 });
    }
    const removed = await prisma.childUrlSetting.deleteMany({
      where: { childId, urlId: { in: urlIds } },
    });
    return res.json({ success: true, removed: removed.count });
  }

  return res.status(400).json({ error: "Invalid payload" });
});

module.exports = router;
