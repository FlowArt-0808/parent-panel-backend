require("dotenv").config();
const express = require("express");
const cors = require("cors");
const checkUrlRoutes = require("./routes/checkUrl");
const historyRoutes = require("./routes/history");
const authRoutes = require("./routes/auth");
const trackTime = require("./routes/trackTime");
const debug = require("./routes/debug");
// Ð‘ÑƒÑÐ°Ð´ route-ÑƒÑƒÐ´Ð°Ð° ÑÐ½Ð´ Ð½ÑÐ¼Ð½Ñ

const app = express();
const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;

// --- Middlewares ---
app.use(cors()); // Frontend Ð±Ð¾Ð»Ð¾Ð½ Extension-Ð¾Ð¾Ñ Ñ…Ð°Ð½Ð´Ð°Ñ… ÑÑ€Ñ…
app.use(express.json()); // JSON Ð´Ð°Ñ‚Ð° ÑƒÐ½ÑˆÐ¸Ñ…

// --- Routes ---
app.use("/api/check-url", checkUrlRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/track-time", trackTime);
app.use("/api/debug", debug);
// Ð‘ÑƒÑÐ°Ð´ route-ÑƒÑƒÐ´ ÑÐ½Ð´ Ð½ÑÐ¼Ð½Ñ

// Health Check (Ð¡ÐµÑ€Ð²ÐµÑ€ Ð°Ð¶Ð¸Ð»Ð»Ð°Ð¶ Ð±Ð°Ð¹Ð³Ð°Ð° ÑÑÑÑ…Ð¸Ð¹Ð³ ÑˆÐ°Ð»Ð³Ð°Ñ…)
app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "SafeKid Server is running" });
});

// --- Global Error Handler (Ó¨Ð½Ð´Ó©Ñ€ Ñ‡Ð°Ð½Ð°Ñ€Ñ‹Ð½ Ð³Ð¾Ð» ÑˆÐ¸Ð½Ð¶) ---
app.use((err, req, res, next) => {
  console.error("âŒ Server Error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// Start Server on a stable port
const startServer = (port) => {
  const server = app.listen(port, () => {
    console.log(`\nServer is ready at: http://localhost:${port}\n`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the other process or set PORT.`);
      process.exit(1);
    }
    throw err;
  });
};

startServer(DEFAULT_PORT);
