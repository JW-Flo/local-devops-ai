import type { Response } from "express";

export type EventType =
  | "health"
  | "metrics"
  | "task:submitted"
  | "task:completed"
  | "task:failed"
  | "ingest:progress"
  | "ingest:complete"
  | "orchestrator:roadmap"
  | "orchestrator:task"
  | "coding-agent:start"
  | "coding-agent:generated"
  | "coding-agent:pr"
  | "coding-agent:error"
  | "home:device:state"
  | "home:scene:activated"
  | "home:adapter:status"
  | "home:network:scan"
  | "home:network:device";

export type SSEPayload = {
  type: EventType;
  data: unknown;
  timestamp: string;
};
const clients = new Set<Response>();

export function addSSEClient(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 3000\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function broadcast(type: EventType, data: unknown): void {
  const payload: SSEPayload = {
    type,
    data,
    timestamp: new Date().toISOString(),
  };
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(msg); } catch { clients.delete(client); }
  }
}

export function clientCount(): number {
  return clients.size;
}