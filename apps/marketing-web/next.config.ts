import type { NextConfig } from "next";

/**
 * The API can be served two ways, and which one is active is decided by a
 * single variable:
 *
 *  - LODGIVA_API_ORIGIN set   -> proxy to a standalone server (local dev
 *                                against `pnpm api`, or a Render deployment).
 *  - LODGIVA_API_ORIGIN unset -> serve the API in-process from
 *                                app/api/v1/[...path]/route.ts, which is what
 *                                makes a single-project Vercel deployment work.
 *
 * Only one is ever active, so there is never a question of which handled a
 * request.
 */
const apiOrigin = process.env.LODGIVA_API_ORIGIN?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * These must not be bundled. Argon2 and the Prisma query engine load native
   * `.node` binaries at runtime, and NestJS resolves providers by reflection
   * over class metadata that a bundler's renaming destroys. Leaving them
   * external means Node `require`s them normally from node_modules.
   */
  serverExternalPackages: [
    "@lodgiva/api",
    "@lodgiva/database",
    "@nestjs/core",
    "@nestjs/common",
    "@nestjs/platform-fastify",
    "@nestjs/jwt",
    "@nestjs/swagger",
    "@prisma/client",
    ".prisma/client",
    "argon2",
    "fastify",
    "@fastify/cookie",
    "@fastify/cors",
    "@fastify/helmet",
    "@fastify/rate-limit",
    "@fastify/static",
    "web-push",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "reflect-metadata",
  ],

  // Traced so the standalone build actually ships the Prisma engine and the
  // Argon2 prebuild; without this the function starts and then fails on its
  // first password check.
  outputFileTracingIncludes: {
    "/api/v1/[...path]": [
      "../../node_modules/.pnpm/**/node_modules/.prisma/client/**",
      "../../node_modules/.pnpm/**/node_modules/argon2/prebuilds/linux-x64/**",
    ],
  },

  /**
   * `serverExternalPackages` alone is not enough here. That list is consulted
   * for imports originating inside the app; this route's import chain starts in
   * `../api/dist`, outside it, so webpack followed it and tried to bundle the
   * whole of NestJS — failing on optional dependencies it does not need
   * (`mustache`, `ect`). Forcing the externals makes them plain runtime
   * requires, which is what a native module and a reflection-based DI container
   * both need in order to work at all.
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externalPattern =
        /^(@lodgiva\/(api|database)|@nestjs\/|fastify$|@fastify\/|argon2$|@prisma\/client|\.prisma\/client|web-push$|@aws-sdk\/|reflect-metadata$)/;
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        (
          { request }: { request?: string },
          callback: (error?: unknown, result?: string) => void,
        ) => {
          if (request && externalPattern.test(request)) {
            return callback(undefined, `commonjs ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },

  async rewrites() {
    if (!apiOrigin) return [];
    return [{ source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` }];
  },
};

export default nextConfig;
