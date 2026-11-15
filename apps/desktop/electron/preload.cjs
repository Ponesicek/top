// What the page can't do itself: zoom the whole window, as a browser's Ctrl+/Ctrl- does (sharp text,
// real layout sizes), for the "Interface size" setting; ask the computer's Tailscale where Top
// daemons are on the tailnet (see main.js); and the app's own updates (see updates.js).
// CommonJS: sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

/** @type {import("../src/bridge.ts").TopDesktop} */
const topDesktop = {
  setZoomFactor: (factor) => {
    if (typeof factor === "number" && factor >= 0.5 && factor <= 3) webFrame.setZoomFactor(factor);
  },
  findTailnetDaemons: () => ipcRenderer.invoke("top:tailnet"),
  updates: {
    state: () => ipcRenderer.invoke("top:updates:state"),
    check: () => ipcRenderer.invoke("top:updates:check"),
    install: () => ipcRenderer.invoke("top:updates:install"),
    setChannel: (channel) => ipcRenderer.invoke("top:updates:channel", channel),
    onChange: (listener) => {
      /** @param {unknown} _event @param {unknown} state */
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("top:updates:changed", handler);
      return () => ipcRenderer.off("top:updates:changed", handler);
    },
  },
};
contextBridge.exposeInMainWorld("topDesktop", topDesktop);
