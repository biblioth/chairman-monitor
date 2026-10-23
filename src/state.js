import { configuredChannels } from "./notifications.js";

const DEFAULT_QUEUE_URL = "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export async function getState(db) {
  return db.prepare("SELECT * FROM chairman_state WHERE id=1").first();
}

export function planTransition(previous, outcome, observedAt, failureThreshold = 3) {
  const prior = previous || {};
  const previousAvailable = new Set(parseJson(prior.available_keys_json, []));
  if (outcome.status === "busy") {
    return {
      state: {
        currentStatus: prior.current_status || "unknown", availableKeys: [...previousAvailable],
        observations: parseJson(prior.observations_json, []), bookingUrl: prior.booking_url || outcome.sourceUrl || DEFAULT_QUEUE_URL,
        lastSuccessAt: prior.last_success_at || null, lastCheckedAt: observedAt,
        consecutiveFailures: Number(prior.consecutive_failures || 0), failureStartedAt: prior.failure_started_at || null,
        lastError: outcome.error || null, sourceStatus: "busy",
      }, events: [],
    };
  }
  if (["error", "unknown"].includes(outcome.status)) {
    const failures = Number(prior.consecutive_failures || 0) + 1;
    const failureStartedAt = prior.failure_started_at || observedAt;
    return {
      state: {
        currentStatus: prior.current_status || "unknown", availableKeys: [...previousAvailable],
        observations: outcome.observations || parseJson(prior.observations_json, []),
        bookingUrl: prior.booking_url || outcome.sourceUrl || DEFAULT_QUEUE_URL,
        lastSuccessAt: prior.last_success_at || null, lastCheckedAt: observedAt,
        consecutiveFailures: failures, failureStartedAt,
        lastError: outcome.error || "Availability could not be determined", sourceStatus: outcome.status,
      },
      events: failures === Number(failureThreshold) ? [{
        type: "chairman_monitor_degraded", key: `chairman:degraded:${failureStartedAt}`,
        payload: { consecutiveFailures: failures, error: outcome.error, httpStatus: outcome.httpStatus || null, pageTitle: outcome.pageTitle || null },
      }] : [],
    };
  }
  const availableKeys = new Set((outcome.available || []).map((item) => item.key));
  const newlyAvailable = (outcome.available || []).filter((item) => !previousAvailable.has(item.key));
  const events = [];
  if (newlyAvailable.length) events.push({
    type: "chairman_availability",
    key: `chairman:availability:${newlyAvailable.map((item) => item.key).sort().join(",")}:${observedAt}`,
    payload: { partySize: outcome.partySize, available: newlyAvailable, sourceUrl: outcome.sourceUrl },
  });
  if (Number(prior.consecutive_failures || 0) >= Number(failureThreshold)) events.push({
    type: "chairman_monitor_recovered", key: `chairman:recovered:${prior.failure_started_at || observedAt}`,
    payload: { previousFailures: Number(prior.consecutive_failures || 0), currentStatus: outcome.status },
  });
  return {
    state: {
      currentStatus: outcome.status, availableKeys: [...availableKeys], observations: outcome.observations || [],
      bookingUrl: outcome.sourceUrl || DEFAULT_QUEUE_URL, lastSuccessAt: observedAt, lastCheckedAt: observedAt,
      consecutiveFailures: 0, failureStartedAt: null, lastError: null, sourceStatus: "ok",
    }, events,
  };
}

async function saveState(db, state, observedAt) {
  await db.prepare(`UPDATE chairman_state SET current_status=?, available_keys_json=?, observations_json=?, booking_url=?,
    last_success_at=?, last_checked_at=?, consecutive_failures=?, failure_started_at=?, last_error=?, source_status=?, updated_at=? WHERE id=1`)
    .bind(state.currentStatus, JSON.stringify(state.availableKeys), JSON.stringify(state.observations), state.bookingUrl,
      state.lastSuccessAt, state.lastCheckedAt, state.consecutiveFailures, state.failureStartedAt, state.lastError, state.sourceStatus, observedAt).run();
}

export async function createEvent(db, event, createdAt, channels) {
  const inserted = await db.prepare(`INSERT OR IGNORE INTO monitor_events(idempotency_key,event_type,payload_json,created_at) VALUES(?,?,?,?)`)
    .bind(event.key, event.type, JSON.stringify(event.payload), createdAt).run();
  const row = await db.prepare("SELECT id FROM monitor_events WHERE idempotency_key=?").bind(event.key).first();
  if (!row) return null;
  for (const channel of channels) await db.prepare(`INSERT OR IGNORE INTO monitor_deliveries(event_id,channel,status,created_at,updated_at) VALUES(?,?,'pending',?,?)`)
    .bind(row.id, channel, createdAt, createdAt).run();
  return inserted.meta?.changes ? row.id : null;
}

