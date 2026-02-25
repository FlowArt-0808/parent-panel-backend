require("dotenv").config();
const express = require("express");
const cors = require("cors");
const checkUrlRoutes = require("./routes/checkUrl");
const historyRoutes = require("./routes/history");
const authRoutes = require("./routes/auth");
const trackTime = require("./routes/trackTime");
const debug = require("./routes/debug");
// Бусад route-уудаа энд нэмнэ

const app = express();
const PORT = process.env.PORT || 5000;

// --- Middlewares ---
app.use(cors()); // Frontend болон Extension-оос хандах эрх
app.use(express.json()); // JSON дата унших

// --- Routes ---
app.use("/api/check-url", checkUrlRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/track-time", trackTime);
app.use("/api/debug", debug);
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
