require("dotenv").config();
const express = require("express");
const cors = require("cors");
const checkUrlRoutes = require("./routes/checkUrl");
const historyRoutes = require("./routes/history");
const authRoutes = require("./routes/auth");
const trackTime = require("./routes/trackTime");
const debug = require("./routes/debug");
const childRoutes = require("./routes/child");
const dashboardRoutes = require("./routes/dashboard");
const blockingRoutes = require("./routes/blocking");
const timeLimitRoutes = require("./routes/timelimits");
const aiAssistantRoutes = require("./routes/aiAssistant");
// Бусад route-уудаа энд нэмнэ

const app = express();
const PORT = process.env.PORT || 5000;

// --- Middlewares ---
const allowedOrigins = [
  "https://tsevermongolchuud.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
); // Frontend болон Extension-оос хандах эрх
app.use(express.json()); // JSON дата унших

// --- Routes ---
app.use("/api/check-url", checkUrlRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/track-time", trackTime);
app.use("/api/debug", debug);
app.use("/api/child", childRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/blocking", blockingRoutes);
app.use("/api/timelimits", timeLimitRoutes);
app.use("/api/ai/assistant", aiAssistantRoutes);
// Бусад route-ууд энд нэмнэ

// Health Check (Сервер ажиллаж байгаа эсэхийг шалгах)
app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "SafeKid Server is running" });
});

// --- Global Error Handler (Өндөр чанарын гол шинж) ---
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n🚀 Server is ready at: http://localhost:${PORT}\n`);
});
