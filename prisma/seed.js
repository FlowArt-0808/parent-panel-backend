const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("🛠️  Adding Demo URL Settings...");

  // 1. Хүүхдүүдээ олох
  const anart = await prisma.child.findFirst({ where: { name: "Анарт" } });
  const huslen = await prisma.child.findFirst({ where: { name: "Хүслэн" } });

  if (!anart || !huslen) {
    console.error(
      "❌ 'Анарт' эсвэл 'Хүслэн' олдсонгүй. Эхлээд үндсэн seed-ээ ажиллуулна уу.",
    );
    return;
  }

  // 2. Каталогоос сайтуудаа олох
  const roblox = await prisma.urlCatalog.findUnique({
    where: { domain: "roblox.com" },
  });
  const facebook = await prisma.urlCatalog.findUnique({
    where: { domain: "facebook.com" },
  });
  const khan = await prisma.urlCatalog.findUnique({
    where: { domain: "khanacademy.org" },
  });
  const youtube = await prisma.urlCatalog.findUnique({
    where: { domain: "youtube.com" },
  });

  // 3. Тусгай тохиргоонууд (Upsert ашиглах нь аюулгүй - алдаа заахгүй)

  const settings = [
    // АНАРТ: Roblox-ыг тусгайлан зөвшөөрөх (Хэрэв Games категори блоклогдсон байсан ч энэ нь ажиллана)
    {
      childId: anart.id,
      urlId: roblox.id,
      status: "ALLOWED",
    },
    // АНАРТ: Facebook-ийг бүрэн БЛОКЛОХ
    {
      childId: anart.id,
      urlId: facebook.id,
      status: "BLOCKED",
    },
    // ХҮСЛЭН: Khan Academy-д 120 минутын лимит тавих
    {
      childId: huslen.id,
      urlId: khan.id,
      status: "LIMITED",
      timeLimit: 120,
    },
    // ХҮСЛЭН: Youtube-ийг БЛОКЛОХ
    {
      childId: huslen.id,
      urlId: youtube.id,
      status: "BLOCKED",
    },
  ];

  for (const s of settings) {
    await prisma.childUrlSetting.upsert({
      where: {
        childId_urlId: { childId: s.childId, urlId: s.urlId },
      },
      update: {
        status: s.status,
        timeLimit: s.timeLimit || null,
      },
      create: s,
    });
  }

  console.log("✅ Demo URL Settings successfully added!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
