import test from "node:test";
import assert from "node:assert/strict";
import { configuredChannels, renderEvent } from "../src/notifications.js";

test("availability notification contains target date, meal, time and official link", () => {
  const rendered = renderEvent({
    type: "chairman_availability",
    payload: {
      partySize: 2,
      sourceUrl: "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys",
      available: [{ date: "2026-10-30", mealWindow: "lunch", times: ["12:30"], dateLevel: false }],
    },
  });
  assert.match(rendered.title, /大班楼/);
  assert.match(rendered.message, /2026-10-30/);
  assert.match(rendered.message, /午餐/);
  assert.match(rendered.message, /12:30/);
  assert.match(rendered.message, /queue-it\.net/);
});

test("notification channels are independent and deduplicated", () => {
  assert.deepEqual(configuredChannels({
    FEISHU_WEBHOOK_URL: "https://example.com/feishu",
    PUSHPLUS_TOKEN: "token",
    PUSHPLUS_CHANNELS: "wechat,wechat,clawbot",
  }), ["feishu", "pushplus", "pushplus:clawbot"]);
});

