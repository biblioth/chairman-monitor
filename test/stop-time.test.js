import test from "node:test";
import assert from "node:assert/strict";

import { monitoringWindow } from "../src/index.js";
import { ensureFreshnessEvent } from "../src/state.js";

const env = { STOP_AT: "2026-11-01T08:00:00.000Z" };

test("monitor remains active until 16:00 Beijing time on November 1", () => {
  assert.equal(monitoringWindow(env, new Date("2026-11-01T07:59:59.999Z")).active, true);
  assert.equal(monitoringWindow(env, new Date("2026-11-01T08:00:00.000Z")).active, false);
  assert.equal(monitoringWindow(env, new Date("2026-11-01T08:00:00.000Z")).stopsAt, "2026-11-01T08:00:00.000Z");
});

test("freshness sweep exits before touching storage after stop time", async () => {
  const result = await ensureFreshnessEvent({
    STOP_AT: env.STOP_AT,
    get DB() { throw new Error("DB should not be read after the stop time"); },
  }, new Date("2026-11-01T08:00:00.000Z"));
  assert.equal(result, null);
});
