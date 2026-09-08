import { buildOpenApiDocument, createApiApp } from "./app-factory";

/**
 * Standalone server entry point. The application itself is built by
 * createApiApp() so that the serverless handler runs the identical
 * configuration; all this file adds is a listening socket.
 */
async function bootstrap() {
  const app = await createApiApp();

  // Emitting the spec is a build-time concern of the standalone process, not
  // something a request path should ever do.
  if (process.env.OPENAPI_OUT) {
    const document = buildOpenApiDocument(app);
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(process.env.OPENAPI_OUT), { recursive: true });
    writeFileSync(process.env.OPENAPI_OUT, JSON.stringify(document, null, 2));
    console.log(`OpenAPI written to ${process.env.OPENAPI_OUT}`);
    if (process.env.OPENAPI_EXIT === "1") {
      await app.close();
      return;
    }
  }

  // PORT is what a platform injects (Render, Fly, Heroku); API_PORT is the
  // local convention. The platform wins, because a service that ignores it
  // binds a port nothing routes to and the health check fails a deploy that
  // otherwise built perfectly.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  console.log(`Lodgiva API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
