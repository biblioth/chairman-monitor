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

The scheduled probe uses a dedicated Chrome profile at
`~/Library/Application Support/Chairman Monitor Chrome`. When AWS WAF challenges that profile,
open the official booking flow once with that profile, complete the CAPTCHA manually, then close
the dedicated window. `launchd/com.biblioth.chairman-monitor.plist` runs the verified profile every
five minutes and relays the result through GitHub Actions to the Worker.

