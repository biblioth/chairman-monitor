import { fetchChairmanAvailability } from "../src/probe.js";

const ingestUrl = process.env.CHAIRMAN_INGEST_URL;
const adminToken = process.env.CHAIRMAN_ADMIN_TOKEN;
if (!ingestUrl || !adminToken) throw new Error("CHAIRMAN_INGEST_URL and CHAIRMAN_ADMIN_TOKEN are required");

const env = {
  CHAIRMAN_QUEUE_URL: process.env.CHAIRMAN_QUEUE_URL,
  CHAIRMAN_BOOKING_URL: process.env.CHAIRMAN_BOOKING_URL,
  CHAIRMAN_TARGET_DATES: process.env.CHAIRMAN_TARGET_DATES || "2026-10-30,2026-10-31,2026-11-01",
  CHAIRMAN_MEAL_WINDOWS: process.env.CHAIRMAN_MEAL_WINDOWS || "lunch,dinner",
  CHAIRMAN_PARTY_SIZE: process.env.CHAIRMAN_PARTY_SIZE || "2",
  CHAIRMAN_FETCH_TIMEOUT_MS: process.env.CHAIRMAN_FETCH_TIMEOUT_MS || "45000",
};

const observedAt = new Date().toISOString();
let outcome;
try {
  outcome = await fetchChairmanAvailability(env);
} catch (error) {
  outcome = {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    targetDates: env.CHAIRMAN_TARGET_DATES.split(","),
    mealWindows: env.CHAIRMAN_MEAL_WINDOWS.split(","),
    partySize: Number(env.CHAIRMAN_PARTY_SIZE),
    observations: [],
    available: [],
    sourceUrl: env.CHAIRMAN_QUEUE_URL || "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys",
  };
}

const probeId = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || "1"}`
  : crypto.randomUUID();
const response = await fetch(ingestUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ probeId, observedAt, outcome }),
  signal: AbortSignal.timeout(30_000),
});
const responseText = await response.text();
if (!response.ok) throw new Error(`Worker ingestion returned HTTP ${response.status}: ${responseText.slice(0, 500)}`);
console.log(JSON.stringify({
  probeId,
  observedAt,
  sourceStatus: outcome.status,
  httpStatus: outcome.httpStatus || null,
  pageTitle: outcome.pageTitle || null,
  pageBytes: outcome.pageBytes || null,
  pagePreview: outcome.pagePreview || null,
  available: (outcome.available || []).map((slot) => slot.key),
  worker: JSON.parse(responseText),
}, null, 2));

