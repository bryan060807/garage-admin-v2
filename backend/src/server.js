const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const config = require("./config");
const { pool } = require("./db");
const memoryRoutes = require("./routes/memory");
const bridgeRoutes = require("./routes/bridge");
const serviceRoutes = require("./routes/services");
const actionRoutes = require("./routes/actions");
const chatRoutes = require("./routes/chat");

const app = express();
const frontendDistPath = path.resolve(__dirname, "../../frontend/dist");
const frontendIndexPath = path.join(frontendDistPath, "index.html");

function isFrontendDistReady() {
  return fs.existsSync(frontendIndexPath);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: config.frontendOrigin,
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "garage-admin-v2-backend",
    databaseConfigured: Boolean(pool),
    frontendDistReady: isFrontendDistReady(),
  });
});

app.use("/api/memory", memoryRoutes);
app.use("/api/bridge", bridgeRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/actions", actionRoutes);
app.use("/api/chat", chatRoutes);

app.use(express.static(frontendDistPath));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return next();
  }

  if (!isFrontendDistReady()) {
    return res.status(503).json({
      error: "Frontend build is missing. Run npm run build before production start.",
    });
  }

  return res.sendFile(frontendIndexPath);
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    error: error.message || "Internal server error",
  });
});

app.listen(config.port, config.host, () => {
  console.log(`Garage Admin V2 backend listening on http://${config.host}:${config.port}`);
});
