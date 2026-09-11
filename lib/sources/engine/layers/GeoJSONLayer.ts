import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";

export type GeoJSONLayerKind = "water" | "roads" | "railways";

export interface GeoJSONWaterStyle {
  fillColor?: THREE.ColorRepresentation;
  fillOpacity?: number;
  /** Dark base color used for the deeper parts of the water surface. */
  deepColor?: THREE.ColorRepresentation;
  /** Surface color mixed into the animated water pattern. */
  surfaceColor?: THREE.ColorRepresentation;
  /** Highlight color used for Fresnel and specular reflections. */
  highlightColor?: THREE.ColorRepresentation;
  edgeColor?: THREE.ColorRepresentation;
  edgeWidth?: number;
  edgeOpacity?: number;
  glowWidth?: number;
  glowOpacity?: number;
  /** World-space scale of the animated surface pattern. */
  rippleScale?: number;
  /** Strength of the normal and color variation caused by the waves. */
  rippleStrength?: number;
  /** Strength of the view-angle dependent edge reflection. */
  fresnelStrength?: number;
  /** Strength of the soft sun reflection. */
  specularStrength?: number;
  /** Sharpness of the soft sun reflection. */
  specularPower?: number;
  /** Animation speed of the surface pattern. */
  waveSpeed?: number;
}

export interface GeoJSONRoadStyle {
  majorColor?: THREE.ColorRepresentation;
  majorWidth?: number;
  majorOpacity?: number;
  majorGlowWidth?: number;
  majorGlowOpacity?: number;
  majorFlowColor?: THREE.ColorRepresentation;
  majorFlowWidth?: number;
  majorFlowOpacity?: number;
  majorFlowDashSize?: number;
  majorFlowGapSize?: number;
  majorFlowSpeed?: number;
  localColor?: THREE.ColorRepresentation;
  localWidth?: number;
  localOpacity?: number;
  localGlowWidth?: number;
  localGlowOpacity?: number;
}

export interface GeoJSONRailwayStyle {
  railColor?: THREE.ColorRepresentation;
  railWidth?: number;
  railOpacity?: number;
  railGlowColor?: THREE.ColorRepresentation;
  railGlowWidth?: number;
  railGlowOpacity?: number;
  detailColor?: THREE.ColorRepresentation;
  detailWidth?: number;
  detailOpacity?: number;
  detailDashSize?: number;
  detailGapSize?: number;
  detailSpeed?: number;
  subwayColor?: THREE.ColorRepresentation;
  subwayWidth?: number;
  subwayOpacity?: number;
  subwayDashSize?: number;
  subwayGapSize?: number;
}

export interface GeoJSONLayerOptions {
  url: string;
  kind: GeoJSONLayerKind;
  altitude?: number;
  waterStyle?: GeoJSONWaterStyle;
  roadStyle?: GeoJSONRoadStyle;
  railwayStyle?: GeoJSONRailwayStyle;
}

interface JsonObject {
  [key: string]: unknown;
}

interface GeoJSONFeature {
  geometry?: JsonObject | null;
  properties?: JsonObject | null;
}

interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

type LngLat = readonly [number, number];

const MAJOR_ROAD_CLASSES = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
]);

