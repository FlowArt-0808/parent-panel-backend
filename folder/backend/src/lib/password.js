const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const FORMAT_PREFIX = "scrypt";

const hashPassword = async (password) => {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `${FORMAT_PREFIX}$${salt}$${derivedKey.toString("hex")}`;
};

const isHashedPassword = (value) =>
  typeof value === "string" && value.startsWith(`${FORMAT_PREFIX}$`);

const verifyPassword = async (password, storedPassword) => {
  if (!password || !storedPassword) return false;
  if (!isHashedPassword(storedPassword)) {
    return password === storedPassword;
  }

  const [, salt, savedKeyHex] = storedPassword.split("$");
  if (!salt || !savedKeyHex) return false;

  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  const savedKey = Buffer.from(savedKeyHex, "hex");

  if (savedKey.length !== derivedKey.length) return false;
  return timingSafeEqual(savedKey, derivedKey);
};

module.exports = {
  hashPassword,
  isHashedPassword,
  verifyPassword,
};
