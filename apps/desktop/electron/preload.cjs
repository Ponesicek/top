// The one thing the page can't do itself: zoom the whole window, as a browser's Ctrl+/Ctrl- does
// (sharp text, real layout sizes), for the "Interface size" setting. CommonJS: sandboxed preloads
// can't be ES modules.
const { contextBridge, webFrame } = require("electron");

contextBridge.exposeInMainWorld("topDesktop", {
  setZoomFactor: (factor) => {
    if (typeof factor === "number" && factor >= 0.5 && factor <= 3) webFrame.setZoomFactor(factor);
  },
});
