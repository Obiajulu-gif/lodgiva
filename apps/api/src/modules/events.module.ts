import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { JwtService } from "@nestjs/jwt";
import { AuthContext, Public } from "../common/auth";

/**
 * Live updates over Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional (server tells
 * devices what changed), it survives ordinary HTTP proxies, and it reconnects
 * on its own. On the intermittent connections these devices actually use, a
 * protocol that recovers without application code is worth more than
 * bidirectional capability nobody needs here.
 *
 * The stream carries CHANGE NOTIFICATIONS, not payloads: a client is told
 * "housekeeping changed since cursor X" and re-reads through the normal,
 * permission-checked endpoints. That keeps authorisation in exactly one place
 * instead of duplicating it into a push path.
 */

interface Client {
  id: number;
  tenantId: string;
  propertyId?: string;
  write: (chunk: string) => void;
}

@Injectable()
export class EventsService {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private lastSeen = new Date();

  constructor(private readonly prisma: PrismaService) {}

  register(client: Omit<Client, "id">): () => void {
    const id = this.nextId++;
    this.clients.set(id, { ...client, id });
    this.ensurePolling();
    return () => {
      this.clients.delete(id);
      if (this.clients.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  get connectionCount() {
    return this.clients.size;
  }

  /**
   * Watches the outbox for changes and fans out notifications.
   *
   * Polling the outbox rather than emitting from every service keeps the
   * publish path in one place, and means an event still reaches devices when
   * it was written by the worker or by another process.
   */
  private ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const since = this.lastSeen;
        const events = await this.prisma.outboxEvent.findMany({
          where: { occurredAt: { gt: since } },
          orderBy: { occurredAt: "asc" },
          take: 50,
        });
        if (events.length === 0) return;
        this.lastSeen = events[events.length - 1].occurredAt;

        for (const e of events) {
          this.broadcast(e.tenantId, {
            type: e.eventType,
            aggregateType: e.aggregateType,
            aggregateId: e.aggregateId,
            occurredAt: e.occurredAt.toISOString(),
          });
        }
      } catch {
        // A failed poll must never kill the stream; the next tick retries.
      }
    }, 3000);
  }

  broadcast(tenantId: string, payload: Record<string, unknown>) {
    const data = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients.values()) {
      if (c.tenantId !== tenantId) continue;
      try {
        c.write(data);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }
}

@Controller("events")
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly jwt: JwtService
  ) {}

  /**
   * EventSource cannot send an Authorization header, so the access token is
   * accepted as a query parameter here. It is verified with the same secret
   * and the connection is scoped to the tenant in the verified token — a
   * client cannot subscribe to a tenant it has no token for.
   */
  @Public()
  @Get("stream")
  async stream(
    @Query("token") token: string,
    @Query("propertyId") propertyId: string | undefined,
    @Res() reply: {
      raw: {
        writeHead: (code: number, headers: Record<string, string>) => void;
        write: (chunk: string) => void;
        end: () => void;
        on: (event: string, cb: () => void) => void;
      };
    },
    @Req() req: { raw: { on: (event: string, cb: () => void) => void } }
  ) {
    let auth: AuthContext;
    try {
      auth = await this.jwt.verifyAsync<AuthContext>(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      reply.raw.writeHead(401, { "Content-Type": "application/json" });
      reply.raw.write(
        JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Invalid stream token." } })
      );
      reply.raw.end();
      return;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the point of a stream.
      "X-Accel-Buffering": "no",
    });

    const write = (chunk: string) => reply.raw.write(chunk);
    // Tell the browser how long to wait before reconnecting, and prove the
    // stream is alive immediately so the UI can show "live" without guessing.
    write("retry: 5000\n\n");
    write(`event: ready\ndata: ${JSON.stringify({ tenantId: auth.tenantId, propertyId })}\n\n`);

    const unregister = this.events.register({
      tenantId: auth.tenantId,
      propertyId,
      write,
    });

    // Comment frames keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      try {
        write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        /* the close handler will clean up */
      }
    }, 20000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unregister();
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  }
}

@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
