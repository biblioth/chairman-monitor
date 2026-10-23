import { configuredChannels, sendEvent } from "./notifications.js";
import { ensureFreshnessEvent, getDelivery, getState, markDelivered, markFailed, markQueued, pendingDeliveries, recordProbe } from "./state.js";

function authorized(request, env) {
  return Boolean(env.ADMIN_TOKEN) && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

function validOutcome(value) {
  return value && ["available", "unavailable", "unknown", "busy", "error"].includes(value.status)
    && Array.isArray(value.observations || []) && Array.isArray(value.available || []);
}

async function enqueuePending(env) {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  let count = 0;
  for (const row of await pendingDeliveries(env.DB, staleBefore)) {
    await env.NOTIFICATION_QUEUE.send({ deliveryId: row.id });
    await markQueued(env.DB, row.id, now);
    count += 1;
  }
  return count;
}

async function health(env) {
  const state = await getState(env.DB);
  const ageMs = state?.last_checked_at ? Date.now() - new Date(state.last_checked_at).getTime() : null;
  const ok = Number.isFinite(ageMs) && ageMs < Number(env.STALE_AFTER_MINUTES || 15) * 60_000
    && !["error", "unknown", "stale"].includes(state?.source_status);
  return Response.json({
    ok,
    architecture: "GitHub probe -> Cloudflare Worker -> D1/Queue -> Feishu + PushPlus",
    target: { dates: String(env.TARGET_DATES || "").split(",").filter(Boolean), partySize: Number(env.PARTY_SIZE || 2), mealWindows: String(env.MEAL_WINDOWS || "lunch,dinner").split(",") },
    state: state ? {
      status: state.current_status, sourceStatus: state.source_status,
      availableKeys: JSON.parse(state.available_keys_json || "[]"), observations: JSON.parse(state.observations_json || "[]"),
      bookingUrl: state.booking_url, lastSuccessAt: state.last_success_at, lastCheckedAt: state.last_checked_at,
      consecutiveFailures: state.consecutive_failures, lastError: state.last_error,
    } : null,
    scheduler: { ok: Number.isFinite(ageMs) && ageMs < Number(env.STALE_AFTER_MINUTES || 15) * 60_000, ageMs },
    channels: configuredChannels(env),
  }, { status: ok ? 200 : 503 });
}

async function processQueue(batch, env) {
  for (const message of batch.messages) {
    const delivery = await getDelivery(env.DB, message.body?.deliveryId);
    if (!delivery || delivery.status === "delivered") { message.ack(); continue; }
    try {
      await sendEvent(env, delivery.event, delivery.channel);
      await markDelivered(env.DB, delivery.id, new Date().toISOString());
      message.ack();
    } catch (error) {
      await markFailed(env.DB, delivery.id, error instanceof Error ? error.message : String(error), new Date().toISOString());
      message.retry();
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return Response.json({ service: "The Chairman availability monitor", health: "/health", targetDates: String(env.TARGET_DATES || "").split(",") });
    if (request.method === "GET" && url.pathname === "/health") return health(env);
    if (request.method === "POST" && url.pathname === "/ingest") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (!body?.probeId || !validOutcome(body.outcome)) return new Response("Invalid probe result", { status: 400 });
      const result = await recordProbe(env, body.probeId, body.outcome, body.observedAt || new Date().toISOString());
      return Response.json({ ...result, queued: await enqueuePending(env) });
    }
    if (request.method === "POST" && url.pathname === "/sweep") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      return Response.json({ freshnessEventId: await ensureFreshnessEvent(env), queued: await enqueuePending(env) });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller, env) {
    await ensureFreshnessEvent(env);
    await enqueuePending(env);
  },
  async queue(batch, env) { await processQueue(batch, env); },
};
