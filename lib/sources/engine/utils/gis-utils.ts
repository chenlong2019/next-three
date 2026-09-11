/**
 * OSM tile(x,y,z) → [west, south, east, north] WGS84
 */
/**
 * 高德瓦片 x,y,z → [west, south, east, north] WGS84
 * ✅ 高德不要做 y = 2^z -1 - y 翻转！
 */
export function amapTileToLngLatBounds(x: number, y: number, z: number) {
  const n = Math.pow(2, z);
  const lngWest = (x / n) * 360 - 180;
  const lngEast = ((x + 1) / n) * 360 - 180;

  // 删除 realY = n-1-y 这一行！！
  const latNorthRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latSouthRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

  const latNorth = (latNorthRad * 180) / Math.PI;
  const latSouth = (latSouthRad * 180) / Math.PI;

  return { west: lngWest, south: latSouth, east: lngEast, north: latNorth };
}

/**
 * OSM瓦片专用，保留备用
 */
export function osmTileToLngLatBounds(x: number, y: number, z: number) {
  const n = Math.pow(2, z);
  const lngWest = (x / n) * 360 - 180;
  const lngEast = ((x + 1) / n) * 360 - 180;

  // OSM 需要翻转y
  const oy = n - 1 - y;
  const latNorthRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * oy) / n)));
  const latSouthRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (oy + 1)) / n)));

  const latNorth = (latNorthRad * 180) / Math.PI;
  const latSouth = (latSouthRad * 180) / Math.PI;

  return { west: lngWest, south: latSouth, east: lngEast, north: latNorth };
}

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

function clampTileZoom(zoom: number): number {
  return Math.max(0, Math.min(22, Math.floor(zoom)));
}

function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** 根据经纬度+层级得到标准 XYZ 瓦片坐标。 */
export function tileXYFromLngLat(lng: number, lat: number, zoom: number): { x: number; y: number } {
  zoom = clampTileZoom(zoom);
  const n = Math.pow(2, zoom);
  const normalizedLng = wrapLongitude(lng);
  const clampedLat = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
  const x = Math.max(0, Math.min(n - 1, Math.floor(((normalizedLng + 180) / 360) * n)));
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  return { x, y };
}

/** 根据瓦片xyz获取地理边界 */
export function getTileBounds(x: number, y: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const lngWest = (x / n) * 360 - 180;
  const lngEast = ((x + 1) / n) * 360 - 180;

  function y2lat(yVal: number) {
    const n2 = Math.pow(2, zoom);
    const v = 1 - (2 * yVal) / n2;
    const latRad = Math.atan(Math.sinh(Math.PI * v));
    return (latRad * 180) / Math.PI;
  }
  const latNorth = y2lat(y);
  const latSouth = y2lat(y + 1);

  return { west: lngWest, east: lngEast, south: latSouth, north: latNorth };
}

export function lngLatToTile(lng: number, lat: number, zoom: number) {
  return tileXYFromLngLat(lng, lat, zoom);
}
