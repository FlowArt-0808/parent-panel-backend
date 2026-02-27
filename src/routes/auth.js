const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { hashPassword, isHashedPassword, verifyPassword } = require("../lib/password");

const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim() : "";

const upgradeLegacyPasswordIfNeeded = async (userId, passwordValue, plainPassword) => {
  if (isHashedPassword(passwordValue)) return;
  const hashedPassword = await hashPassword(plainPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });
};

// 1. Эцэг эх нэвтрэх (Parent Login)
router.post("/parent-login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Имэйл болон нууц үг шаардлагатай." });
    }

    // Имэйлийг жижиг/том үсгээс үл хамааран хайна.
    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
      include: { children: true },
    });

    if (!user || !(await verifyPassword(password, user.password))) {
      return res
        .status(401)
        .json({ success: false, message: "Имэйл эсвэл нууц үг буруу байна." });
    }

    await upgradeLegacyPasswordIfNeeded(user.id, user.password, password);

    const childrenList = user.children.map((child) => ({
      id: child.id,
      name: child.name,
    }));

    res.json({
      success: true,
      token: `user_${user.id}_token`,
      children: childrenList,
    });
  } catch (error) {
    next(error);
  }
});

// 2. Хүүхдийн PIN шалгах (Verify PIN)
router.post("/verify-pin", async (req, res, next) => {
  try {
    const { childId, pin } = req.body;

    const child = await prisma.child.findUnique({
      where: { id: Number(childId) },
    });

    if (!child || child.pin !== pin) {
      return res
        .status(401)
        .json({ success: false, message: "PIN код буруу байна." });
    }

    res.json({ success: true, message: "PIN зөв байна." });
  } catch (error) {
    next(error);
  }
});

// 3. Эцэг эхийн нууц үг шалгах (Logout хийх үед)
router.post("/verify-parent", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      return res.status(400).json({ success: false });
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
      select: { id: true, password: true },
    });

    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ success: false });
    }

    await upgradeLegacyPasswordIfNeeded(user.id, user.password, password);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
