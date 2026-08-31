import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const frontendBuildId = process.env.PI_VIDEO_FRONTEND_BUILD_ID ?? `${Date.now().toString(36)}`;

export default defineConfig({
  define: {
    __FRONTEND_BUILD_ID__: JSON.stringify(frontendBuildId),
  },
  plugins: [
    react(),
    {
      name: "clip-studio-build-id",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build-id.txt", source: `${frontendBuildId}\n` });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
