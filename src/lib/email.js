let nodemailer = null;
try {
  // Optional dependency in development environments.
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

let cachedTransporter = null;

const getEmailConfig = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || process.env.MAIL_FROM || user || null;

  return { host, port, secure, user, pass, from };
};

const canSendEmail = () => {
  const cfg = getEmailConfig();
  return Boolean(
    nodemailer &&
      cfg.host &&
      Number.isFinite(cfg.port) &&
      cfg.port > 0 &&
      cfg.user &&
      cfg.pass &&
      cfg.from,
  );
};

const getTransporter = () => {
  if (!canSendEmail()) return null;
  if (cachedTransporter) return cachedTransporter;

  const cfg = getEmailConfig();
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  return cachedTransporter;
};

async function sendEmail({ to, subject, text, html }) {
  if (!to || typeof to !== "string") {
    return { sent: false, reason: "Missing email recipient." };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: "SMTP is not configured or nodemailer is unavailable.",
    };
  }

  const cfg = getEmailConfig();

  try {
    await transporter.sendMail({
      from: cfg.from,
      to,
      subject: subject || "Safe-kid notification",
      text: text || undefined,
      html: html || undefined,
    });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "Failed to send email.",
    };
  }
}

module.exports = {
  canSendEmail,
  sendEmail,
};