const WATER_VERTEX_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const WATER_FRAGMENT_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  varying vec3 vWorldPosition;
  uniform vec3 uDeepColor;
  uniform vec3 uSurfaceColor;
  uniform vec3 uHighlightColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uRippleScale;
  uniform float uRippleStrength;
  uniform float uFresnelStrength;
  uniform float uSpecularStrength;
  uniform float uSpecularPower;
  uniform float uWaveSpeed;

  void main() {
    #include <logdepthbuf_fragment>

    vec2 surfacePosition = vWorldPosition.xy * uRippleScale;
    float time = uTime * uWaveSpeed;

    float phaseA = dot(surfacePosition, vec2(1.7, -1.2)) + time * 0.45;
    float phaseB = dot(surfacePosition, vec2(-0.9, 1.8)) - time * 0.32;
    float phaseC = dot(surfacePosition, vec2(2.4, 0.7)) + time * 0.20;
    float waveA = sin(phaseA);
    float waveB = sin(phaseB);
    float waveC = sin(phaseC);

    float ripple = waveA * 0.50 + waveB * 0.30 + waveC * 0.20;
    float rippleMask = 0.5 + 0.5 * ripple;

    // Approximate a moving water normal without displacing the polygon.
    float derivativeX = cos(phaseA) * 1.7 * 0.50
      + cos(phaseB) * -0.9 * 0.30
      + cos(phaseC) * 2.4 * 0.20;
    float derivativeY = cos(phaseA) * -1.2 * 0.50
      + cos(phaseB) * 1.8 * 0.30
      + cos(phaseC) * 0.7 * 0.20;
    vec3 normal = normalize(vec3(
      -derivativeX * uRippleStrength,
      -derivativeY * uRippleStrength,
      1.0
    ));

    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float facing = max(dot(normal, viewDirection), 0.0);
    float fresnel = pow(1.0 - facing, 3.0) * uFresnelStrength;

    vec3 lightDirection = normalize(vec3(-0.35, 0.42, 0.85));
    vec3 reflectedLight = reflect(-lightDirection, normal);
    float specular = pow(
      max(dot(reflectedLight, viewDirection), 0.0),
      uSpecularPower
    ) * uSpecularStrength;

    vec3 color = mix(uDeepColor, uSurfaceColor, 0.35 + rippleMask * 0.35);
    color = mix(color, uHighlightColor, fresnel * 0.55);
    color += uHighlightColor * specular;
    color += uSurfaceColor * rippleMask * 0.06;

    gl_FragColor = vec4(color, uOpacity);
  }
