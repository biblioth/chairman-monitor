function configuredPushPlusChannels(env) {
  if (!env.PUSHPLUS_TOKEN) return [];
  return [...new Set(String(env.PUSHPLUS_CHANNELS || "wechat")
    .split(",").map((value) => value.trim().toLowerCase())
    .filter((value) => ["wechat", "clawbot"].includes(value)))]
    .map((value) => value === "wechat" ? "pushplus" : `pushplus:${value}`);
}

export function configuredChannels(env) {
  return [env.FEISHU_WEBHOOK_URL ? "feishu" : null, ...configuredPushPlusChannels(env)].filter(Boolean);
}

function truncate(value, length = 700) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function renderEvent(event) {
  const payload = event.payload || {};
  if (event.type === "chairman_availability") {
    const mealName = { lunch: "午餐", dinner: "晚餐" };
    const lines = [`🎉 大班楼有位置了（${payload.partySize || 2} 位）`];
    const dateLevelDates = new Set((payload.available || [])
      .filter((slot) => slot.dateLevel).map((slot) => slot.date));
    for (const date of dateLevelDates) lines.push(`日期：${date}｜午餐或晚餐至少一个时段可选`);
    for (const slot of (payload.available || []).filter((item) => !dateLevelDates.has(item.date))) {
      const times = slot.times?.length ? `｜时间：${slot.times.join("、")}` : "";
      lines.push(`日期：${slot.date}｜${mealName[slot.mealWindow] || slot.mealWindow}${times}`);
    }
    if (payload.sourceUrl) lines.push(`立即预订：${payload.sourceUrl}`);
    lines.push("座位随时可能被订走，请以官网最终结果为准。");
    return { title: "🎉 大班楼有位置了", message: lines.join("\n") };
  }
  if (event.type === "chairman_monitor_degraded") {
    return {
      title: "🚨 大班楼监控异常",
      message: [
        "🚨 大班楼监控连续无法确认房态",
        `连续失败：${payload.consecutiveFailures || "多"} 次`,
        `最后错误：${truncate(payload.error)}`,
        payload.pageTitle ? `页面标题：${payload.pageTitle}` : null,
        payload.httpStatus ? `HTTP：${payload.httpStatus}` : null,
      ].filter(Boolean).join("\n"),
    };
  }
  if (event.type === "chairman_monitor_recovered") {
    return {
      title: "✅ 大班楼监控已恢复",
      message: [
        "✅ 大班楼监控已恢复",
        `此前连续失败：${payload.previousFailures || 0} 次`,
        `当前状态：${payload.currentStatus === "available" ? "有位" : "暂无位置"}`,
      ].join("\n"),
    };
  }
  throw new Error(`Unsupported event type: ${event.type}`);
}

async function feishuSignature(secret, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function sendFeishu(env, message, fetcher) {
  const payload = { msg_type: "text", content: { text: message } };
  if (env.FEISHU_WEBHOOK_SECRET) {
    payload.timestamp = String(Math.floor(Date.now() / 1000));
    payload.sign = await feishuSignature(env.FEISHU_WEBHOOK_SECRET, payload.timestamp);
  }
  const response = await fetcher(env.FEISHU_WEBHOOK_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Feishu returned HTTP ${response.status}`);
  const result = await response.json();
  const code = result.code ?? result.StatusCode ?? 0;
  if (![0, "0", null].includes(code)) throw new Error(`Feishu rejected the message: ${code}`);
}

async function sendPushPlus(env, title, message, channel, fetcher) {
  const payload = { token: env.PUSHPLUS_TOKEN, title: title.slice(0, 80), content: message, template: "txt", channel };
  if (env.PUSHPLUS_TOPIC) payload.topic = env.PUSHPLUS_TOPIC;
  const response = await fetcher("https://www.pushplus.plus/send", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`PushPlus returned HTTP ${response.status}`);
  const result = await response.json();
  if (![200, "200"].includes(result.code)) throw new Error(`PushPlus rejected the message: ${result.code}`);
}

export async function sendEvent(env, event, channel, fetcher = fetch) {
  const rendered = renderEvent(event);
  if (channel === "feishu") return sendFeishu(env, rendered.message, fetcher);
  const apiChannel = channel === "pushplus" ? "wechat" : channel.startsWith("pushplus:") ? channel.slice(9) : null;
  if (apiChannel) return sendPushPlus(env, rendered.title, rendered.message, apiChannel, fetcher);
  throw new Error(`Unsupported notification channel: ${channel}`);
}
