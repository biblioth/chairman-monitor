const ingestUrl = process.env.CHAIRMAN_INGEST_URL;
const adminToken = process.env.CHAIRMAN_ADMIN_TOKEN;
const encoded = process.env.CHAIRMAN_PAYLOAD_B64;
if (!ingestUrl || !adminToken || !encoded) {
  throw new Error("CHAIRMAN_INGEST_URL, CHAIRMAN_ADMIN_TOKEN and CHAIRMAN_PAYLOAD_B64 are required");
}

let payload;
try {
  payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
} catch {
  throw new Error("Invalid base64url probe payload");
}

const response = await fetch(ingestUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30_000),
});
const text = await response.text();
if (!response.ok) throw new Error(`Worker ingestion returned HTTP ${response.status}: ${text.slice(0, 500)}`);
console.log(text);
