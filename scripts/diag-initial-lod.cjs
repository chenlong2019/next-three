/**
 * 初始远景态 LOD 逐层追踪。
 *
 * 背景：两轴可见尺寸护栏上线后，初始态（默认相机）的正选集从
 * 6 块（z10~z12）塌缩成 2 块 z7。本探针从 minZoom 沿"屏幕中心点
 * 所在瓦片"逐层向下，打印每一层的细分判据数值与判定结果，
 * 定位遍历在哪一层、因哪个条件停止。
 *
 * 运行前提：dev server (localhost:12345)。
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const URL =
  process.env.REPRO_URL ||
  "http://localhost:12345/examples/cesium-terrain/fullscreen/";
const OUT_DIR = path.join(process.cwd(), "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page) {
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () =>
        Boolean(
          globalThis.__terrainDebug &&
            globalThis.__terrainDebug.currentCamera &&
            globalThis.__terrainDebug.currentVisibleKeys.size > 0,
        ),
    );
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

function trace() {
  const L = globalThis.__terrainDebug;
  const camera = L.currentCamera;
  const W = L.currentViewportWidth || 1280;
  const H = L.currentViewportHeight || 860;
  // 屏幕中心射线与地面交点近似：用可见集里正选瓦片的中心代替。
  // 更稳的做法：直接用 gis 把"相机视线与 z=0 平面的交点"换算成经纬度。
  const dir = camera.getWorldDirection(new camera.position.constructor());
  // 视线与平面 z=0（地表近似）求交
  const t = -camera.position.z / (dir.z || -1e-6);
  const hit = camera.position.clone().add(dir.clone().multiplyScalar(t));
  const lngLat = L.gis.threeToLngLat
    ? L.gis.threeToLngLat(hit)
    : null;

  const lines = [];
  lines.push(`viewport=${W}x${H} camPos=${camera.position.toArray().map((v) => Math.round(v)).join(",")}`);
  lines.push(`hitXYZ=${hit.toArray().map((v) => Math.round(v)).join(",")} lngLat=${lngLat ? JSON.stringify(lngLat) : "n/a"}`);
  lines.push(
    `minZoom=${L.minZoom} maxZoom=${L.maxZoom} subdivisionMax=${L.terrainSubdivisionMaxZoom} virtual=${L.terrainVirtualSubdivision} availability=${L.terrainAvailability ? "yes" : "null"} maxTiles=${L.maxTilesPerView}`,
  );
  lines.push(`visibleKeys(${L.currentVisibleKeys.size})=${[...L.currentVisibleKeys].join(" | ")}`);
  lines.push(`traversal=${JSON.stringify(L.traversalDebug)}`);
  lines.push(`terrainTilePixelSize=${L.terrainTilePixelSize} maxSSE=${L.maximumScreenSpaceError}`);

  // 逐层：中心点所在瓦片（与 layer 相同的瓦片划分：numX=2^(z+1)，
  // yOrigin=south 时 y=floor(((lat+90)/180)*2^z)）
  if (Array.isArray(lngLat) && lngLat.length >= 2) {
    const lng = lngLat[0];
    const lat = lngLat[1];
    const yOrigin = L.tileYOrigin;
    for (let z = L.minZoom; z <= Math.min(L.maxZoom, L.minZoom + 12); z++) {
      const numX = Math.pow(2, z + 1);
      const numY = Math.pow(2, z);
      const tx = Math.max(0, Math.min(numX - 1, Math.floor(((lng + 180) / 360) * numX)));
      const tyRaw =
        yOrigin === "north"
          ? Math.floor(((90 - lat) / 180) * numY)
          : Math.floor(((lat + 90) / 180) * numY);
      const ty = Math.max(0, Math.min(numY - 1, tyRaw));
      const p = L.getTerrainTileProjection(tx, ty, z, camera);
      const avail = L.isTileAvailable(tx, ty, z);
      const cap = L.terrainAvailability ? L.terrainSubdivisionMaxZoom : L.maxZoom;
      const canSub = z < cap && (avail || (L.terrainVirtualSubdivision && L.terrainAvailability !== null));
      const guard = !p.reliable || p.visibleMinSize > L.terrainTilePixelSize;
      const want = canSub && guard && (p.screenSpaceError > L.maximumScreenSpaceError || p.pixelSize > L.terrainTilePixelSize * 2);
      lines.push(
        `z${z} tile=${tx},${ty} px=${Math.round(p.pixelSize)} visMax=${Math.round(p.visiblePixelSize)} visMin=${Math.round(p.visibleMinSize)} sse=${p.screenSpaceError.toFixed(2)} rel=${p.reliable} avail=${avail} canSub=${canSub} guard=${guard ? "pass" : "BLOCK"} => subdivide=${want} [tps=${L.terrainTilePixelSize}]`,
      );
    }
  }
  return lines.join("\n");
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  console.log(`URL: ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    await browser.close();
    process.exit(2);
  }
  await sleep(8000);
  const out = await page.evaluate(trace);
  console.log(out);
  await page.screenshot({ path: path.join(OUT_DIR, "initial-lod.png") });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
