import dotenv from "dotenv";
dotenv.config();
import express from "express";
import routes from "./routes";
import swaggerUi from "swagger-ui-express";
import swaggerDocument from "../swagger.json";
import { logSessionCount } from "./telegram/manager";
import http from "http";
import WebSocket from "ws";
import { setWebSocketClients, broadcastLog } from "./broadcast";

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

// Initialize queue processor after WebSocket setup
import { startQueueProcessor } from "./routes";
server.listen(PORT, () => {
  console.log(`Server running on ${BACKEND_URL}`);
  console.log(`Swagger docs at ${BACKEND_URL}/docs`);
  startQueueProcessor();
});
