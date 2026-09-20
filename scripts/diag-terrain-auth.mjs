// 诊断脚本：token 从命令行参数传入，不落盘
const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("usage: node diag-terrain-auth.mjs <token>");
  process.exit(1);
}
const BASE =
  "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2";

async function tryFetch(label, url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.text();
  console.log(`${label}: ${res.status}`);
  if (res.status !== 200) console.log(`  body: ${body.slice(0, 200)}`);
  return body;
}

async function main() {
  // 0. ion 端点交换（CesiumJS 的标准流程）
  const ep = await tryFetch(
    "ion endpoint",
    `https://api.cesium.com/v1/assets/1/endpoint?access_token=${TOKEN}`,
  );
  let shortToken = "";
  let resourceUrl = BASE;
  if (ep.includes("{")) {
    try {
      const payload = JSON.parse(ep);
      console.log("endpoint type:", payload.type, "| url:", payload.url);
      shortToken = payload.accessToken ?? "";
      if (payload.url) resourceUrl = payload.url.replace(/\/$/, "");
    } catch {
      /* not json */
    }
  }
  // 1. 用长期 token 直接请求 layer.json（预期 401）
  await tryFetch("layer.json long-token", `${BASE}/layer.json?access_token=${TOKEN}`);
  // 2. 用短期 token 请求 layer.json（预期 200）
  const lj = await tryFetch("layer.json short-token", `${resourceUrl}/layer.json?access_token=${shortToken}`);
  if (lj.includes("{")) {
    try {
      const meta = JSON.parse(lj);
      console.log("version:", meta.version, "| scheme:", meta.scheme, "| maxzoom:", meta.maxzoom);
      console.log("tiles[0]:", meta.tiles?.[0]);
      console.log("available levels:", Array.isArray(meta.available) ? meta.available.length : "none");
    } catch {
      /* not json */
    }
  }
  // 3. 用应用的真实坐标约定验证厦门瓦片：
  //    GeographicTilingScheme: numX=2^(z+1), numY=2^z, y 从南 (lat+90)/180
  const meta = JSON.parse(lj);
  const z = 10;
  const x = Math.floor(((118.14 + 180) / 360) * Math.pow(2, z + 1));
  const y = Math.floor(((24.49 + 90) / 180) * Math.pow(2, z));
  const ranges = meta.available?.[z] ?? [];
  const inAvail = ranges.some(
    (r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY,
  );
  console.log(`xiamen L${z}/${x}/${y} in availability: ${inAvail} (${ranges.length} ranges)`);
  await tryFetch("tile xiamen", `${resourceUrl}/${z}/${x}/${y}.terrain?access_token=${shortToken}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
