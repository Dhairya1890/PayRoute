import { FastifyReply } from 'fastify';

export interface LabEvent {
  type: 'payment_completed' | 'attempt_outcome' | 'breaker_transition' | 'scoreboard_update' | 'scenario_verdict';
  data: unknown;
  timestamp: string;
}

export class LabEventHub {
  private clients: Set<FastifyReply> = new Set();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  addClient(reply: FastifyReply): void {
    this.clients.add(reply);

    // Send initial connected event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clients: this.clients.size })}\n\n`);

    reply.raw.on('close', () => {
      this.clients.delete(reply);
    });
  }

  broadcast(type: LabEvent['type'], data: unknown): void {
    const payload: LabEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };

    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

    for (const client of this.clients) {
      try {
        client.raw.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.raw.write(': ping\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15000);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

export const labEventHub = new LabEventHub();
