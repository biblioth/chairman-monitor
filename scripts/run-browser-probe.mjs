import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseChairmanAvailability } from "../src/parser.js";

const exec = promisify(execFile);
const queueUrl = "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";
const cdpOrigin = process.env.CHAIRMAN_CDP_ORIGIN || "http://127.0.0.1:9223";
const profile = process.env.CHAIRMAN_CHROME_PROFILE
  || join(homedir(), "Library", "Application Support", "Chairman Monitor Chrome");
const gh = process.env.CHAIRMAN_GH_PATH || "/opt/homebrew/bin/gh";
const targetDates = (process.env.CHAIRMAN_TARGET_DATES || "2026-10-30,2026-10-31,2026-11-01").split(",");
const mealWindows = (process.env.CHAIRMAN_MEAL_WINDOWS || "lunch,dinner").split(",");
const partySize = Number(process.env.CHAIRMAN_PARTY_SIZE || 2);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function chromeReady() {
  try {
    const response = await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureChrome() {
  if (await chromeReady()) return;

  await exec("/usr/bin/open", [
    "-gj", "-na", "Google Chrome", "--args",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=9223",
    "--remote-allow-origins=http://127.0.0.1:9223",
    "--window-position=-10000,-10000",
    "--window-size=800,600",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ], { timeout: 15_000 });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await chromeReady()) return;
    await delay(500);
  }
  throw new Error("Dedicated Chrome session did not expose its debugging endpoint");
}

async function createTarget(url) {
  const response = await fetch(`${cdpOrigin}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create browser target (HTTP ${response.status})`);
  return response.json();
}

async function existingMonitorTarget() {
  const response = await fetch(`${cdpOrigin}/json/list`);
  if (!response.ok) throw new Error(`Could not list browser targets (HTTP ${response.status})`);
  const targets = await response.json();
  return targets.find((candidate) => candidate.type === "page"
    && (/thechairmangroup/i.test(candidate.url || "")
      || /human verification/i.test(candidate.title || ""))) || null;
}

async function inspectTarget(target, { newlyCreated = false } = {}) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to dedicated Chrome")), { once: true });
  });

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await command("Page.enable");

  const readPage = async () => {
    const result = await command("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        url: location.href,
        html: document.documentElement?.outerHTML || "",
        lastParsedAt: sessionStorage.getItem("chairman-monitor-last-parsed")
      })`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  };

  await delay(newlyCreated ? 6_000 : 1_000);
  let page = await readPage();
  if (/human verification|request could not be satisfied/i.test(page.title || "")) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(1_000);
      page = await readPage();
      if (!/human verification|request could not be satisfied/i.test(page.title || "")) break;
    }
  }
  if (/human verification|request could not be satisfied/i.test(page.title || "")) {
    await command("Runtime.evaluate", {
      expression: `sessionStorage.removeItem("chairman-monitor-last-parsed")`,
    });
    socket.close();
    return page;
  }

  const lastParsedAt = Date.parse(page.lastParsedAt || "");
  if (!newlyCreated && Number.isFinite(lastParsedAt) && Date.now() - lastParsedAt >= 240_000) {
    await command("Page.reload", { ignoreCache: false });
    await delay(6_000);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    page = await readPage();
    if (/the chairman reservation/i.test(page.title)
      || /human verification|request could not be satisfied/i.test(page.title)) break;
    await delay(1_500);
  }

  if (/the chairman reservation/i.test(page.title || "")) {
    await command("Runtime.evaluate", {
      expression: `sessionStorage.setItem("chairman-monitor-last-parsed", ${JSON.stringify(new Date().toISOString())})`,
    });
  }
  socket.close();
  return page;
}

let target;
let outcome;
try {
  await ensureChrome();
  target = await existingMonitorTarget();
  const newlyCreated = !target;
  if (!target) target = await createTarget(queueUrl);
  const page = await inspectTarget(target, { newlyCreated });
  const pageTitle = page?.title || null;
  const pageBytes = Buffer.byteLength(page?.html || "");

  if (/human verification|request could not be satisfied/i.test(pageTitle || "")) {
    outcome = {
      status: "error",
      error: `Dedicated browser profile requires human verification (${pageTitle})`,
      pageTitle,
      pageBytes,
      targetDates,
      mealWindows,
      partySize,
      observations: [],
      available: [],
      sourceUrl: page?.url || queueUrl,
    };
  } else {
    outcome = {
      ...parseChairmanAvailability(page?.html || "", {
        targetDates,
        mealWindows,
        partySize,
        sourceUrl: page?.url || queueUrl,
      }),
      pageTitle,
      pageBytes,
    };
  }
} catch (error) {
  outcome = {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    targetDates,
    mealWindows,
    partySize,
    observations: [],
    available: [],
    sourceUrl: queueUrl,
  };
}

const observedAt = new Date().toISOString();
const payload = {
  probeId: `local-browser:${Date.now()}`,
  observedAt,
  outcome,
};
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
await exec(gh, [
  "workflow", "run", "ingest-local.yml",
  "--repo", "biblioth/chairman-monitor",
  "--field", `payload=${encoded}`,
], { timeout: 30_000, maxBuffer: 1024 * 1024 });

console.log(JSON.stringify({
  observedAt,
  status: outcome.status,
  pageTitle: outcome.pageTitle || null,
  pageBytes: outcome.pageBytes || 0,
  available: outcome.available || [],
  error: outcome.error || null,
  relayed: true,
}));
