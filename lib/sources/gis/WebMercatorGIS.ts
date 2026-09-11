import * as THREE from "three";

export type LngLat = [number, number];
export type LngLatAltitude = [number, number, number];
export type MercatorCoordinate = [number, number];

/** Maximum latitude supported by the spherical Web Mercator projection. */
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

/**
 * WGS84/Web Mercator conversion and local Z-up coordinates.
 *
 * The local origin is expressed in Web Mercator meters. Keeping the scene
 * close to the origin avoids the precision loss caused by rendering values in
 * the global coordinate range directly.
 */
export class WebMercatorGIS {
  public static readonly EARTH_RADIUS = 6378137;

  /** Kept as an instance property for backwards compatibility. */
  public readonly R = WebMercatorGIS.EARTH_RADIUS;
  public readonly originLng: number;
  public readonly originLat: number;
  public readonly originMx: number;
  public readonly originMy: number;

  constructor(originLng: number, originLat: number) {
    this.assertFinite(originLng, "originLng");
    this.assertFinite(originLat, "originLat");

    this.originLng = originLng;
    this.originLat = THREE.MathUtils.clamp(
      originLat,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE,
    );
    [this.originMx, this.originMy] = this.lngLatToMercator(this.originLng, this.originLat);
  }

  /** Convert WGS84 longitude/latitude degrees to Web Mercator meters. */
  public lngLatToMercator(lng: number, lat: number): MercatorCoordinate {
    this.assertFinite(lng, "longitude");
    this.assertFinite(lat, "latitude");

    const clampedLat = THREE.MathUtils.clamp(
      lat,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE,
    );
    const longitudeRadians = THREE.MathUtils.degToRad(lng);
    const latitudeRadians = THREE.MathUtils.degToRad(clampedLat);

    return [
      this.R * longitudeRadians,
      this.R * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)),
    ];
  }

  /** Convert Web Mercator meters to WGS84 longitude/latitude degrees. */
  public mercatorToLngLat(mx: number, my: number): LngLat {
    this.assertFinite(mx, "mercatorX");
    this.assertFinite(my, "mercatorY");

    const lng = THREE.MathUtils.radToDeg(mx / this.R);
    const lat = THREE.MathUtils.radToDeg(2 * Math.atan(Math.exp(my / this.R)) - Math.PI / 2);
    return [lng, lat];
  }

  /** Convert WGS84 degrees/meters to the local Three.js Z-up coordinate. */
  public lngLatToThree(lng: number, lat: number, altitude = 0): THREE.Vector3 {
    this.assertFinite(altitude, "altitude");
    const [mx, my] = this.lngLatToMercator(lng, lat);
    return new THREE.Vector3(mx - this.originMx, my - this.originMy, altitude);
  }

  /** Convert a local Three.js Z-up coordinate to WGS84 degrees/meters. */
  public threeToLngLat(position: THREE.Vector3): LngLatAltitude {
    const [lng, lat] = this.mercatorToLngLat(
      this.originMx + position.x,
      this.originMy + position.y,
    );
    return [lng, lat, position.z];
  }

  private assertFinite(value: number, name: string): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number`);
    }
  }
}
