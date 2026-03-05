const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ALLOWED_CATEGORIES = new Set([
  "Education",
  "Social Media",
  "Adult",
  "Games",
  "Entertainment",
  "News",
  "Search",
  "Shopping",
  "Finance",
  "Health",
  "Messaging",
  "Gambling",
  "Drugs",
  "Crime",
  "Other",
]);

const CATEGORY_ALIASES = {
  "video": "Entertainment",
  "videos": "Entertainment",
  "streaming": "Entertainment",
  "social": "Social Media",
  "social media": "Social Media",
  "chat": "Messaging",
  "messaging": "Messaging",
  "gambling/casino": "Gambling",
  "adult/porn": "Adult",
};

const normalizeCategory = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "Other";
  if (ALLOWED_CATEGORIES.has(raw)) return raw;
  const lowered = raw.toLowerCase();
  const alias = CATEGORY_ALIASES[lowered];
  if (alias) return alias;
  return "Other";
};

const clampSafetyScore = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 50;
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

async function classifyWebsite(domain) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const prompt = `Classify the website domain "${domain}".
    Дараах JSON форматаар хариул:
    {
      "category": "Education | Social Media | Adult | Games | Entertainment | News | Search | Shopping | Finance | Health | Messaging | Gambling | Drugs | Crime | Other",
      "safetyScore": 0-100 хооронд тоо (0 бол маш аюултай, 100 бол маш аюулгүй)
    }

    Дүрэм:
    - Adult/Porn/Gambling/Drugs/Crime/Violence: 0-30 оноо
    - Social Media/Chat: 40-70 оноо
    - News/Shopping/Entertainment: 50-80 оноо
    - Education/Tools: 80-100 оноо
    - Эргэлзээтэй бол "Other" болон ~50 оноо өг.`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const parsed = JSON.parse(response.text());

    return {
      category: normalizeCategory(parsed?.category),
      safetyScore: clampSafetyScore(parsed?.safetyScore),
    };
  } catch (error) {
    console.error("Gemini Classification Error:", error);
    return null;
  }
}

module.exports = { classifyWebsite };
