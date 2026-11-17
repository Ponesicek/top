import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function csp(): Plugin {
  return {
    name: "top-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<!--csp-->",
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: http: https:; media-src http: https:; frame-src http: https:; connect-src ws: wss: http: https:">`,
      ),
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), csp()],
  server: { port: 5199, strictPort: true },
  build: { target: "chrome140", outDir: "dist", sourcemap: true },
});
