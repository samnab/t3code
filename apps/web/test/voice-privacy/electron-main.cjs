// Runs the harness page in the repo's Electron with fake media. Usage:
// electron electron-main.cjs <harness-url> <output-json>
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [url, output] = process.argv.slice(-2);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Never touch the developer's real Electron profile.
app.setPath("userData", path.join(path.dirname(output), "electron-profile"));

// The shipped renderer's policy (apps/desktop/src/electron/ElectronProtocol.ts), without Clerk.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  "connect-src 'self' blob: http: https: ws: wss:",
  "img-src 'self' t3: blob: data: http: https:",
  "media-src 'self' t3: blob: http: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' t3: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: http: https:",
  "object-src 'self' blob: http: https:",
  "form-action 'self'",
].join("; ");

const workerCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'";

app.whenReady().then(async () => {
  const requests = [];
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === "media"),
  );
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    requests.push(details.url);
    callback({});
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // As ElectronProtocol.ts: the keyword worker gets its own no-network policy.
    const policy = details.url.endsWith("/voice/kws/kws.worker.js") ? workerCsp : csp;
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.cjs"),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  const consoleMessages = [];
  window.webContents.on("console-message", (event) => consoleMessages.push(event.message));
  require("electron").ipcMain.handle("press-trusted", async () => {
    const mod = require("node:os").platform() === "darwin" ? "meta" : "control";
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "M", modifiers: [mod, "alt"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "M", modifiers: [mod, "alt"] });
  });
  let result;
  try {
    await window.loadURL(url);
    window.webContents.focus();
    result = await window.webContents.executeJavaScript("window.voicePrivacy.runAll()");
  } catch (error) {
    result = { error: String(error) };
  }
  fs.writeFileSync(
    output,
    JSON.stringify(
      { versions: process.versions, csp, requests, consoleMessages, ...result },
      null,
      2,
    ),
  );
  app.quit();
});
