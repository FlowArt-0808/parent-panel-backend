const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { hashPassword, isHashedPassword, verifyPassword } = require("../lib/password");
const {
  attachSessionCookie,
  clearSessionCookie,
  createSessionToken,
  getSessionFromRequest,
  unauthorizedJson,
} = require("../lib/session");

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

// 4. Parent signup (Frontend dashboard)
router.post("/signup", async (req, res, next) => {
  try {
    const { email, password, name } = req.body ?? {};
    const trimmedEmail = normalizeEmail(email).toLowerCase();
    const providedPassword = typeof password === "string" ? password : "";
    const trimmedName = typeof name === "string" ? name.trim() : "";

    if (!trimmedEmail || !providedPassword) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }

    const hashedPassword = await hashPassword(providedPassword);

    const user = await prisma.user.create({
      data: {
        email: trimmedEmail,
        password: hashedPassword,
        name: trimmedName || null,
      },
      select: { id: true, email: true, name: true },
    });

    const session = createSessionToken({ userId: user.id, email: user.email });
    attachSessionCookie(res, session);
    return res.json({
      user: { ...user, expiresAt: session.expiresAt * 1000 },
    });
  } catch (error) {
    const isUniqueError =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002";
    if (isUniqueError) {
      return res.status(409).json({ error: "Email already in use." });
    }
    next(error);
  }
});

// 5. Parent login (Frontend dashboard)
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const trimmedEmail = normalizeEmail(email).toLowerCase();
    const providedPassword = typeof password === "string" ? password : "";

    if (!trimmedEmail || !providedPassword) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }

    const user = await prisma.user.findUnique({
      where: { email: trimmedEmail },
      select: { id: true, email: true, name: true, password: true },
    });

    if (!user || !(await verifyPassword(providedPassword, user.password))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    await upgradeLegacyPasswordIfNeeded(user.id, user.password, providedPassword);

    const session = createSessionToken({ userId: user.id, email: user.email });
    attachSessionCookie(res, session);
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        expiresAt: session.expiresAt * 1000,
      },
    });
  } catch (error) {
    next(error);
  }
});

// 6. Session check (Frontend dashboard)
router.get("/session", async (req, res, next) => {
  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      return unauthorizedJson(res);
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Unauthorized" });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        expiresAt: session.expiresAt * 1000,
      },
    });
  } catch (error) {
    next(error);
  }
});

// 7. Logout (Frontend dashboard)
router.post("/logout", async (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

module.exports = router;
