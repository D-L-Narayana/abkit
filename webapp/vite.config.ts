import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    target: "es2022",
    // Never inline assets as data: URLs. The production Content-Security-Policy allows fonts only from 'self'
    // (font-src 'self'); an inlined woff2 (small subsets fall under Vite's default 4 kB threshold) would be blocked.
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: { vendor: ["react", "react-dom", "react-router-dom"], charts: ["recharts"] } } },
  },
});
