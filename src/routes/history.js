const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

router.get("/:childId", async (req, res, next) => {
  try {
    const { childId } = req.params;

    const history = await prisma.history.findMany({
      where: { childId: Number(childId) },
      orderBy: { visitedAt: "desc" },
      take: 50, // Хамгийн сүүлийн 50 хайлтыг авна
    });

    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
