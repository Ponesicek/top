import "./perf.ts";
import "./scale.ts";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { RegistryContext } from "@effect/atom-react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { desktop } from "./bridge.ts";
import { registry } from "./top.ts";

// macOS draws the window's close/minimize/zoom buttons over the page's top-left corner: the sidebar leaves room.
if (desktop && navigator.userAgent.includes("Mac")) document.documentElement.dataset.macWindow = "";

createRoot(document.getElementById("root")!).render(
  <RegistryContext.Provider value={registry}>
    <App />
  </RegistryContext.Provider>,
);
