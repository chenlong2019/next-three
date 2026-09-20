/**
 * 只读诊断：地形服务在厦门（示例默认视图）实际可用的最深层级，
 * 以及各级别影像拼接画布是否会被 2048 上限压回低一级。
 * token 从 .env.local 读取，不打印。
 */
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const TOKEN = (env.match(/NEXT_PUBLIC_CESIUM_ION_TOKEN\s*=\s*(.+)/)?.[1] ?? "")
  .trim()
  .replace(/^["']|["']$/g, "");

const LNG = 118.1371;
const LAT = 24.49;
const ASSET_ID = 1;

const ep = await (await fetch(`https://api.cesium.com/v1/assets/${ASSET_ID}/endpoint?access_token=${TOKEN}`)).json();
const base = ep.url.replace(/\/$/, "");
const shorToken = ep.accessToken;
const meta = await (await fetch(`${base}/layer.json?access_token=${shorToken}`)).json();
const avail = meta.available ?? [];

// 代码约定：numX = 2^(z+1)，numY = 2^z，y 从南向北
const tile = (z) => ({
  x: Math.floor(((LNG + 180) / 360) * 2 ** (z + 1)),
  y: Math.floor(((LAT + 90) / 180) * 2 ** z),
});

console.log(`layer.json maxzoom=${meta.maxzoom} scheme=${meta.scheme} 层级数=${avail.length}`);

for (const z of [12, 13, 14, 15, 16]) {
  const { x, y } = tile(z);
  const ranges = avail[z] ?? [];
  const hit = ranges.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
  let httpStatus = "—";
  if (z <= 15) {
    const res = await fetch(`${base}/${z}/${x}/${y}.terrain?access_token=${shorToken}`, { method: "GET" });
    httpStatus = String(res.status);
  }
  console.log(
    `z${z} tile=${x},${y} availability=${hit ? "有" : "无"} (ranges=${ranges.length}) HTTP=${httpStatus}`,
  );
}

// 影像画布：地形瓦片 z_t 上取影像 z_i 时，画布像素尺寸 = 256 × 2^(z_i - z_t - 1)
console.log("\n影像拼接画布（2048 上限，纬度 24.49 → 高度系数 ≈1.10）");
for (const zt of [13, 14, 15]) {
  const row = [];
  for (const zi of [16, 17, 18, 19]) {
    const w = 256 * 2 ** (zi - zt - 1);
    const h = Math.round(w / Math.cos((LAT * Math.PI) / 180) ** 1);
    row.push(`zi=${zi}: ${w}×${h} ${w <= 2048 && h <= 2048 ? "OK" : "超限→降级"}`);
  }
  console.log(`地形 z${zt}（基准影像 z${zt + 1}）: ${row.join(" | ")}`);
}
