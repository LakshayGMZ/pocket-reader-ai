import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  assetsInclude: ["**/*.wasm"],
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@runanywhere/web-llamacpp", "@runanywhere/web-onnx"],
  },
});
