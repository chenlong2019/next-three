import * as THREE from "three";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { tileXYFromLngLat } from "./gis-utils";

export interface HorizonClipOptions {
  /** Radius of the local ellipsoid approximation in meters. */
  earthRadius?: number;
  /** Small margin beyond the geometric horizon to avoid a visible gap. Default: 1.05. */
  horizonFactor?: number;
  /** Optional hard upper bound for request and tile bounds calculations. */
  maxGroundDistance?: number;
  /**
   * 地形相对 `planeZ` 的最大抬升（米）。
   *
   * 视野包围盒来自「屏幕四角射线 ∩ z=planeZ 平面」。近处地形一旦高于该
   * 平面，底边射线会先打到地形表面——比平面交点更靠近相机。这段地面
   * 实际可见却落在包围盒之外，对应的瓦片不会被选择，只能由底层级的
   * 兜底瓦片顶着，表现为"屏幕最下方一条低层级瓦片始终不被替换"。
   * 传入该值后，底部两角会额外与 z=planeZ+groundRelief 平面求交并把
   * 交点并入包围盒，正好覆盖这段近地地面。
   */
  groundRelief?: number;
}

/**
 * Surface distance to the geometric horizon for an eye height above a sphere.
 * This keeps a local plane scene finite when the camera looks near the horizon.
 */
export function getHorizonDistance(
  eyeHeight: number,
  options: HorizonClipOptions = {},
): number {
  if (!Number.isFinite(eyeHeight)) return 0;
  if (eyeHeight <= 0) return 0;

  const earthRadius = options.earthRadius ?? WebMercatorGIS.EARTH_RADIUS;
  const horizonFactor = options.horizonFactor ?? 1.05;
  const maxGroundDistance = options.maxGroundDistance ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(earthRadius) || earthRadius <= 0) {
    throw new RangeError("earthRadius must be a finite number greater than 0.");
  }
  if (!Number.isFinite(horizonFactor) || horizonFactor <= 0) {
    throw new RangeError("horizonFactor must be a finite number greater than 0.");
  }
  if (maxGroundDistance < 0 || Number.isNaN(maxGroundDistance)) {
    throw new RangeError("maxGroundDistance must be a non-negative number.");
  }

  const horizon = earthRadius * Math.acos(earthRadius / (earthRadius + eyeHeight));
  return Math.min(horizon * horizonFactor, maxGroundDistance);
}

/**
 * 视口四角射线求地面交点
 * @param camera
 * @param planeZ 地面高度（默认0），近距离观察地形时应传入相机目标Z以避免bounds偏移
 * @param options 地平线裁剪参数；默认限制到地球几何地平线，避免近水平视线产生无限远交点
 * @returns 4个地面局部坐标点
 */
export function getViewGroundCorners(
  camera: THREE.Camera,
  planeZ = 0,
  options: HorizonClipOptions = {},
): THREE.Vector3[] {
  const raycaster = new THREE.Raycaster();
  // NDC 四个角落
  const ndcList = [
    new THREE.Vector2(-1, -1),
    new THREE.Vector2(1, -1),
    new THREE.Vector2(1, 1),
    new THREE.Vector2(-1, 1),
  ];
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  const groundOrigin = new THREE.Vector3(camera.position.x, camera.position.y, planeZ);
  const horizonDistance = getHorizonDistance(camera.position.z - planeZ, options);
  const result: THREE.Vector3[] = [];
  if (horizonDistance <= 0) return result;

  // 近地补齐：底部两角额外与"最高地形平面"求交。地形高于 planeZ 时，
  // 该交点比平面交点更靠近相机，才是屏幕底边真正可见的地面起点。
  // 相机低于该平面（relief ≥ 相机高度）时射线打不到它，自然退化为无补齐。
  const groundRelief = options.groundRelief ?? 0;
  const reliefPlane =
    groundRelief > 0
      ? new THREE.Plane(new THREE.Vector3(0, 0, 1), -(planeZ + groundRelief))
      : null;
  const liftedPoint = reliefPlane ? new THREE.Vector3() : null;

  const fallbackDirection = new THREE.Vector3();
  camera.getWorldDirection(fallbackDirection);
  fallbackDirection.z = 0;
  if (fallbackDirection.lengthSq() === 0) fallbackDirection.set(0, 1, 0);
  fallbackDirection.normalize();

  for (const ndc of ndcList) {
    raycaster.setFromCamera(ndc, camera);
    if (reliefPlane && liftedPoint && ndc.y < 0) {
      const liftedHit = raycaster.ray.intersectPlane(reliefPlane, liftedPoint);
      if (
        liftedHit &&
        Number.isFinite(liftedHit.x) &&
        Number.isFinite(liftedHit.y) &&
        Number.isFinite(liftedHit.z)
      ) {
        result.push(liftedHit.clone());
      }
    }
    const intersectPoint = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(groundPlane, intersectPoint);

    if (hit && Number.isFinite(intersectPoint.x) && Number.isFinite(intersectPoint.y)) {
      const offset = intersectPoint.clone().sub(groundOrigin);
      offset.z = 0;
      const distance = offset.length();
      if (distance <= horizonDistance || distance === 0) {
        result.push(intersectPoint.clone());
        continue;
      }
      result.push(
        groundOrigin.clone().addScaledVector(offset.divideScalar(distance), horizonDistance),
      );
      continue;
    }

    const direction = raycaster.ray.direction.clone();
    direction.z = 0;
    if (direction.lengthSq() === 0) direction.copy(fallbackDirection);
    else direction.normalize();
    result.push(groundOrigin.clone().addScaledVector(direction, horizonDistance));
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
