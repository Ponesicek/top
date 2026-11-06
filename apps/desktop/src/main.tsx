import "./perf.ts";
import "./scale.ts";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
