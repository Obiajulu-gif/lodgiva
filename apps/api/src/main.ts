import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";

// SQLite database lives next to the Prisma schema (see ADR-LOCAL-001).
process.env.DATABASE_URL ??= "file:./dev.db";
process.env.JWT_SECRET ??= "lodgiva-dev-secret-change-in-production";

// Money is BigInt minor units (§7.3); serialize as number for JSON responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter()
  );
  app.setGlobalPrefix("api/v1");
  await app.register(require("@fastify/cors"), {
    origin: true,
    credentials: true,
  });
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  console.log(`Lodgiva API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
