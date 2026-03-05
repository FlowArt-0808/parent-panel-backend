const SEARCH_QUERY_PARAMS = {
  "google.com": ["q"],
  "bing.com": ["q"],
  "duckduckgo.com": ["q"],
  "yahoo.com": ["p"],
  "yandex.com": ["text"],
  "youtube.com": ["search_query"],
  "m.youtube.com": ["search_query"],
};

const SOCIAL_MEDIA_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "snapchat.com",
  "discord.com",
  "reddit.com",
  "threads.net",
];

const KNOWN_DOMAIN_CLASSIFICATIONS = [
  { domains: ["youtube.com", "youtu.be"], category: "Entertainment", safetyScore: 75 },
  { domains: ["netflix.com", "disneyplus.com", "hulu.com", "primevideo.com"], category: "Entertainment", safetyScore: 72 },
  { domains: ["spotify.com", "music.youtube.com", "soundcloud.com"], category: "Entertainment", safetyScore: 78 },
  { domains: ["wikipedia.org", "khanacademy.org", "coursera.org", "edx.org"], category: "Education", safetyScore: 92 },
  { domains: ["google.com", "bing.com", "duckduckgo.com", "yahoo.com", "yandex.com"], category: "Search", safetyScore: 70 },
  { domains: ["facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "snapchat.com", "reddit.com", "threads.net"], category: "Social Media", safetyScore: 55 },
  { domains: ["discord.com", "telegram.org", "whatsapp.com", "messenger.com"], category: "Messaging", safetyScore: 60 },
  { domains: ["roblox.com", "steampowered.com", "epicgames.com", "minecraft.net"], category: "Games", safetyScore: 62 },
  { domains: ["amazon.com", "ebay.com", "temu.com", "aliexpress.com"], category: "Shopping", safetyScore: 70 },
  { domains: ["paypal.com", "stripe.com", "wise.com"], category: "Finance", safetyScore: 82 },
  { domains: ["who.int", "mayoclinic.org", "webmd.com"], category: "Health", safetyScore: 86 },
];

const CATEGORY_SCORE_CAPS = {
  Adult: 15,
  Porn: 10,
  Gambling: 30,
  Drugs: 20,
  Crime: 25,
  Violence: 25,
  "Social Media": 70,
};

const ADULT_DOMAIN_PATTERNS = [
  /porn/i,
  /xxx/i,
  /xvideos/i,
  /xnxx/i,
  /xhamster/i,
  /redtube/i,
  /youporn/i,
  /hentai/i,
  /onlyfans/i,
  /camgirl/i,
  /adult/i,
];

const DRUG_DOMAIN_PATTERNS = [/drug/i, /weed/i, /cocaine/i, /heroin/i, /meth/i, /ganja/i];
const CRIME_DOMAIN_PATTERNS = [/crime/i, /murder/i, /gore/i, /violence/i, /weapon/i];

const BLOCKED_KEYWORDS = {
  adult: [
    "porn",
    "porno",
    "порно",
    "xxx",
    "sex",
    "секс",
    "nude",
    "naked",
    "hentai",
    "эротик",
    "adult",
    "эрос",
  ],
  drugs: [
    "drugs",
    "cocaine",
    "heroin",
    "meth",
    "weed",
    "marijuana",
    "ganja",
    "хар тамхи",
    "мансууруулах",
  ],
  crime: [
    "crime",
    "murder",
    "killing",
    "gore",
    "violence",
    "terror",
    "terrorism",
    "гэмт хэрэг",
    "хүчирхийлэл",
  ],
};

const domainMatches = (domain, target) => {
  if (!domain || !target) return false;
  return domain === target || domain.endsWith(`.${target}`);
};

const normalizeText = (value) =>
  decodeURIComponent(String(value ?? ""))
    .toLowerCase()
    .replace(/\+/g, " ")
    .trim();

const getSearchQuery = (urlObj, domain) => {
  const params = SEARCH_QUERY_PARAMS[domain] || [];
  if (params.length === 0) return "";
  const parts = [];
  for (const param of params) {
    const value = urlObj.searchParams.get(param);
    if (value) parts.push(value);
  }
  return normalizeText(parts.join(" "));
};

const getSearchKeywordMatch = (urlObj, domain) => {
  if (!domain || !urlObj) return null;
  const searchDomain = Object.keys(SEARCH_QUERY_PARAMS).find((entry) =>
    domainMatches(domain, entry)
  );
  if (!searchDomain) return null;
  const query = getSearchQuery(urlObj, searchDomain);
  if (!query) return null;

  for (const [group, keywords] of Object.entries(BLOCKED_KEYWORDS)) {
    const match = keywords.find((keyword) => query.includes(keyword));
    if (match) {
      return { group, keyword: match, query };
    }
  }
  return null;
};

const getRuleBasedCategory = (domain) => {
  if (!domain) return null;
  const normalized = domain.toLowerCase();
  if (ADULT_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "Adult", safetyScore: 5 };
  }
  if (DRUG_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "Drugs", safetyScore: 15 };
  }
  if (CRIME_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "Crime", safetyScore: 20 };
  }
  return null;
};

const getKnownDomainClassification = (domain) => {
  if (!domain) return null;
  for (const rule of KNOWN_DOMAIN_CLASSIFICATIONS) {
    const matched = rule.domains.find((entry) => domainMatches(domain, entry));
    if (matched) {
      return {
        category: rule.category,
        safetyScore: rule.safetyScore,
      };
    }
  }
  return null;
};

const adjustSafetyScore = (domain, category, score) => {
  let adjusted = Number.isFinite(score) ? score : 50;

  const cap = CATEGORY_SCORE_CAPS[category];
  if (typeof cap === "number") {
    adjusted = Math.min(adjusted, cap);
  }

  if (SOCIAL_MEDIA_DOMAINS.some((entry) => domainMatches(domain, entry))) {
    adjusted = Math.min(adjusted, CATEGORY_SCORE_CAPS["Social Media"]);
  }

  adjusted = Math.max(0, Math.min(100, adjusted));
  return adjusted;
};

module.exports = {
  adjustSafetyScore,
  getKnownDomainClassification,
  getRuleBasedCategory,
  getSearchKeywordMatch,
};
