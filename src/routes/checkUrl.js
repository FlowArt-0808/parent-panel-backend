const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { adjustSafetyScore, getRuleBasedCategory, getSearchKeywordMatch } = require("../lib/contentRules");
const { classifyWebsite } = require("../lib/ai");
const { checkTimeLimit } = require("../lib/timeUtils"); // Өмнө бичсэн цаг шалгах функц

const SAFETY_BLOCK_THRESHOLD = 60;

// POST: /api/check-url
const ensureCategory = async (name) => {
  let categoryEntry = await prisma.categoryCatalog.findUnique({
    where: { name },
  });
  if (!categoryEntry) {
    categoryEntry = await prisma.categoryCatalog.create({ data: { name } });
  }
  return categoryEntry;
};

router.post("/", async (req, res, next) => {
  try {
    const { childId, url } = req.body;

    if (!childId || !url) {
      return res.status(400).json({ action: "ALLOWED", error: "Missing data" });
    }

    // 1. URL Parse хийх
    let domain;
    let urlObj;
    try {
      urlObj = new URL(url);
      domain = urlObj.hostname.replace(/^www\./, "");
    } catch (e) {
      // Хэрэв URL буруу бол (жишээ нь chrome://) зөвшөөрнө
      return res.json({ action: "ALLOWED" });
    }

    const searchMatch = getSearchKeywordMatch(urlObj, domain);

    // 2. Баазаас (Catalog) хайх
    let catalogEntry = await prisma.urlCatalog.findUnique({
      where: { domain },
    });

    if (searchMatch && !catalogEntry) {
      const searchCategory = await ensureCategory("Search");
      catalogEntry = await prisma.urlCatalog.create({
        data: {
          domain: domain,
          categoryName: searchCategory.name,
          safetyScore: 60,
          tags: ["Search"],
        },
      });
    }

    // --- Rule-based quick classification ---
    if (!catalogEntry) {
      const ruleResult = getRuleBasedCategory(domain);
      if (ruleResult) {
        const categoryEntry = await ensureCategory(ruleResult.category);
        catalogEntry = await prisma.urlCatalog.create({
          data: {
            domain: domain,
            categoryName: categoryEntry.name,
            safetyScore: ruleResult.safetyScore,
            tags: [categoryEntry.name],
          },
        });
      }
    }

    // --- AI ХЭСЭГ ---
    if (!catalogEntry) {
      console.log(`🤖 Gemini шинжилж байна: ${domain}`);
      const aiResult = await classifyWebsite(domain);

      if (aiResult) {
        try {
          // A. Категори нь CategoryCatalog-д байгаа эсэхийг шалгах, байхгүй бол үүсгэх
          const categoryEntry = await ensureCategory(aiResult.category);

          // B. URL Catalog-д хадгалах
          catalogEntry = await prisma.urlCatalog.create({
            data: {
              domain: domain,
              categoryName: categoryEntry.name,
              safetyScore: aiResult.safetyScore,
              tags: [categoryEntry.name],
            },
          });
          console.log(
            `✅ ${domain} -> ${aiResult.category} (${aiResult.safetyScore})`,
          );
        } catch (dbErr) {
          console.error("Catalog Save Error:", dbErr);
          // Алдаа гарсан ч кодыг зогсоохгүйгээр default утгаар үргэлжлүүлнэ
          catalogEntry = { categoryName: "Uncategorized", safetyScore: 50 };
        }
      }
    }

    if (catalogEntry) {
      catalogEntry.safetyScore = adjustSafetyScore(
        domain,
        catalogEntry.categoryName,
        catalogEntry.safetyScore
      );
    }
    // Хэрэв AI болон Баазаас олдоогүй бол
    if (!catalogEntry) {
      return res.json({ action: "ALLOWED" });
    }

    // 3. ТОХИРГОО ШАЛГАХ (Parallel Query)
    const categoryInfo = await prisma.categoryCatalog.findUnique({
      where: { name: catalogEntry.categoryName },
    });

    const [urlSetting, categorySetting] = await Promise.all([
      // A. Тусгай URL тохиргоо
      prisma.childUrlSetting.findUnique({
        where: {
          childId_urlId: { childId: Number(childId), urlId: catalogEntry.id },
        },
      }),
      // B. Категорийн тохиргоо
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

    // 4. ШИЙДВЭР ГАРГАХ (Decision Engine)
    let action = "ALLOWED";
    let blockReason = "NONE";

    if (searchMatch) {
      action = "BLOCK";
      blockReason = "SEARCH_KEYWORD";
    }

    // Шат 1: Аюулгүй байдлын оноо
    if (action !== "BLOCK" && catalogEntry.safetyScore < SAFETY_BLOCK_THRESHOLD) {
      action = "BLOCK";
      blockReason = "DANGEROUS_CONTENT";
    }

    // Шат 2: Категорийн тохиргоо
    if (categorySetting && categorySetting.status === "BLOCKED") {
      action = "BLOCK";
      blockReason = "CATEGORY_BLOCKED";
    }

    // Шат 3: Тусгай URL тохиргоо (Override)
    if (urlSetting) {
      if (urlSetting.status === "BLOCKED") {
        action = "BLOCK";
        blockReason = "PARENT_BLOCKED";
      } else if (urlSetting.status === "ALLOWED" && blockReason !== "SEARCH_KEYWORD") {
        action = "ALLOWED";
        blockReason = "PARENT_ALLOWED";
      }
    }

    // Шат 4: ЦАГИЙН ХЯЗГААР (Time Limit)
    // Хэрэв хараахан блоклогдоогүй бөгөөд категори олдсон бол цагийг шалгана
    if (action !== "BLOCK" && categoryInfo) {
      const timeStatus = await checkTimeLimit(childId, categoryInfo.id);

      if (timeStatus.isBlocked) {
        action = "BLOCK";
        blockReason = timeStatus.reason || "TIME_LIMIT_EXCEEDED";
      }
    }

    // 5. ALERT SYSTEM
    if (action === "BLOCK" && catalogEntry.safetyScore < SAFETY_BLOCK_THRESHOLD) {
      await prisma.alert
        .create({
          data: {
            childId: Number(childId),
            type: "DANGEROUS_CONTENT",
            message: `${catalogEntry.domain} сайт руу нэвтрэхийг хориглолоо. (${catalogEntry.categoryName})`,
            isSent: false,
          },
        })
        .catch((e) => console.error("Alert error:", e));
    }

    // 6. HISTORY LOGGING
    const historyAction = action === "BLOCK" ? "BLOCKED" : "ALLOWED";

    prisma.history
      .create({
        data: {
          childId: Number(childId),
          fullUrl: url,
          domain: domain,
          categoryName: catalogEntry.categoryName,
          actionTaken: historyAction,
          duration: 0, // Зөвхөн хандалт, хугацааг trackTime-д тооцно
        },
      })
      .catch((err) => console.error("History Save Error:", err));

    // 7. Хариу буцаах
    return res.json({
      action,
      reason: blockReason,
      category: catalogEntry?.categoryName ?? null,
      safetyScore: Number.isFinite(catalogEntry?.safetyScore)
        ? catalogEntry.safetyScore
        : null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
