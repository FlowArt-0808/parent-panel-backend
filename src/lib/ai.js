const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function parseClassificationPayload(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  const cleaned = rawText.trim();
  const candidates = [cleaned];

  const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const category = typeof parsed?.category === "string" ? parsed.category.trim() : "";
      const safetyScore = Number(parsed?.safetyScore);
      if (!category || !Number.isFinite(safetyScore)) {
        continue;
      }
      return {
        category,
        safetyScore: Math.max(0, Math.min(100, Math.round(safetyScore))),
      };
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function classifyWebsite(domain) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const prompt = `Classify the website domain "${domain}".
Return JSON only in this format:
{
  "category": "Education, Social Media, Adult, Games, or Entertainment",
  "safetyScore": number from 0 to 100 (0 = very unsafe, 100 = very safe)
}`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    return parseClassificationPayload(response.text());
  } catch (error) {
    console.error("Gemini Classification Error:", error);
    return null;
  }
}

module.exports = { classifyWebsite };
