// 验证：query 长 token + Bearer 短 token 头 同时存在时服务端的行为
const TOKEN = process.argv[2] ?? "";

async function main() {
  const r = await fetch(`https://api.cesium.com/v1/assets/1/endpoint?access_token=${TOKEN}`);
  if (!r.ok) return console.log("endpoint exchange failed:", r.status);
  const { url, accessToken: short } = await r.json();
  const base = url.replace(/\/$/, "");

  const combos = [
    ["query=short", `${base}/layer.json?access_token=${short}`, {}],
    ["query=long + Bearer short", `${base}/layer.json?access_token=${TOKEN}`, { Authorization: `Bearer ${short}` }],
    ["query=long only", `${base}/layer.json?access_token=${TOKEN}`, {}],
    ["Bearer short only", `${base}/layer.json`, { Authorization: `Bearer ${short}` }],
  ];
  for (const [label, u, headers] of combos) {
    const res = await fetch(u, { headers });
    console.log(`${label}: HTTP ${res.status}`);
    if (res.status !== 200) {
      try {
        const body = await res.json();
        console.log("  body:", JSON.stringify(body).slice(0, 160));
      } catch { /* ignore */ }
    }
  }
}

main().catch((e) => console.error("FAIL:", e));
