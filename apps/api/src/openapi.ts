import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";

/**
 * OpenAPI description of the API.
 *
 * Routes are described by decorators where they exist; because request bodies
 * are validated with Zod rather than class-validator DTOs, the generated
 * document describes paths, security and responses accurately but does not
 * introspect body shapes. Body contracts are documented in
 * docs/api-reference.md alongside the generated file — this is a known
 * limitation of pairing Zod with @nestjs/swagger and is called out rather
 * than papered over.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Lodgiva API")
    .setDescription(
      "Hotel management platform API. All protected routes require a Bearer " +
        "access token; the tenant is always derived from the token and never " +
        "from the request body."
    )
    .setVersion("1.0.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "access-token"
    )
    .addTag("auth", "Login, refresh rotation, sessions")
    .addTag("onboarding", "Tenant provisioning and staff invitations")
    .addTag("config", "Property settings, room types, rooms, amenities, blocks")
    .addTag("reservations", "Availability, booking and the stay lifecycle")
    .addTag("folios", "Append-only guest ledger")
    .addTag("payments", "Payment capture and reconciliation")
    .addTag("cashiering", "Shifts, movements and variance approval")
    .addTag("reports", "Flash report, tax summary, exports, audit trail")
    .addServer("http://localhost:4000", "Local development")
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function mountSwagger(app: INestApplication, document: OpenAPIObject) {
  SwaggerModule.setup("api/v1/docs", app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
