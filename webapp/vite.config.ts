import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react(), tailwindcss()], build: { outDir: "dist", target: "es2022", rollupOptions: { output: { manualChunks: { vendor: ["react", "react-dom", "react-router-dom"], charts: ["recharts"] } } } } });
