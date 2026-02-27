const { createHmac, timingSafeEqual } = require("crypto");

const SESSION_COOKIE_NAME = "pg_session";
const SESSION_DURATION_SECONDS = 6 * 60 * 60;
const DEV_FALLBACK_SECRET = "dev-only-change-auth-jwt-secret";

const getCookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  const crossSite = isProd;
  return {
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite,
  };
};

const getJwtSecret = () =>
  process.env.AUTH_JWT_SECRET || process.env.NEXTAUTH_SECRET || DEV_FALLBACK_SECRET;

const base64UrlEncodeJson = (value) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const signJwt = (data) =>
  createHmac("sha256", getJwtSecret()).update(data).digest("base64url");

const parseJwtPart = (value) => {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};

const extractCookie = (header, key) => {
  if (!header) return null;
  const pairs = header.split(";");
  for (const pair of pairs) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (rawName !== key) continue;
    const value = rawValue.join("=");
    if (!value) return null;
    return decodeURIComponent(value);
  }
  return null;
};

const createSessionToken = ({ userId, email }) => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_DURATION_SECONDS;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: userId,
    email,
    iat: issuedAt,
    exp: expiresAt,
  };

  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = signJwt(unsigned);

  return {
    token: `${unsigned}.${signature}`,
    expiresAt,
  };
};

const verifySessionToken = (token) => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  const header = parseJwtPart(encodedHeader);
  const payload = parseJwtPart(encodedPayload);
  if (!header || !payload) return null;
  if (header.alg !== "HS256" || header.typ !== "JWT") return null;

  const expectedSignature = signJwt(`${encodedHeader}.${encodedPayload}`);
  let expectedBytes;
  let providedBytes;

  try {
    expectedBytes = Buffer.from(expectedSignature, "base64url");
    providedBytes = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }

  if (expectedBytes.length !== providedBytes.length) return null;
  if (!timingSafeEqual(expectedBytes, providedBytes)) return null;

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;

  return {
    userId,
    email: payload.email,
    issuedAt,
    expiresAt,
  };
};

const getSessionFromRequest = (req) => {
  const token = extractCookie(req.headers?.cookie, SESSION_COOKIE_NAME);
  if (!token) return null;
  return verifySessionToken(token);
};

const unauthorizedJson = (res) => res.status(401).json({ error: "Unauthorized" });

const attachSessionCookie = (res, session) => {
  const options = getCookieOptions();
  res.cookie(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    ...options,
    path: "/",
    maxAge: SESSION_DURATION_SECONDS * 1000,
    expires: new Date(session.expiresAt * 1000),
  });
};

const clearSessionCookie = (res) => {
  const options = getCookieOptions();
  res.cookie(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    ...options,
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
};

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_SECONDS,
  createSessionToken,
  verifySessionToken,
  getSessionFromRequest,
  unauthorizedJson,
  attachSessionCookie,
  clearSessionCookie,
};
