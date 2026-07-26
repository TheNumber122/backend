import dotenv from "dotenv";
dotenv.config();
import express from "express";
import fileUpload from "express-fileupload";
import fs from "fs";
import path from "path";
import routes from "./routes";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "../swagger.json";
import { logSessionCount } from "./telegram/manager";
import { UPLOADS_DIR } from "./routes";
import http from "http";
import WebSocket from "ws";
import { setWebSocketClients, broadcastLog } from "./broadcast";

// mtcute can reject internal promises after a client is destroyed mid-operation
// (e.g. session torn down while a conversation is in flight). Without this, one
// stray rejection kills the whole process and strands every queued job.
process.on("unhandledRejection", (reason) => {
  console.error("[Telegap] Unhandled rejection (continuing):", reason);
});

const app = express();
const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

// CORS middleware
app.use((req, res, next) => {
  res.header(
    "Access-Control-Allow-Origin",
    process.env.FRONTEND_URL || "http://localhost:3000"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Workspace-Key"
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Multipart handling for the messaging image upload (broadcast). Files are kept
// in memory (req.files.<field>.data is a Buffer); the messaging endpoint persists
// them to UPLOADS_DIR so the async scheduler can read them at send time.
app.use(
  fileUpload({
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
    abortOnLimit: true,
  })
);

// Ensure the uploads directory exists for broadcast images.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Log session count on boot
logSessionCount();

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// API routes
app.use("/api", routes);

// Swagger UI
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const wsClients: WebSocket[] = [];
wss.on("connection", (ws) => {
  wsClients.push(ws);
  ws.on("close", () => {
    const idx = wsClients.indexOf(ws);
    if (idx !== -1) wsClients.splice(idx, 1);
  });
});

setWebSocketClients(wsClients);

// Initialize queue processors after WebSocket setup
import { startQueueProcessor, startMessagingProcessor } from "./routes";
server.listen(PORT, () => {
  console.log(`Server running on ${BACKEND_URL}`);
  console.log(`Swagger docs at ${BACKEND_URL}/docs`);
  startQueueProcessor();
  startMessagingProcessor();
});
