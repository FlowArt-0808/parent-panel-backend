const RESTRICTED_CATEGORY_KEYWORDS = [
  "adult",
  "porn",
  "gambling",
  "casino",
  "betting",
  "drugs",
  "crime",
  "violence",
];

const normalizeCategoryName = (value) =>
  String(value ?? "").trim().toLowerCase();

const isRestrictedCategory = (name) => {
  const normalized = normalizeCategoryName(name);
  if (!normalized) return false;
  return RESTRICTED_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const filterRestrictedCategories = (categories) =>
  categories.filter((category) => !isRestrictedCategory(category.name));

module.exports = {
  normalizeCategoryName,
  isRestrictedCategory,
  filterRestrictedCategories,
};
