import WebSocket from "ws";

let clients: WebSocket[] = [];

export function setWebSocketClients(wsClients: WebSocket[]) {
  clients = wsClients;
}

export function broadcastLog(log: {
  message: string;
  type: "success" | "info" | "error";
  timestamp: string;
}) {
  // Mirror to stdout so Render's log stream shows activity even with no WS client.
  console.log(`[${log.timestamp}] [${log.type}] ${log.message}`);
  const data = JSON.stringify({ type: "log", log });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
