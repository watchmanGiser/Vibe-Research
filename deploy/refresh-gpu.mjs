const response = await fetch("http://127.0.0.1:8092/fetch", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.VRA_API_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ endpoint: "gpu_rent_thermometer", refresh: true }),
});
const body = await response.text();
if (!response.ok) throw new Error(`GPU 增量更新失败 HTTP ${response.status}: ${body.slice(0, 240)}`);
const result = JSON.parse(body);
const envelope = result.envelope ?? {};
console.log(JSON.stringify({ status: envelope.status, fetched_at: result.fetched_at, cached: result.cached, degraded: envelope.extra?.degraded ?? null }));
