const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const config = require("./config");
const { pool } = require("./db");
const memoryRoutes = require("./routes/memory");
const bridgeRoutes = require("./routes/bridge");
const windowsBridgeRoutes = require("./routes/windowsBridge");
const serviceRoutes = require("./routes/services");
const actionRoutes = require("./routes/actions");
const chatRoutes = require("./routes/chat");
const chatkitRoutes = require("./routes/chatkit");
const chatkitCustomAgentRoutes = require("./routes/chatkitCustomAgent");
const agentPageRoutes = require("./routes/agentPage");
const assistantRoutes = require("./routes/assistant");
const workerRoutes = require("./routes/workers");
const commandLineRoutes = require("./routes/commandLine");
const contactInboxRoutes = require("./routes/contactInbox");
const websiteContactMessages = require("./routes/websiteContactMessages");

const app = express();
const frontendDistPath = path.resolve(__dirname, "../../frontend/dist");
const frontendIndexPath = path.join(frontendDistPath, "index.html");

function isFrontendDistReady() {
  return fs.existsSync(frontendIndexPath);
}

function injectGarageAgentLink(html) {
  if (typeof html !== "string" || html.includes('href="/agent"')) {
    return html;
  }

  const linkMarkup =
    '<a id="garage-agent-dashboard-link" href="/agent" style="position:fixed;right:18px;bottom:18px;z-index:9999;border:1px solid rgba(125,183,224,.45);border-radius:999px;background:#111827;color:#e6edf5;padding:9px 13px;font:600 13px \'Segoe UI\',Tahoma,Geneva,Verdana,sans-serif;text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,.35);">Garage Agent</a>';

  if (html.includes("</body>")) {
    return html.replace("</body>", `    ${linkMarkup}\n  </body>`);
  }

  return `${html}\n${linkMarkup}`;
}

function sendFrontendIndex(req, res) {
  if (!isFrontendDistReady()) {
    return res.status(503).json({
      error: "Frontend build is missing. Run npm run build before production start.",
    });
  }

  const html = fs.readFileSync(frontendIndexPath, "utf8");
  res.type("html").send(injectGarageAgentLink(html));
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
app.use("/api/windows-bridge", windowsBridgeRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/actions", actionRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/chatkit", chatkitRoutes);
app.use("/api/chatkit/custom-agent", chatkitCustomAgentRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/command-line", commandLineRoutes);
app.use("/api/contact-inbox", contactInboxRoutes);
app.use("/api/website/contact-messages", websiteContactMessages.router);
app.get("/contact-inbox", websiteContactMessages.renderContactInboxPage);
app.use(agentPageRoutes);
app.get("/", sendFrontendIndex);

app.use(express.static(frontendDistPath));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return next();
  }

  return sendFrontendIndex(req, res);
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

