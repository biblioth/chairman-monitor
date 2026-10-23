# The Chairman availability monitor

Independent monitor for The Chairman (大班楼) reservations.

## Target

- Dates: 2026-10-30, 2026-10-31, 2026-11-01
- Party size: 2
- Meals: lunch and dinner
- Notifications: Feishu and PushPlus (WeChat + Clawbot)

## Architecture

The restaurant started returning `HTTP 405 Human Verification` to Cloudflare Worker and GitHub
hosted egress on 2026-10-14. The response is an interactive AWS WAF CAPTCHA, so it is never
treated as “no availability” and is not bypassed automatically. The monitor separates retrieval
from durable state and notifications:

1. A browser probe with a user-verified, dedicated Chrome profile follows the official Queue-it flow.
2. The probe parses the booking page and posts a signed result to the standalone Worker.
3. The Worker deduplicates state in D1 and sends events through a Cloudflare Queue.
4. A minute cron detects a stalled browser probe and raises a degraded alert.

The GitHub workflow remains available for manual network diagnostics, but is intentionally not
scheduled because datacenter runners are challenged by the restaurant's AWS WAF.

The parser fails closed: verification pages, unexpected markup, and network errors never become
false “no availability” results.

## Endpoints

- `GET /health` — public health and current availability state
- `POST /ingest` — authenticated probe ingestion
- `POST /sweep` — authenticated health/queue sweep

## Local verification

```bash
npm ci
npm test
npm run check
```

## Human verification recovery

The scheduled probe uses a visible, off-screen Chrome session with a dedicated profile at
`~/Library/Application Support/Chairman Monitor Chrome`. AWS WAF blocks headless and datacenter
browsers, so the monitor keeps this separate debugging session and one booking tab alive. Scheduled
checks call the booking page's own `catering/booking/reload` JSON endpoint inside that verified tab;
they do not reload the document and therefore do not normally restart the CAPTCHA flow. When AWS WAF
eventually challenges a restarted or expired profile, bring that dedicated Chrome window on screen
once and complete the CAPTCHA manually. `launchd/com.biblioth.chairman-monitor.plist` reads the
verified session every five minutes and relays the result through GitHub Actions to the Worker.

For macOS privacy isolation, the LaunchAgent executes a runtime copy installed under
`~/Library/Application Support/Chairman Monitor Runtime`; the Git repository remains independent
under `~/Downloads/Chairman Monitor`.

## Stop time

The monitor stops at `2026-11-01 16:00 Asia/Shanghai` (`2026-11-01T08:00:00Z`). At that time the
local probe disables and unloads its LaunchAgent and closes only the dedicated Chairman Chrome
session. The Worker also stops freshness alerts and reports the monitor as inactive.