`;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCoordinate(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function asCoordinateLine(value: unknown): LngLat[] {
  if (!Array.isArray(value)) return [];
  return value.map(asCoordinate).filter((coordinate): coordinate is LngLat => coordinate !== null);
}

function cleanRing(ring: LngLat[]): LngLat[] {
  if (ring.length < 3) return [];
  const cleaned: LngLat[] = [];
  for (const point of ring) {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
      cleaned.push(point);
    }
  }
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) {
    cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : [];
}

function isMajorRoad(fclass: string): boolean {
  return MAJOR_ROAD_CLASSES.has(fclass);
}

function addLineSegments(
  target: number[],
  line: LngLat[],
  gis: WebMercatorGIS,
  altitude: number,
): void {
  let previous: THREE.Vector3 | null = null;
  for (const coordinate of line) {
    const current = gis.lngLatToThree(coordinate[0], coordinate[1], altitude);
    if (previous && previous.distanceToSquared(current) > 1e-8) {
      target.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    }
    previous = current;
  }
}

function createLine(
  positions: number[],
  options: {
    color: THREE.ColorRepresentation;
    width: number;
    opacity: number;
    intensity: number;
    renderOrder: number;
    dashed?: {
      dashSize: number;
      gapSize: number;
    };
  },
): LineSegments2 | null {
  if (positions.length === 0 || options.width <= 0 || options.opacity <= 0) {
    return null;
  }

  const geometry = new LineSegmentsGeometry().setPositions(positions);
  const material = new LineMaterial({
    color: options.color,
    linewidth: options.width,
    worldUnits: false,
    transparent: true,
    opacity: options.opacity,
    dashed: options.dashed !== undefined,
    dashSize: options.dashed?.dashSize,
    gapSize: options.dashed?.gapSize,
  });
  material.color.multiplyScalar(options.intensity);
  material.depthTest = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;

  const line = new LineSegments2(geometry, material);
  line.renderOrder = options.renderOrder;
  line.frustumCulled = false;
  if (options.dashed) line.computeLineDistances();
  line.onBeforeRender = (renderer) => {
    renderer.getSize(material.resolution);
  };
  return line;
}

/**
 * Lightweight static GeoJSON renderer for map overlays.
 *
 * Polygon fills and line segments are merged into a small number of GPU
 * objects, which keeps large line datasets practical in a browser scene.
 */
export class GeoJSONLayer extends THREE.Group {
  private readonly gis: WebMercatorGIS;
  private readonly options: GeoJSONLayerOptions;
  private readonly abortController = new AbortController();
  private waterMaterial: THREE.ShaderMaterial | null = null;
  private roadFlowMaterial: LineMaterial | null = null;
  private roadFlowSpeed = 0;
  private railwayDetailMaterial: LineMaterial | null = null;
  private railwayDetailSpeed = 0;
  private disposed = false;
  private loaded = false;

  constructor(gis: WebMercatorGIS, options: GeoJSONLayerOptions) {
    super();
    this.gis = gis;
    this.options = options;
    this.name = `${options.kind} GeoJSON layer`;
    void this.load();
  }

  public get isLoaded(): boolean {
    return this.loaded;
  }

  public update(time = performance.now() * 0.001): void {
    if (this.waterMaterial) this.waterMaterial.uniforms.uTime.value = time;
    if (this.roadFlowMaterial) {
      this.roadFlowMaterial.dashOffset = -time * this.roadFlowSpeed;
    }
    if (this.railwayDetailMaterial) {
      this.railwayDetailMaterial.dashOffset = -time * this.railwayDetailSpeed;
    }
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch(this.options.url, {
        signal: this.abortController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = (await response.json()) as unknown;
      if (!this.isFeatureCollection(document)) {
        throw new Error("GeoJSON must be a FeatureCollection.");
      }
      if (this.disposed) return;

      if (this.options.kind === "water") {
        this.buildWater(document.features);
      } else if (this.options.kind === "roads") {
        this.buildRoads(document.features);
      } else {
        this.buildRailways(document.features);
      }
      this.loaded = true;
    } catch (error: unknown) {
      if (this.disposed || this.abortController.signal.aborted) return;
      console.warn(`[GeoJSONLayer] Failed to load ${this.options.url}:`, error);
    }
  }

  private isFeatureCollection(value: unknown): value is GeoJSONFeatureCollection {
    if (!isObject(value) || value.type !== "FeatureCollection") return false;
    return Array.isArray(value.features);
  }

  private buildWater(features: GeoJSONFeature[]): void {
    const positions: number[] = [];
    const indices: number[] = [];
    const edgePositions: number[] = [];
    const altitude = this.options.altitude ?? 0.8;
    const toPoint = (coordinate: LngLat): THREE.Vector2 => {
      const point = this.gis.lngLatToThree(coordinate[0], coordinate[1]);
      return new THREE.Vector2(point.x, point.y);
    };

    for (const feature of features) {
      const geometry = feature.geometry;
      if (!geometry || typeof geometry.type !== "string") continue;
      const polygons = this.getPolygons(geometry);
      for (const rings of polygons) {
        const cleanRings = rings.map(cleanRing).filter((ring) => ring.length >= 3);
        const outer = cleanRings[0];
        if (!outer) continue;

        const contour = outer.map(toPoint);
        const holes = cleanRings.slice(1).map((ring) => ring.map(toPoint));
        const allPoints = [contour, ...holes].flat();
        const baseIndex = positions.length / 3;

        for (const point of allPoints) {
          positions.push(point.x, point.y, altitude);
        }

        for (const triangle of THREE.ShapeUtils.triangulateShape(contour, holes)) {
          indices.push(baseIndex + triangle[0], baseIndex + triangle[1], baseIndex + triangle[2]);
        }

        for (const ring of cleanRings) {
          addLineSegments(edgePositions, [...ring, ring[0]!], this.gis, altitude + 0.35);
        }
      }
    }

    if (positions.length === 0 || indices.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);

    const style = this.options.waterStyle ?? {};
    const deepColor = new THREE.Color(style.deepColor ?? style.fillColor ?? 0x003b52);
    const surfaceColor = new THREE.Color(style.surfaceColor ?? 0x0b7180);
    const highlightColor = new THREE.Color(style.highlightColor ?? style.edgeColor ?? 0x05d9e8);
    const opacity = THREE.MathUtils.clamp(style.fillOpacity ?? 0.62, 0, 1);
    this.waterMaterial = new THREE.ShaderMaterial({
      name: "GeoJSON water fill",
      uniforms: {
        uDeepColor: { value: deepColor },
        uSurfaceColor: { value: surfaceColor },
        uHighlightColor: { value: highlightColor },
        uOpacity: { value: opacity },
        uTime: { value: 0 },
        uRippleScale: {
          value: Math.max(style.rippleScale ?? 0.0014, 0.00001),
        },
        uRippleStrength: {
          value: THREE.MathUtils.clamp(style.rippleStrength ?? 0.11, 0, 1),
        },
        uFresnelStrength: {
          value: THREE.MathUtils.clamp(style.fresnelStrength ?? 0.55, 0, 2),
        },
        uSpecularStrength: {
          value: THREE.MathUtils.clamp(style.specularStrength ?? 0.22, 0, 2),
        },
        uSpecularPower: {
          value: Math.max(style.specularPower ?? 48, 1),
        },
        uWaveSpeed: { value: Math.max(style.waveSpeed ?? 1, 0) },
      },
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, this.waterMaterial);
    mesh.name = "GeoJSON water fill";
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    this.add(mesh);

    const edgeColor = style.edgeColor ?? 0x1cf5ff;
    const glow = createLine(edgePositions, {
      color: edgeColor,
      width: style.glowWidth ?? 5,
      opacity: style.glowOpacity ?? 0.2,
      intensity: 1.2,
      renderOrder: 11,
    });
    const edge = createLine(edgePositions, {
      color: edgeColor,
      width: style.edgeWidth ?? 1.2,
      opacity: style.edgeOpacity ?? 0.92,
      intensity: 1.1,
      renderOrder: 12,
    });
    if (glow) this.add(glow);
    if (edge) this.add(edge);
  }

  private buildRoads(features: GeoJSONFeature[]): void {
    const majorPositions: number[] = [];
    const localPositions: number[] = [];
    const altitude = this.options.altitude ?? 2.4;

    for (const feature of features) {
      const geometry = feature.geometry;
      if (!geometry || typeof geometry.type !== "string") continue;
      const properties = feature.properties ?? {};
      const fclass = typeof properties.fclass === "string" ? properties.fclass : "unknown";
      const target = isMajorRoad(fclass) ? majorPositions : localPositions;
      for (const line of this.getLines(geometry)) {
        addLineSegments(target, line, this.gis, altitude);
      }
    }

    const style = this.options.roadStyle ?? {};
    const majorColor = style.majorColor ?? 0xff9b45;
    const localColor = style.localColor ?? 0x16c8d4;
    const majorGlow = createLine(majorPositions, {
      color: majorColor,
      width: style.majorGlowWidth ?? 5,
      opacity: style.majorGlowOpacity ?? 0.22,
      intensity: 1.5,
      renderOrder: 20,
    });
    const major = createLine(majorPositions, {
      color: majorColor,
      width: style.majorWidth ?? 1.35,
      opacity: style.majorOpacity ?? 0.95,
      intensity: 1.35,
      renderOrder: 21,
    });
    const majorFlow = createLine(majorPositions, {
      color: style.majorFlowColor ?? 0xfff2c2,
      width: style.majorFlowWidth ?? 1.1,
      opacity: style.majorFlowOpacity ?? 0.92,
      intensity: 1.25,
      renderOrder: 22,
      dashed: {
        dashSize: style.majorFlowDashSize ?? 85,
        gapSize: style.majorFlowGapSize ?? 210,
      },
    });
    const localGlow = createLine(localPositions, {
      color: localColor,
      width: style.localGlowWidth ?? 2.4,
      opacity: style.localGlowOpacity ?? 0.12,
      intensity: 1.1,
      renderOrder: 23,
    });
    const local = createLine(localPositions, {
      color: localColor,
      width: style.localWidth ?? 0.65,
      opacity: style.localOpacity ?? 0.5,
      intensity: 0.95,
      renderOrder: 24,
    });

    if (majorFlow) {
      this.roadFlowMaterial = majorFlow.material;
      this.roadFlowSpeed = style.majorFlowSpeed ?? 90;
    }
    for (const line of [majorGlow, major, majorFlow, localGlow, local]) {
      if (line) this.add(line);
    }
  }

  private buildRailways(features: GeoJSONFeature[]): void {
    const railPositions: number[] = [];
    const subwayPositions: number[] = [];
    const altitude = this.options.altitude ?? 3.2;

    for (const feature of features) {
      const geometry = feature.geometry;
      if (!geometry || typeof geometry.type !== "string") continue;

      const properties = feature.properties ?? {};
      const fclass = typeof properties.fclass === "string" ? properties.fclass : "rail";
      const target = fclass === "subway" ? subwayPositions : railPositions;
      const rawLayer = Number(properties.layer);
      const layerOffset = Number.isFinite(rawLayer)
        ? THREE.MathUtils.clamp(rawLayer, -2, 3) * 0.45
        : 0;

      for (const line of this.getLines(geometry)) {
        addLineSegments(target, line, this.gis, altitude + layerOffset);
      }
    }

    const style = this.options.railwayStyle ?? {};
    const railColor = style.railColor ?? 0xf4d58d;
    const railGlow = createLine(railPositions, {
      color: style.railGlowColor ?? railColor,
      width: style.railGlowWidth ?? 5,
      opacity: style.railGlowOpacity ?? 0.14,
      intensity: 1.15,
      renderOrder: 30,
    });
    const rail = createLine(railPositions, {
      color: railColor,
      width: style.railWidth ?? 1.5,
      opacity: style.railOpacity ?? 0.92,
      intensity: 1.05,
      renderOrder: 31,
    });
    const detail = createLine(railPositions, {
      color: style.detailColor ?? 0xffffff,
      width: style.detailWidth ?? 0.75,
      opacity: style.detailOpacity ?? 0.88,
      intensity: 1,
      renderOrder: 32,
      dashed: {
        dashSize: style.detailDashSize ?? 7,
        gapSize: style.detailGapSize ?? 12,
      },
    });
    const subway = createLine(subwayPositions, {
      color: style.subwayColor ?? 0xb99cff,
      width: style.subwayWidth ?? 1.1,
      opacity: style.subwayOpacity ?? 0.58,
      intensity: 1,
      renderOrder: 29,
      dashed: {
        dashSize: style.subwayDashSize ?? 12,
        gapSize: style.subwayGapSize ?? 20,
      },
    });

    if (detail) {
      this.railwayDetailMaterial = detail.material;
      this.railwayDetailSpeed = style.detailSpeed ?? 12;
    }
    for (const line of [subway, railGlow, rail, detail]) {
      if (line) this.add(line);
    }
  }

  private getLines(geometry: JsonObject): LngLat[][] {
    if (!Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === "LineString") {
      const line = asCoordinateLine(geometry.coordinates);
      return line.length >= 2 ? [line] : [];
    }
    if (geometry.type === "MultiLineString") {
      return geometry.coordinates.map(asCoordinateLine).filter((line) => line.length >= 2);
    }
    return [];
  }

  private getPolygons(geometry: JsonObject): LngLat[][][] {
    if (!Array.isArray(geometry.coordinates)) return [];
    if (geometry.type === "Polygon") {
      return [geometry.coordinates.map(asCoordinateLine)];
    }
    if (geometry.type === "MultiPolygon") {
      return geometry.coordinates.map((polygon) =>
        Array.isArray(polygon) ? polygon.map(asCoordinateLine) : [],
      );
    }
    return [];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.removeFromParent();

    this.traverse((object) => {
      const renderable = object as THREE.Mesh;
      renderable.geometry?.dispose();
      const material = renderable.material as THREE.Material | THREE.Material[] | undefined;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const item of materials) item.dispose();
    });
    this.clear();
    this.waterMaterial = null;
    this.roadFlowMaterial = null;
    this.railwayDetailMaterial = null;
  }
}
