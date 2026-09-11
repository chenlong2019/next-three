import * as THREE from "three";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { tileXYFromLngLat } from "./gis-utils";

/**
 * 视口四角射线求地面交点
 * @param camera
 * @param planeZ 地面高度（默认0），近距离观察地形时应传入相机目标Z以避免bounds偏移
 * @returns 4个地面局部坐标点
 */
export function getViewGroundCorners(camera: THREE.Camera, planeZ = 0): THREE.Vector3[] {
  const raycaster = new THREE.Raycaster();
  // NDC 四个角落
  const ndcList = [
    new THREE.Vector2(-1, -1),
    new THREE.Vector2(1, -1),
    new THREE.Vector2(1, 1),
    new THREE.Vector2(-1, 1),
  ];
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  const result: THREE.Vector3[] = [];

  for (const ndc of ndcList) {
    raycaster.setFromCamera(ndc, camera);
    const intersectPoint = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(groundPlane, intersectPoint);
    if (hit) {
      result.push(intersectPoint.clone());
    }
  }
  return result;
}

/**
 * 根据视野四角，求出经纬度包围盒
 */
export function cornersToLngLatBounds(
  corners: THREE.Vector3[],
  gis: WebMercatorGIS,
): { west: number; east: number; south: number; north: number } | null {
  if (corners.length < 3) return null;
  let west = 180,
    east = -180,
    south = 90,
    north = -90;
  for (const pos of corners) {
    const [lng, lat] = gis.threeToLngLat(pos);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, east, south, north };
}

/**
 * 根据相机高度自适应推荐瓦片层级
 * 原理：屏幕地面分辨率 = 2 × distance × tan(fov/2) / viewportHeight
 *       瓦片地面分辨率 = 156543 × cos(lat) / 2^zoom
 *       取 zoom 使瓦片分辨率 ≤ 屏幕分辨率（瓦片不被放大 → 清晰）
 * @param cameraDistance 相机到target直线距离(米)
 * @param fovDeg 相机垂直FOV（度），默认75
 * @param viewportHeight 视口像素高度，默认900
 * @param latitude 当前中心点纬度（度），默认30
 */
export function getSuggestZoom(
  cameraDistance: number,
  fovDeg = 75,
  viewportHeight = 900,
  latitude = 30,
): number {
  // 屏幕每像素对应的地面距离 (m/px)
  const fovRad = (fovDeg * Math.PI) / 180;
  const screenRes = (2 * cameraDistance * Math.tan(fovRad / 2)) / viewportHeight;

  // 瓦片在赤道处的分辨率常量 (m/px at zoom 0)
  const TILE_RES_Z0 = 156543.034;
  const cosLat = Math.cos((latitude * Math.PI) / 180);

  // 求 zoom: TILE_RES_Z0 × cosLat / 2^zoom ≤ screenRes
  // → 2^zoom ≥ TILE_RES_Z0 × cosLat / screenRes
  // → zoom ≥ log2(TILE_RES_Z0 × cosLat / screenRes)
  const zoom = Math.log2((TILE_RES_Z0 * cosLat) / screenRes);

  // 向上取整，保证瓦片分辨率优于或等于屏幕分辨率，避免瓦片被放大成马赛克
  // clamp 到 [1, 18] 防止极端值
  return Math.max(1, Math.min(18, Math.ceil(zoom)));
}

/**
 * 遍历包围盒内所有瓦片XY
 */
export function iterateTilesInBounds(
  bounds: { west: number; east: number; south: number; north: number },
  zoom: number,
  cb: (x: number, y: number) => void,
) {
  const nw = tileXYFromLngLat(bounds.west, bounds.north, zoom);
  const se = tileXYFromLngLat(bounds.east, bounds.south, zoom);

  const minX = Math.min(nw.x, se.x);
  const maxX = Math.max(nw.x, se.x);
  const minY = Math.min(nw.y, se.y);
  const maxY = Math.max(nw.y, se.y);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      cb(x, y);
    }
  }
}
