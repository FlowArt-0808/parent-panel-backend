const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { classifyWebsite } = require("../lib/ai");
const {
  checkTimeLimit,
  checkGlobalDailyLimit,
  checkBedtimeSchedule,
} = require("../lib/timeUtils");

// POST: /api/check-url
router.post("/", async (req, res, next) => {
  try {
    const { childId, url, dryRun } = req.body;
    const isDryRun = Boolean(dryRun);

    if (!childId || !url) {
      return res.status(400).json({
        action: "ALLOWED",
        reason: "INVALID_INPUT",
        source: "SYSTEM",
        error: "Missing data",
      });
    }

    // 1. Parse URL
    let domain;
    try {
      const urlObj = new URL(url);
      domain = urlObj.hostname.replace(/^www\./, "");
    } catch {
      // Allow invalid/non-http schemes such as chrome://
      return res.json({ action: "ALLOWED", reason: "NON_HTTP_URL", source: "SYSTEM" });
    }

    const bedtimeStatus = await checkBedtimeSchedule(Number(childId));
    if (bedtimeStatus.isBlocked) {
      if (!isDryRun) {
        prisma.history
          .create({
            data: {
              childId: Number(childId),
              fullUrl: url,
              domain,
              categoryName: "Bedtime",
              actionTaken: "BLOCKED",
              duration: 0,
            },
          })
          .catch((err) => console.error("History Save Error:", err));
      }

      return res.json({
        action: "BLOCK",
        reason: "BEDTIME_ACTIVE",
        source: "SYSTEM",
        domain,
      });
    }

    // 2. Find or classify domain
    let catalogEntry = await prisma.urlCatalog.findUnique({
      where: { domain },
    });

    if (!catalogEntry) {
      console.log(`[AI] Gemini analyzing: ${domain}`);
      const aiResult = await classifyWebsite(domain);

      if (aiResult) {
        try {
          let categoryEntry = await prisma.categoryCatalog.findUnique({
            where: { name: aiResult.category },
          });

          if (!categoryEntry) {
            categoryEntry = await prisma.categoryCatalog.create({
              data: { name: aiResult.category },
            });
          }

          catalogEntry = await prisma.urlCatalog.create({
            data: {
              domain,
              categoryName: aiResult.category,
              safetyScore: aiResult.safetyScore,
              tags: [aiResult.category],
            },
          });
          console.log(`[OK] ${domain} -> ${aiResult.category} (${aiResult.safetyScore})`);
        } catch (dbErr) {
          console.error("Catalog Save Error:", dbErr);
          catalogEntry = { categoryName: "Uncategorized", safetyScore: 50 };
        }
      }
    }

    if (!catalogEntry) {
      // Keep unknown domains in catalog so later policy checks stay consistent.
      catalogEntry = await prisma.urlCatalog
        .create({
          data: {
            domain,
            categoryName: "Uncategorized",
            safetyScore: 50,
            tags: ["Uncategorized"],
          },
        })
        .catch(() => ({
          id: 0,
          domain,
          categoryName: "Uncategorized",
          safetyScore: 50,
        }));
    }

    // 3. Load child settings
    const categoryInfo = await prisma.categoryCatalog.findUnique({
      where: { name: catalogEntry.categoryName },
    });

    const [urlSetting, categorySetting] = await Promise.all([
      prisma.childUrlSetting.findUnique({
        where: {
          childId_urlId: { childId: Number(childId), urlId: catalogEntry.id },
        },
      }),
      categoryInfo
        ? prisma.childCategorySetting.findUnique({
            where: {
              childId_categoryId: {
                childId: Number(childId),
                categoryId: categoryInfo.id,
              },
            },
          })
        : null,
    ]);

    // 4. Decision engine
    let action = "ALLOWED";
    let blockReason = "NONE";
    let blockSource = "SYSTEM";
    const hasSafetyScore = typeof catalogEntry.safetyScore === "number";
    const isCustomDomain = catalogEntry.categoryName === "Custom";
    const isDangerousScore = hasSafetyScore && catalogEntry.safetyScore < 50;

    // Step 1: AI safety score
    if (isDangerousScore && !isCustomDomain) {
      action = "BLOCK";
      blockReason = "DANGEROUS_CONTENT";
      blockSource = "AI";
    }

    // Step 2: Category policy
    if (categorySetting && categorySetting.status === "BLOCKED") {
      action = "BLOCK";
      blockReason = "CATEGORY_BLOCKED";
      blockSource = categorySetting.timeLimit === -1 ? "AI" : "PARENT";
    }

    // Step 3: URL override policy
    if (urlSetting) {
      if (urlSetting.status === "BLOCKED") {
        action = "BLOCK";
        blockReason = "URL_BLOCKED";
        blockSource = urlSetting.timeLimit === -1 ? "AI" : "PARENT";
      } else if (urlSetting.status === "ALLOWED") {
        action = "ALLOWED";
        blockReason = "PARENT_ALLOWED";
        blockSource = "PARENT";
      }
    }

    // Step 4: Category time limit
    if (action !== "BLOCK" && categoryInfo) {
      const timeStatus = await checkTimeLimit(childId, categoryInfo.id);
      if (timeStatus.isBlocked) {
        action = "BLOCK";
        blockReason = "TIME_LIMIT_EXCEEDED";
        blockSource = "SYSTEM";
      }
    }

    // Step 5: Global daily limit
    const globalDailyStatus = await checkGlobalDailyLimit(Number(childId));
    if (globalDailyStatus.isBlocked) {
      action = "BLOCK";
      blockReason = "DAILY_LIMIT_EXCEEDED";
      blockSource = "SYSTEM";
    }

    // 6. Alert logging for dangerous sites
    if (!isDryRun && action === "BLOCK" && isDangerousScore && !isCustomDomain) {
      await prisma.alert
        .create({
          data: {
            childId: Number(childId),
            type: "DANGEROUS_CONTENT",
            message: `Blocked access to ${catalogEntry.domain}. (${catalogEntry.categoryName})`,
            isSent: false,
          },
        })
        .catch((e) => console.error("Alert error:", e));
    }

    // 7. History logging
    if (!isDryRun) {
      const historyAction = action === "BLOCK" ? "BLOCKED" : "ALLOWED";

      prisma.history
        .create({
          data: {
            childId: Number(childId),
            fullUrl: url,
            domain,
            categoryName: catalogEntry.categoryName,
            actionTaken: historyAction,
            duration: 0,
          },
        })
        .catch((err) => console.error("History Save Error:", err));
    }

    return res.json({
      action,
      reason: blockReason,
      source: blockSource,
      domain,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
