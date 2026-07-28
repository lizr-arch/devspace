import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/webgpt-test"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/webgpt-test-host.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
