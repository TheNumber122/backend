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
  const data = JSON.stringify({ type: "log", log });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
