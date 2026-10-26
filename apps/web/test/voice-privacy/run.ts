// @effect-diagnostics nodeBuiltinImport:off - a standalone Node runner that builds, serves and spawns browsers.
/**
 * Builds the voice privacy harness, serves it on 127.0.0.1, runs it in Playwright Chromium and
 * in the repo's Electron (both with fake media), scans all captured payloads for the B nonce,
 * and writes results to /tmp/t3-voice-privacy-egress/. Exits non-zero on any failed case.
 *
 *   node apps/web/test/voice-privacy/run.ts [--chromium-only|--electron-only]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const here = import.meta.dirname;
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'";
// Every request the keyword detector path may make; anything else under voice/kws is a finding.
const KEYWORD_ASSETS =
  /\/voice\/kws\/(kws\.worker\.js|capture\.worklet\.js|manifest\.json|vendor\/[\w.-]+)$/;
const webDir = NodePath.resolve(here, "../..");
const out = process.env.VOICE_PRIVACY_ARTIFACTS ?? "/tmp/t3-voice-privacy-egress";
const dist = NodePath.join(out, "dist");
const only = process.argv[2];
NodeFS.mkdirSync(out, { recursive: true });

NodeChildProcess.execFileSync(
  NodePath.join(webDir, "node_modules/.bin/vp"),
  ["build", "--config", NodePath.join(here, "vite.config.ts")],
  { cwd: webDir, stdio: "inherit", env: { ...process.env, VOICE_PRIVACY_OUT: dist } },
);

const server = NodeHttp.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const file = NodePath.join(dist, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(dist) || !NodeFS.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  const type = file.endsWith(".js")
    ? "text/javascript"
    : file.endsWith(".html")
      ? "text/html"
      : "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type };
  // Same worker-only policy as apps/desktop/src/electron/ElectronProtocol.ts.
  if (pathname.endsWith("/voice/kws/kws.worker.js"))
    headers["content-security-policy"] = WORKER_CSP;
  response.writeHead(200, headers).end(NodeFS.readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("no server address");
const origin = `http://127.0.0.1:${address.port}`;
const pageUrl = `${origin}/index.html`;

interface Report {
  readonly nonce?: string;
  readonly error?: string;
  readonly cases?: Array<{
    name: string;
    ok: boolean;
    error?: string;
    checks: Array<{ name: string; ok: boolean }>;
  }>;
  readonly egress?: Array<{ kind: string; data: string }>;
}

function nonceFindings(report: Report, extra: Array<string>) {
  if (!report.nonce) return ["no nonce reported"];
  const haystacks = [
    ...(report.egress ?? []).map((entry) => `${entry.kind}: ${entry.data}`),
    ...extra,
  ];
  return haystacks.filter((value) => value.includes(report.nonce!));
}

async function runChromium() {
  const require = NodeModule.createRequire(
    NodeModule.createRequire(NodePath.join(webDir, "package.json")).resolve(
      "vite-plus/package.json",
    ),
  );
  const { chromium } = require("playwright") as typeof import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const requests: Array<string> = [];
  const consoleMessages: Array<string> = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.exposeFunction("voicePrivacyPressTrusted", async () => {
    await page.keyboard.press("ControlOrMeta+Alt+KeyM");
  });
  await page.goto(pageUrl);
  const report: Report = await page.evaluate(() => window.voicePrivacy!.runAll());
  const version = browser.version();
  await browser.close();
  return { browser: `Chromium ${version}`, requests, consoleMessages, ...report };
}

async function runElectron() {
  const require = NodeModule.createRequire(NodePath.resolve(webDir, "../desktop/package.json"));
  const binary: unknown = require("electron");
  if (typeof binary !== "string") throw new Error("electron package did not return a binary path");
  const output = NodePath.join(out, "electron-raw.json");
  NodeFS.rmSync(output, { force: true });
  // Async so this process keeps serving the harness page while Electron runs.
  const child = NodeChildProcess.spawn(
    binary,
    [NodePath.join(here, "electron-main.cjs"), pageUrl, output],
    {
      stdio: "inherit",
      // A parent running inside Electron may export this, which would start the binary as Node.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
      ),
    },
  );
  const timer = setTimeout(() => child.kill(), 600_000);
  await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timer);
  if (!NodeFS.existsSync(output)) return { error: "Electron produced no result" };
  const report: Report & { requests: Array<string>; consoleMessages: Array<string> } = JSON.parse(
    NodeFS.readFileSync(output, "utf8"),
  );
  return report;
}

const results: Record<string, unknown> = {};
let failed = false;
const runs: Array<
  [string, () => Promise<Report & { requests?: Array<string>; consoleMessages?: Array<string> }>]
> = [];
if (only !== "--electron-only") runs.push(["chromium", runChromium]);
if (only !== "--chromium-only") runs.push(["electron", runElectron]);
for (const [name, run] of runs) {
  const report = await run();
  const foreign = (report.requests ?? []).filter((url) => !url.startsWith(origin));
  const findings = nonceFindings(report, report.consoleMessages ?? []);
  const keywordRequests = (report.requests ?? []).filter((url) => url.includes("/voice/kws/"));
  const unexpectedKeyword = keywordRequests.filter((url) => !KEYWORD_ASSETS.test(url));
  results[name] = {
    ...report,
    foreignRequests: foreign,
    nonceFindings: findings,
    keywordRequests,
  };
  console.log(`\n== ${name} ==`);
  if (report.error) console.log(`ERROR ${report.error}`);
  const informational = (title: string) => title.includes("(measurement)");
  for (const result of report.cases ?? []) {
    const label = result.ok ? "PASS" : informational(result.name) ? "INFO" : "FAIL";
    console.log(`${label} ${result.name}${result.error ? ` (${result.error})` : ""}`);
    for (const check of result.checks) if (!check.ok) console.log(`     x ${check.name}`);
  }
  console.log(
    `${foreign.length === 0 ? "PASS" : "FAIL"} no requests outside the harness origin (${report.requests?.length ?? 0} total)`,
  );
  console.log(
    `${unexpectedKeyword.length === 0 && keywordRequests.length > 0 ? "PASS" : "FAIL"} keyword path requested only its pinned assets (${keywordRequests.length} requests)`,
  );
  console.log(
    `${findings.length === 0 ? "PASS" : "FAIL"} B nonce absent from ${report.egress?.length ?? 0} captured payloads and console`,
  );
  if (
    report.error ||
    foreign.length > 0 ||
    findings.length > 0 ||
    unexpectedKeyword.length > 0 ||
    keywordRequests.length === 0 ||
    (report.cases ?? []).some((result) => !result.ok && !informational(result.name)) ||
    (report.cases ?? []).length === 0
  )
    failed = true;
}
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nresults: ${NodePath.join(out, "results.json")}`);
server.close();
process.exit(failed ? 1 : 0);
