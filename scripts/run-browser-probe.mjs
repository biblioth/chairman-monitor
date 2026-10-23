import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseChairmanAvailability } from "../src/parser.js";

const exec = promisify(execFile);
const queueUrl = "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";
const chrome = process.env.CHAIRMAN_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = process.env.CHAIRMAN_CHROME_PROFILE
  || join(homedir(), "Library", "Application Support", "Chairman Monitor Chrome");
const gh = process.env.CHAIRMAN_GH_PATH || "/opt/homebrew/bin/gh";
const targetDates = (process.env.CHAIRMAN_TARGET_DATES || "2026-10-30,2026-10-31,2026-11-01").split(",");
const mealWindows = (process.env.CHAIRMAN_MEAL_WINDOWS || "lunch,dinner").split(",");
const partySize = Number(process.env.CHAIRMAN_PARTY_SIZE || 2);

function titleFromHtml(html) {
  return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
}

let outcome;
try {
  const { stdout } = await exec(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=15000",
    "--dump-dom",
    queueUrl,
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const pageTitle = titleFromHtml(stdout);
  const pageBytes = Buffer.byteLength(stdout);
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
      sourceUrl: queueUrl,
    };
  } else {
    outcome = {
      ...parseChairmanAvailability(stdout, { targetDates, mealWindows, partySize, sourceUrl: queueUrl }),
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
  probeId: `local-browser:${Math.floor(Date.now() / 300_000)}`,
  observedAt,
  outcome,
};
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
await exec(gh, [
  "workflow", "run", "ingest-local.yml",
  "--repo", "biblioth/chairman-monitor",
  "--field", `payload=${encoded}`,
], { timeout: 30_000, maxBuffer: 1024 * 1024 });
console.log(JSON.stringify({ observedAt, status: outcome.status, pageTitle: outcome.pageTitle || null, relayed: true }));
