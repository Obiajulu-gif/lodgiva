import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Lodgiva Dashboard",
        short_name: "Lodgiva",
        description: "Hotel operations dashboard",
        theme_color: "#124434",
        background_color: "#faf9f6",
        display: "standalone",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      // Push handling is injected into the generated worker: the plugin owns
      // precaching, we only add the push listeners.
      injectManifest: undefined,
      workbox: {
        importScripts: ["/sw-push.js"],
        // §10.1: precache the app shell; never cache authenticated API data.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
});
