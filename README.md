# The Chairman availability monitor

Independent monitor for The Chairman (大班楼) reservations.

## Target

- Dates: 2026-10-30, 2026-10-31, 2026-11-01
- Party size: 2
- Meals: lunch and dinner
- Notifications: Feishu and PushPlus (WeChat + Clawbot)

## Architecture

The restaurant started returning `HTTP 405 Human Verification` to Cloudflare Worker egress on
2026-10-14. A local/GitHub-hosted probe still receives the normal booking page. The monitor
therefore separates public-page retrieval from durable state and notifications:

1. GitHub Actions follows the official Queue-it flow every five minutes.
2. The probe parses the booking page and posts a signed result to the standalone Worker.
3. The Worker deduplicates state in D1 and sends events through a Cloudflare Queue.
4. A minute cron detects a stalled GitHub probe and raises a degraded alert.

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

