const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// GET: /api/debug/history/:childId
router.get("/history/:childId", async (req, res) => {
  try {
    const { childId } = req.params;

    // 1. Одоогийн цагаас 5 цагийг хасах
    const fiveHoursAgo = new Date();
    fiveHoursAgo.setHours(fiveHoursAgo.getHours() - 5);

    // 2. Баазаас шүүж авах
    const historyData = await prisma.history.findMany({
      where: {
        childId: Number(childId),
        visitedAt: {
          gte: fiveHoursAgo, // 5 цагаас хойшхи
        },
      },
      orderBy: {
        visitedAt: "desc", // Хамгийн сүүлийнх нь дээрээ
      },
    });

    // 3. Дүн шинжилгээ хийхэд хялбар болгох үүднээс товч мэдээлэл нэмэх
    const summary = {
      count: historyData.length,
      totalDurationSeconds: historyData.reduce(
        (sum, item) => sum + item.duration,
        0,
      ),
      timeRange: `From ${fiveHoursAgo.toLocaleTimeString()} to Now`,
    };

    res.json({
      success: true,
      summary,
      data: historyData,
    });
  } catch (error) {
    console.error("Debug History Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
