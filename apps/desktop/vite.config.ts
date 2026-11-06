import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Production builds get a strict CSP; dev skips it because React Refresh injects an inline script. */
function csp(): Plugin {
  return {
    name: "top-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<!--csp-->",
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ws: wss:">`,
      ),
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), csp()],
  server: { port: 5199, strictPort: true },
  build: { target: "chrome140", outDir: "dist", sourcemap: true },
});
