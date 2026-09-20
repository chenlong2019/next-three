// 诊断：模拟浏览器跨域行为，检查 depot/api 的 CORS 支持
const TOKEN = process.argv[2] ?? "";

async function corsProbe(label, url, headers = {}) {
  // 1. 预检 OPTIONS
  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": Object.keys(headers).join(",") || "authorization",
    },
  }).catch((e) => ({ error: e.message }));
  let pf = "n/a";
  if (preflight.status !== undefined) {
    const acao = preflight.headers.get("access-control-allow-origin");
    const acam = preflight.headers.get("access-control-allow-headers");
    pf = `HTTP ${preflight.status}, ACAO=${acao}, allow-headers=${acam}`;
  } else {
    pf = `FETCH FAIL: ${preflight.error}`;
  }
  console.log(`[${label}] preflight: ${pf}`);

  // 2. 实际 GET（带 Origin + 指定头）
  const res = await fetch(url, {
    headers: { Origin: "http://localhost:3000", ...headers },
  }).catch((e) => ({ error: e.message }));
  if (res.status !== undefined) {
    const acao = res.headers.get("access-control-allow-origin");
    console.log(
      `[${label}] GET: HTTP ${res.status}, ACAO=${acao ?? "(无 CORS 头)"}`,
    );
  } else {
    console.log(`[${label}] GET: FETCH FAIL: ${res.error}`);
  }
}

async function main() {
  await corsProbe("api endpoint (GET, 无自定义头)", `https://api.cesium.com/v1/assets/1/endpoint?access_token=${TOKEN || "x"}`);

  // 先拿短期 token
  let short = "";
  if (TOKEN) {
    const r = await fetch(`https://api.cesium.com/v1/assets/1/endpoint?access_token=${TOKEN}`);
    if (r.ok) {
      const payload = (await r.json());
      short = payload.accessToken ?? "";
      const url = payload.url ?? "";
      console.log("resource url:", url);
      await corsProbe("depot GET 带 Authorization 头", `${url}/layer.json`, {
        Authorization: `Bearer ${short}`,
        Accept: "application/json",
      });
      await corsProbe("depot GET 带 query token（无自定义头）", `${url}/layer.json?access_token=${short}`);
    } else {
      console.log("endpoint exchange failed:", r.status);
    }
  }
}

main().catch((e) => console.error("FAIL:", e));
