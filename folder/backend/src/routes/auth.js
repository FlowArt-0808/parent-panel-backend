const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// 1. Эцэг эх нэвтрэх (Parent Login)
router.post("/parent-login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Хэрэглэгчийг имэйлээр хайх
    const user = await prisma.user.findUnique({
      where: { email },
      include: { children: true }, // Хүүхдүүдийн мэдээллийг хамт авна
    });

    // Хэрэглэгч олдсонгүй эсвэл нууц үг буруу (Энгийн шалгалт)
    // Санамж: Бодит төсөл дээр bcrypt ашиглан нууц үгийг hash хийх ёстой
    if (!user || user.password !== password) {
      return res
        .status(401)
        .json({ success: false, message: "Имэйл эсвэл нууц үг буруу байна." });
    }

    // Амжилттай бол хүүхдүүдийн жагсаалтыг буцаана
    const childrenList = user.children.map((child) => ({
      id: child.id,
      name: child.name,
    }));

    res.json({
      success: true,
      token: `user_${user.id}_token`, // Түр token (JWT байвал сайн)
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
    const { email, password } = req.body; // Extension-оос имэйлийг нь бас явуулах хэрэгтэй

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.password !== password) {
      return res.status(401).json({ success: false });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