export async function recordProbe(env, probeId, outcome, observedAt = new Date().toISOString()) {
  const id = `probe:${String(probeId).slice(0, 200)}`;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO chairman_checks(id,observed_at,status,http_status,error,result_json) VALUES(?,?,?,?,?,?)`)
    .bind(id, observedAt, outcome.status, outcome.httpStatus || null, outcome.error || null, JSON.stringify({
      pageTitle: outcome.pageTitle || null, pageBytes: outcome.pageBytes || null,
      pageFingerprint: outcome.pageFingerprint || null, observations: outcome.observations || [], available: outcome.available || [],
    })).run();
  if (!inserted.meta?.changes) return { duplicate: true, checkId: id };
  const previous = await getState(env.DB);
  const transition = planTransition(previous, outcome, observedAt, Number(env.FAILURE_ALERT_THRESHOLD || 3));
  await saveState(env.DB, transition.state, observedAt);
  const eventIds = [];
  for (const event of transition.events) {
    const eventId = await createEvent(env.DB, event, observedAt, configuredChannels(env));
    if (eventId) eventIds.push(eventId);
  }
  return { duplicate: false, checkId: id, status: outcome.status, eventIds };
}

export async function ensureFreshnessEvent(env, now = new Date()) {
  const stopTime = Date.parse(String(env.STOP_AT || ""));
  if (Number.isFinite(stopTime) && now.getTime() >= stopTime) return null;
  const state = await getState(env.DB);
  const staleMs = Number(env.STALE_AFTER_MINUTES || 15) * 60_000;
  const last = state?.last_checked_at ? new Date(state.last_checked_at).getTime() : 0;
  if (now.getTime() - last <= staleMs || state?.source_status === "stale") return null;
  const threshold = Number(env.FAILURE_ALERT_THRESHOLD || 3);
  const failureStartedAt = state?.last_checked_at || now.toISOString();
  const next = {
    currentStatus: state?.current_status || "unknown", availableKeys: parseJson(state?.available_keys_json, []),
    observations: parseJson(state?.observations_json, []), bookingUrl: state?.booking_url || DEFAULT_QUEUE_URL,
    lastSuccessAt: state?.last_success_at || null, lastCheckedAt: state?.last_checked_at || null,
    consecutiveFailures: Math.max(threshold, Number(state?.consecutive_failures || 0)), failureStartedAt,
    lastError: `Probe stale: no ingestion for ${Math.round((now.getTime() - last) / 60_000)} minutes`, sourceStatus: "stale",
  };
  await saveState(env.DB, next, now.toISOString());
  return createEvent(env.DB, {
    type: "chairman_monitor_degraded", key: `chairman:stale:${failureStartedAt}`,
    payload: { consecutiveFailures: next.consecutiveFailures, error: next.lastError },
  }, now.toISOString(), configuredChannels(env));
}

export async function pendingDeliveries(db, staleBefore, limit = 20) {
  const result = await db.prepare(`SELECT id FROM monitor_deliveries WHERE status!='delivered' AND (queued_at IS NULL OR queued_at<?) ORDER BY id LIMIT ?`)
    .bind(staleBefore, limit).all();
  return result.results || [];
}
export async function markQueued(db, id, now) { await db.prepare("UPDATE monitor_deliveries SET status='queued',queued_at=?,updated_at=? WHERE id=?").bind(now, now, id).run(); }
export async function getDelivery(db, id) {
  const row = await db.prepare(`SELECT d.*,e.event_type,e.payload_json FROM monitor_deliveries d JOIN monitor_events e ON e.id=d.event_id WHERE d.id=?`).bind(id).first();
  return row ? { id: row.id, channel: row.channel, status: row.status, event: { type: row.event_type, payload: parseJson(row.payload_json, {}) } } : null;
}
export async function markDelivered(db, id, now) { await db.prepare("UPDATE monitor_deliveries SET status='delivered',attempts=attempts+1,delivered_at=?,last_error=NULL,updated_at=? WHERE id=?").bind(now, now, id).run(); }
export async function markFailed(db, id, error, now) { await db.prepare("UPDATE monitor_deliveries SET status='pending',attempts=attempts+1,last_error=?,updated_at=? WHERE id=?").bind(String(error).slice(0,1000), now, id).run(); }
