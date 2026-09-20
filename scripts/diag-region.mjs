// 验证 endpoint 返回的资源区域 vs demo 原配置区域是否都可用
const TOKEN = process.argv[2];
const ep = await fetch(
  `https://api.cesium.com/v1/assets/1/endpoint?access_token=${TOKEN}`,
).then((r) => r.json());
console.log("endpoint url:", ep.url);
const short = ep.accessToken;
const us = ep.url.replace(/\/$/, "");
const ap = "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2";

for (const [label, base] of [
  ["us-east-1  (endpoint 返回)", us],
  ["ap-northeast-1 (demo 原配置)", ap],
]) {
  const lj = await fetch(`${base}/layer.json?access_token=${short}`);
  console.log(`${label} layer.json: ${lj.status}`);
  const tile = await fetch(`${base}/10/1696/651.terrain?access_token=${short}`);
  console.log(`${label} tile 10/1696/651: ${tile.status} (${tile.size ?? (await tile.arrayBuffer()).byteLength} bytes)`);
}
