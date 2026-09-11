import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import {
  createDaylightBuildingMaterial,
  prepareDaylightGeometry,
  type DaylightBuildingStyle,
} from "../materials/DaylightBuildingMaterial";

// ─── tileset.json 类型定义 ──────────────────────────────────────

interface TilesetJson {
  asset: { version: string };
  geometricError: number;
  root: TileJson;
}

interface TileJson {
  boundingVolume: BoundingVolumeJson;
  geometricError: number;
  refine?: "ADD" | "REPLACE" | "add" | "replace";
  transform?: number[]; // 列主序 4×4
  content?: { uri?: string; url?: string };
  children?: TileJson[];
}

type BoundingVolumeJson =
  | { region: number[] } // [west, south, east, north, minH, maxH] 弧度 + 米
  | { box: number[] } // [cx..cz, xx..zx, xy..zy, xz..zz] 中心 + 3 个半轴向量
  | { sphere: number[] }; // [cx, cy, cz, r]

// ─── 运行时瓦片节点 ─────────────────────────────────────────────

const enum TileState {
  Unloaded = 0,
  Loading = 1,
  Loaded = 2,
  Failed = 3,
}

interface WorldSphere {
  center: THREE.Vector3;
  radius: number;
}

class Tile3D {
  parent: Tile3D | null = null;
  children: Tile3D[] = [];
  depth = 0;

  geometricError = 0;
  refineReplace = true; // true=REPLACE, false=ADD
  hasContent = false;
  contentUri = "";
  /** content URI 的基准路径（所属 tileset.json 所在目录） */
  contentBase = "";

  /** 局部（父级）变换 */
  localMatrix = new THREE.Matrix4();
  /** 从根到本节点的累积 ECEF 变换 */
  ecefMatrix = new THREE.Matrix4();

  bvRaw: BoundingVolumeJson;
  /** 局部包围球（ECEF） */
  localSphere = new THREE.Sphere();
  /** 世界包围球（场景局部坐标） */
  worldSphere: WorldSphere = { center: new THREE.Vector3(), radius: 0 };

  state: TileState = TileState.Unloaded;
  group: THREE.Group | null = null;
  lastFrameVisible = -1;
  lastError = Infinity;

  constructor(bv: BoundingVolumeJson) {
    this.bvRaw = bv;
  }
}

// ─── 配置 ───────────────────────────────────────────────────────

export interface Tiles3DLayerStyle {
  /** Optional daylight facade; omitted preserves the original cyber style. */
  appearance?: "cyber" | "daylight";
  daylight?: DaylightBuildingStyle;
  /** 建筑底部颜色。 */
  bottomColor?: THREE.ColorRepresentation;
  /** 建筑顶部及轮廓附近颜色。 */
  topColor?: THREE.ColorRepresentation;
  /** 屋顶、高层和扫描光的强调色。 */
  accentColor?: THREE.ColorRepresentation;
  /** 建筑整体透明度，范围 0-1。 */
  opacity?: number;
  /** 沿 glTF Y-up 高度轴的垂直夸张倍率。 */
  heightScale?: number;
  /** 接近地平线时的额外垂直夸张倍率，范围建议为 1-3。 */
  lowAngleHeightBoost?: number;
  /** HDR 亮度倍率，用于配合 Bloom。 */
  emissiveIntensity?: number;
  /** 相机接近俯视时叠加的青色屋顶强度，范围 0-1。 */
  topViewRoofStrength?: number;
  /** 楼层光带间距，单位为米；设为 0 可关闭。 */
  floorLineSpacing?: number;
  /** 楼层光带强度。 */
  floorLineStrength?: number;
  /** 垂直扫描光强度。 */
  scanStrength?: number;
  /** 垂直扫描速度。 */
  scanSpeed?: number;
  /** 建筑轮廓颜色；不设置时使用 topColor。 */
  edgeColor?: THREE.ColorRepresentation;
  /** 建筑轮廓宽度，单位为屏幕像素；设为 0 可关闭。 */
  edgeWidth?: number;
  /** 建筑轮廓透明度，范围 0-1。 */
  edgeOpacity?: number;
  /** 建筑轮廓 HDR 亮度倍率。 */
  edgeIntensity?: number;
  /** 屋顶轮廓颜色；不设置时使用 edgeColor。 */
  roofEdgeColor?: THREE.ColorRepresentation;
  /** 屋顶轮廓宽度，单位为屏幕像素；不设置时使用 edgeWidth。 */
  roofEdgeWidth?: number;
  /** 屋顶轮廓透明度，范围 0-1；不设置时使用 edgeOpacity。 */
  roofEdgeOpacity?: number;
  /** 屋顶轮廓 HDR 亮度倍率；不设置时使用 edgeIntensity。 */
  roofEdgeIntensity?: number;
  /** EdgesGeometry 的法线夹角阈值，单位为度。 */
  edgeThresholdAngle?: number;
}

export interface Tiles3DLayerOptions {
  /** 目标屏幕空间误差（像素），越小越精细，默认 16 */
  maximumScreenSpaceError?: number;
  /** 最大并发内容请求数，默认 6 */
  maxConcurrent?: number;
  /** 每帧最多新发起请求数，默认 2 */
  maxRequestsPerFrame?: number;
  /** 已加载瓦片缓存上限（超出按 LRU 卸载），默认 300 */
  maxCacheSize?: number;
  /** 是否启用瓦片级视锥裁剪，默认 true。 */
  enableFrustumCulling?: boolean;
  /** 额外施加在整棵树上的变换（可选） */
  transform?: THREE.Matrix4;
  /** Z 轴高度偏移（米），用于修正模型与地形的高程偏差，默认 0 */
  heightOffset?: number;
  /** 可选的统一模型样式，适合白模建筑可视化。 */
  style?: Tiles3DLayerStyle;
  /** tileset 解析完成后的回调，参数为数据中心 [lng, lat, height]（度/米） */
  onReady?: (center: [number, number, number]) => void;
}

interface LoadRequest {
  tile: Tile3D;
  priority: number;
}

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 3D Tiles 图层（b3dm / glTF 内容）
 *
 * 加载 OGC 3D Tiles tileset.json，按屏幕空间误差（SSE）动态调度瓦片，
 * 自动将 ECEF / region 坐标对齐到场景的 Z-up 局部坐标系。
 *
 * 用法：
 * ```ts
 * const layer = new Tiles3DLayer(gis, {
 *   url: 'http://192.168.0.101:8084/tileset.json',
 * });
 * scene.add(layer);
 * // 每帧：
 * layer.update(camera, viewportHeight);
 * ```
 */
export class Tiles3DLayer extends THREE.Group {
  private gis: WebMercatorGIS;
  private url: string;
  private baseUrl = "";

  private maximumScreenSpaceError: number;
  private maxConcurrent: number;
  private maxRequestsPerFrame: number;
  private maxCacheSize: number;
  private enableFrustumCulling: boolean;
  private extraTransform: THREE.Matrix4;
  private heightOffset: number;
  private style: Tiles3DLayerStyle | null;

  private root: Tile3D | null = null;
  private rootGeometricError = 0;
  /** ECEF → 场景局部坐标 变换 */
  private ecefToLocal = new THREE.Matrix4();
  private frameAnchorSet = false;

  private gltfLoader = new GLTFLoader();
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();

  private loadingCount = 0;
  private queue: LoadRequest[] = [];
  /** 已加载瓦片（用于 LRU 卸载） */
  private loadedTiles = new Set<Tile3D>();
  private frameCount = 0;
  private disposed = false;
  private onReady?: (center: [number, number, number]) => void;
  private styledMaterials = new Set<THREE.ShaderMaterial>();
  private styledModels = new Set<THREE.Group>();
  private edgeMaterials = new Set<LineMaterial>();

  constructor(gis: WebMercatorGIS, config: { url: string }, options: Tiles3DLayerOptions = {}) {
    super();
    this.gis = gis;
    this.url = config.url;
    this.baseUrl = config.url.substring(0, config.url.lastIndexOf("/") + 1);

    this.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 16;
    this.maxConcurrent = options.maxConcurrent ?? 6;
    this.maxRequestsPerFrame = options.maxRequestsPerFrame ?? 2;
    this.maxCacheSize = options.maxCacheSize ?? 300;
    this.enableFrustumCulling = options.enableFrustumCulling ?? true;
    this.extraTransform = options.transform ?? new THREE.Matrix4();
    this.heightOffset = options.heightOffset ?? 0;
    this.style = options.style ?? null;
    this.onReady = options.onReady;

    this.loadTileset();
  }

  // ─── 加载入口 ───────────────────────────────────────────────

  private async loadTileset() {
    try {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TilesetJson;
      if (this.disposed) return;

      this.rootGeometricError = json.geometricError;
      this.root = this.buildTile(json.root, null, new THREE.Matrix4(), 0);

      // 依据根包围体确定 ECEF → 局部坐标锚点
      const center = this.computeFrameAnchor(this.root);

      // 通知外部数据中心位置
      this.onReady?.(center);

      // DEBUG
      const bv = this.root.bvRaw;
      const bvType = "region" in bv ? "region" : "box" in bv ? "box" : "sphere";
      console.log("[Tiles3D] tileset 已解析:", {
        bvType,
        bv: JSON.stringify(bv),
        rootHasContent: this.root.hasContent,
        rootContentUri: this.root.contentUri,
        childCount: this.root.children.length,
        geometricError: this.root.geometricError,
        rootTransform: json.root.transform ? "yes" : "no",
      });
    } catch (err: unknown) {
      console.error("[Tiles3DLayer] tileset 加载失败:", getErrorMessage(err));
    }
  }

  /** 递归构建瓦片树 */
  private buildTile(
    json: TileJson,
    parent: Tile3D | null,
    parentEcef: THREE.Matrix4,
    depth: number,
    baseUrl: string = this.baseUrl,
  ): Tile3D {
    const tile = new Tile3D(json.boundingVolume);
    tile.parent = parent;
    tile.depth = depth;
    tile.geometricError = json.geometricError;
    tile.refineReplace = (json.refine ?? "REPLACE").toUpperCase() === "REPLACE";
    tile.contentBase = baseUrl;

    if (json.transform) {
      tile.localMatrix.fromArray(json.transform); // 列主序，直接 fromArray
    }
    tile.ecefMatrix.multiplyMatrices(parentEcef, tile.localMatrix);

    const uri = json.content?.uri ?? json.content?.url;
    if (uri) {
      tile.hasContent = true;
      tile.contentUri = uri;
    }

    this.computeLocalSphere(tile);

    if (json.children) {
      for (const childJson of json.children) {
        const child = this.buildTile(childJson, tile, tile.ecefMatrix, depth + 1, baseUrl);
        tile.children.push(child);
      }
    }
    return tile;
  }

  /** 计算瓦片在 ECEF 下的局部包围球 */
  private computeLocalSphere(tile: Tile3D) {
    const bv = tile.bvRaw;
    if ("region" in bv) {
      const [west, south, east, north, minH, maxH] = bv.region;
      const cLng = (west + east) / 2;
      const cLat = (south + north) / 2;
      const cH = (minH + maxH) / 2;
      const c = geodeticToEcef(cLng, cLat, cH);
      // 采样角点估算半径
      let r = 0;
      const corners = [
        [west, south, minH],
        [east, south, minH],
        [west, north, minH],
        [east, north, minH],
        [west, south, maxH],
        [east, north, maxH],
      ];
      for (const [lng, lat, h] of corners) {
        r = Math.max(r, c.distanceTo(geodeticToEcef(lng, lat, h)));
      }
      tile.localSphere.set(c, r);
    } else if ("box" in bv) {
      const b = bv.box;
      const c = new THREE.Vector3(b[0], b[1], b[2]);
      const ax = new THREE.Vector3(b[3], b[4], b[5]);
      const ay = new THREE.Vector3(b[6], b[7], b[8]);
      const az = new THREE.Vector3(b[9], b[10], b[11]);
      const r = ax.length() + ay.length() + az.length();
      tile.localSphere.set(c, r);
    } else if ("sphere" in bv) {
      const s = bv.sphere;
      tile.localSphere.set(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
    }
  }

  /** 依据根包围体中心，构建 ECEF → 场景局部坐标变换，返回数据中心 [lng°, lat°, h] */
  private computeFrameAnchor(root: Tile3D): [number, number, number] {
    const bv = root.bvRaw;
    let lng = 0,
      lat = 0,
      h = 0;

    if ("region" in bv) {
      const [west, south, east, north, minH, maxH] = bv.region;
      lng = (west + east) / 2;
      lat = (south + north) / 2;
      h = (minH + maxH) / 2;
    } else {
      // box / sphere：取包围体中心的 ECEF → 大地坐标
      let c: THREE.Vector3;
      if ("box" in bv) c = new THREE.Vector3(bv.box[0], bv.box[1], bv.box[2]);
      else c = new THREE.Vector3(bv.sphere[0], bv.sphere[1], bv.sphere[2]);
      // 应用根变换得到真实 ECEF 中心
      c.applyMatrix4(root.ecefMatrix);
      [lng, lat, h] = ecefToGeodetic(c);
      console.log(
        `[Tiles3D] anchor: ecef=(${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)}) ` +
          `lng=${THREE.MathUtils.radToDeg(lng).toFixed(6)} lat=${THREE.MathUtils.radToDeg(lat).toFixed(6)} h=${h.toFixed(1)}`,
      );
    }

    // ECEF → ENU（以 region 中心为原点）：enu = R * (ecef - origin_ecef)
    const R = ecefToEnuMatrix(lng, lat);
    const originEcef = geodeticToEcef(lng, lat, h);
    const toOrigin = new THREE.Matrix4().makeTranslation(
      -originEcef.x,
      -originEcef.y,
      -originEcef.z,
    );
    const ecefToEnu = new THREE.Matrix4().multiplyMatrices(R, toOrigin);

    // ENU(东,北,上) 与场景 Z-up(东,北,高) 轴一致，仅需平移到 GIS 原点
    const anchorLocal = this.gis.lngLatToThree(
      THREE.MathUtils.radToDeg(lng),
      THREE.MathUtils.radToDeg(lat),
      h + this.heightOffset,
    );
    const enuToLocal = new THREE.Matrix4().makeTranslation(
      anchorLocal.x,
      anchorLocal.y,
      anchorLocal.z,
    );

    this.ecefToLocal.multiplyMatrices(enuToLocal, ecefToEnu);
    this.ecefToLocal.multiply(this.extraTransform);

    // DEBUG: 验证净旋转 = R_enu * rootRotation 是否为单位矩阵
    const rootRot = new THREE.Matrix4().extractRotation(root.ecefMatrix);
    const netRot = new THREE.Matrix4().multiplyMatrices(R, rootRot);
    const ne = netRot.elements;
    console.log(
      `[Tiles3D] net rotation (should be I):\n` +
        `  [${ne[0].toFixed(4)}, ${ne[4].toFixed(4)}, ${ne[8].toFixed(4)}]\n` +
        `  [${ne[1].toFixed(4)}, ${ne[5].toFixed(4)}, ${ne[9].toFixed(4)}]\n` +
        `  [${ne[2].toFixed(4)}, ${ne[6].toFixed(4)}, ${ne[10].toFixed(4)}]`,
    );

    this.frameAnchorSet = true;

    return [THREE.MathUtils.radToDeg(lng), THREE.MathUtils.radToDeg(lat), h];
  }

  // ─── 每帧更新 ───────────────────────────────────────────────

  /**
   * 每帧调用：根据相机做视锥裁剪 + SSE 遍历，动态加载/卸载瓦片内容
   */
  public update(camera: THREE.Camera, viewportHeight: number) {
    if (this.disposed || !this.root || !this.frameAnchorSet) return;
    this.frameCount++;
    camera.updateMatrixWorld(true);

    const time = performance.now() * 0.001;
    const viewDirection = new THREE.Vector3();
    camera.getWorldDirection(viewDirection);
    const horizonFactor = 1 - THREE.MathUtils.smoothstep(Math.abs(viewDirection.z), 0.12, 0.55);
    const lowAngleHeightBoost = this.style?.lowAngleHeightBoost ?? 1;
    if (lowAngleHeightBoost > 1) {
      const heightBoost = THREE.MathUtils.lerp(
        1,
        THREE.MathUtils.clamp(lowAngleHeightBoost, 1, 3),
        horizonFactor,
      );
      for (const model of this.styledModels) {
        const baseScaleY = model.userData.tiles3dBaseScaleY as number | undefined;
        if (baseScaleY !== undefined) model.scale.y = baseScaleY * heightBoost;
      }
    }
    for (const material of this.styledMaterials) {
      material.uniforms.uTime.value = time;
    }
    const viewportWidth = viewportHeight * ((camera as THREE.PerspectiveCamera).aspect || 1);
    for (const material of this.edgeMaterials) {
      material.resolution.set(viewportWidth, viewportHeight);
    }

    // 更新视锥
    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const sseDenom =
      2 *
      Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov * 0.5)) *
      viewportHeight;

    // DEBUG: 前 3 帧输出根节点调度信息
    if (this.frameCount <= 3) {
      const ws = this.toWorldSphere(this.root);
      const sphere = new THREE.Sphere(ws.center, ws.radius);
      const inFrustum = this.frustum.intersectsSphere(sphere);
      const dist = Math.max(ws.radius, camera.position.distanceTo(ws.center) - ws.radius);
      const sse = (this.root.geometricError * sseDenom) / dist;
      console.log(
        `[Tiles3D] frame=${this.frameCount} ` +
          `worldCenter=(${ws.center.x.toFixed(1)}, ${ws.center.y.toFixed(1)}, ${ws.center.z.toFixed(1)}) ` +
          `radius=${ws.radius.toFixed(1)} inFrustum=${inFrustum} dist=${dist.toFixed(1)} sse=${sse.toFixed(2)} ` +
          `camPos=(${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)})`,
      );
    }

    this.queue.length = 0;
    this.visitTile(this.root, camera, sseDenom);
    this.processQueue();
    this.evictIfNeeded();
  }

  private visitTile(tile: Tile3D, camera: THREE.Camera, sseDenom: number) {
    // 计算世界包围球
    const ws = this.toWorldSphere(tile);
    tile.worldSphere = ws;

    // 视锥裁剪
    const sphere = new THREE.Sphere(ws.center, ws.radius);
    if (this.enableFrustumCulling && !this.frustum.intersectsSphere(sphere)) {
      return;
    }

    const distance = Math.max(ws.radius, camera.position.distanceTo(ws.center) - ws.radius);
    const sse = (tile.geometricError * sseDenom) / distance;
    tile.lastError = sse;

    const meetsSse = sse <= this.maximumScreenSpaceError;
    const hasRenderableChildren = tile.children.length > 0;

    if (meetsSse || !hasRenderableChildren) {
      // 渲染本瓦片
      this.selectTile(tile);
      return;
    }

    // 需要细化：优先渲染子节点
    if (tile.refineReplace) {
      // REPLACE：渲染子节点；若子节点尚未就绪，用本瓦片兜底
      let anyChildReady = false;
      for (const child of tile.children) {
        this.visitTile(child, camera, sseDenom);
        if (child.state === TileState.Loaded || child.state === TileState.Loading) {
          anyChildReady = true;
        }
      }
      // 子节点都没好时，显示父瓦片避免空洞
      if (!anyChildReady && tile.hasContent) {
        this.selectTile(tile);
      }
    } else {
      // ADD：父节点始终渲染，再叠加子节点
      this.selectTile(tile);
      for (const child of tile.children) {
        this.visitTile(child, camera, sseDenom);
      }
    }
  }

  /** 选中瓦片用于渲染：标记可见并请求内容 */
  private selectTile(tile: Tile3D) {
    tile.lastFrameVisible = this.frameCount;
    if (tile.hasContent && tile.state === TileState.Unloaded) {
      this.enqueue(tile);
    } else if (tile.state === TileState.Loaded && tile.group && !tile.group.parent) {
      // 已加载但被临时移出场景的瓦片，重新加入
      this.add(tile.group);
      this.loadedTiles.add(tile);
    }
  }

  // ─── 包围球变换到场景坐标 ──────────────────────────────────

  private toWorldSphere(tile: Tile3D): WorldSphere {
    // 局部球心（ECEF）→ 应用累积 ECEF 变换 → 应用 ecefToLocal → 场景坐标
    const center = tile.localSphere.center.clone();
    center.applyMatrix4(tile.ecefMatrix);
    center.applyMatrix4(this.ecefToLocal);

    // 半径缩放：取 ecefToLocal 的最大缩放分量（通常无缩放，约为 1）
    const scale = this.extractMaxScale(this.ecefToLocal);
    return { center, radius: tile.localSphere.radius * scale };
  }

  private extractMaxScale(m: THREE.Matrix4): number {
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);
    return Math.max(sx, sy, sz);
  }

  // ─── 请求队列 ───────────────────────────────────────────────

  private enqueue(tile: Tile3D) {
    if (tile.state !== TileState.Unloaded) return;
    // 优先级：屏幕误差越大（越该先加载）优先级越高
    const priority = tile.lastError === Infinity ? 1e9 : tile.lastError;
    const existing = this.queue.find((r) => r.tile === tile);
    if (existing) {
      existing.priority = priority;
      return;
    }
    this.queue.push({ tile, priority });
  }

  private processQueue() {
    this.queue.sort((a, b) => b.priority - a.priority);
    let started = 0;
    while (
      this.queue.length > 0 &&
      this.loadingCount < this.maxConcurrent &&
      started < this.maxRequestsPerFrame
    ) {
      const req = this.queue.shift()!;
      if (req.tile.state !== TileState.Unloaded) continue;
      this.loadTileContent(req.tile);
      started++;
    }
  }

  // ─── 内容加载 ───────────────────────────────────────────────

  private async loadTileContent(tile: Tile3D) {
    tile.state = TileState.Loading;
    this.loadingCount++;

    try {
      const fullUrl = this.resolveUrl(tile.contentUri, tile.contentBase);

      // 外部 tileset 引用（content.uri 为 .json）
      if (/\.json(\?.*)?$/i.test(tile.contentUri)) {
        await this.loadExternalTileset(tile, fullUrl);
        return;
      }

      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      if (this.disposed) {
        this.loadingCount--;
        return;
      }

      // 解析内容（b3dm 或 glTF）
      const gltfBuffer = this.extractGltf(buffer);
      const gltf = await this.gltfLoader.parseAsync(
        gltfBuffer,
        fullUrl.substring(0, fullUrl.lastIndexOf("/") + 1),
      );
      if (this.disposed) {
        this.loadingCount--;
        return;
      }

      const model = gltf.scene;
      this.applyStyle(model);
      // glTF 内容 Y-up → tileset Z-up
      model.rotateX(Math.PI / 2);
      // 应用：累积 ECEF 变换 → 场景局部变换
      model.applyMatrix4(tile.ecefMatrix);
      model.applyMatrix4(this.ecefToLocal);

      tile.group = new THREE.Group();
      tile.group.add(model);
      tile.state = TileState.Loaded;

      // 仅当本帧仍可见时才加入场景
      if (tile.lastFrameVisible === this.frameCount) {
        this.add(tile.group);
        this.loadedTiles.add(tile);
      }
    } catch (err: unknown) {
      if (!this.disposed) {
        tile.state = TileState.Failed;
        console.warn("[Tiles3DLayer] 瓦片内容加载失败:", tile.contentUri, getErrorMessage(err));
      }
    } finally {
      this.loadingCount--;
    }
  }

  /** 加载外部 tileset（content.uri 指向另一个 tileset.json） */
  private async loadExternalTileset(tile: Tile3D, url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TilesetJson;
      if (this.disposed) return;

      const subBase = url.substring(0, url.lastIndexOf("/") + 1);

      // 外部 tileset 的根节点继承当前瓦片的累积 ECEF 变换，baseUrl 为子 tileset 目录
      const subRoot = this.buildTile(json.root, tile, tile.ecefMatrix, tile.depth + 1, subBase);

      // 如果子根有 content，把它的 content 信息转移给当前 tile
      if (subRoot.hasContent) {
        tile.contentUri = subRoot.contentUri;
        tile.contentBase = subBase;
        tile.hasContent = true;
      }

      // 将子根的子节点接入当前瓦片
      for (const child of subRoot.children) {
        child.parent = tile;
        tile.children.push(child);
      }

      // 如果子根本身有 content，重新加载（此时 contentUri 已修正）
      if (subRoot.hasContent) {
        tile.state = TileState.Unloaded;
        this.enqueue(tile);
      } else {
        tile.state = TileState.Loaded; // 无内容的容器节点，标记为已加载
      }
    } catch (err: unknown) {
      if (!this.disposed) {
        tile.state = TileState.Failed;
        console.warn("[Tiles3DLayer] 外部 tileset 加载失败:", url, getErrorMessage(err));
      }
    } finally {
      this.loadingCount--;
    }
  }

  /** 从 b3dm / glb / glTF 二进制中提取 glTF 部分 */
  private extractGltf(buffer: ArrayBuffer): ArrayBuffer {
    const magic = new Uint8Array(buffer, 0, 4);
    const magicStr = String.fromCharCode(magic[0], magic[1], magic[2], magic[3]);

    if (magicStr === "b3dm") {
      const header = new DataView(buffer);
      const byteLength = header.getUint32(8, true);
      const ftJsonLen = header.getUint32(12, true);
      const ftBinLen = header.getUint32(16, true);
      const btJsonLen = header.getUint32(20, true);
      const btBinLen = header.getUint32(24, true);
      const gltfStart = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;
      const gltfLen = byteLength - gltfStart;
      return buffer.slice(gltfStart, gltfStart + gltfLen);
    }

    // glb / 其它：直接交给 GLTFLoader
    return buffer;
  }

  private resolveUrl(uri: string, base: string = this.baseUrl): string {
    if (/^https?:\/\//i.test(uri)) return uri;
    return base + uri;
  }

  private addEdgeOverlay(
    mesh: THREE.Mesh,
    positions: number[],
    options: {
      name: string;
      color: THREE.ColorRepresentation;
      width: number;
      opacity: number;
      intensity: number;
      renderOrderOffset: number;
    },
  ): void {
    if (positions.length === 0 || options.width <= 0) return;

    const geometry = new LineSegmentsGeometry().setPositions(positions);
    const material = new LineMaterial({
      color: options.color,
      linewidth: options.width,
      opacity: options.opacity,
      transparent: true,
    });
    material.color.multiplyScalar(options.intensity);
    material.depthTest = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;

    const edges = new LineSegments2(geometry, material);
    edges.name = options.name;
    edges.renderOrder = mesh.renderOrder + options.renderOrderOffset;
    edges.frustumCulled = false;
    mesh.add(edges);
    this.edgeMaterials.add(material);
  }

  private applyStyle(model: THREE.Group): void {
    const style = this.style;
    if (!style) return;

    const heightScale = style.heightScale ?? 1;
    if (!Number.isFinite(heightScale) || heightScale <= 0) {
      throw new RangeError("Tiles3D style heightScale must be greater than 0.");
    }
    model.scale.y *= heightScale;
    model.userData.tiles3dBaseScaleY = model.scale.y;
    if (style.lowAngleHeightBoost !== undefined) {
      if (!Number.isFinite(style.lowAngleHeightBoost) || style.lowAngleHeightBoost < 1) {
        throw new RangeError("Tiles3D style lowAngleHeightBoost must be at least 1.");
      }
    }
    this.styledModels.add(model);

    const meshes: THREE.Mesh[] = [];
    const sourceMaterials = new Set<THREE.Material>();
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes.push(object);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) sourceMaterials.add(material);
    });

    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      if (!geometry.getAttribute("position")) continue;

      if (style.appearance === "daylight") {
        prepareDaylightGeometry(geometry);
        mesh.material = createDaylightBuildingMaterial(style.daylight, style.opacity);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        continue;
      }

      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      if (!bounds) continue;

      const minHeight = bounds.min.y;
      const heightRange = Math.max(bounds.max.y - bounds.min.y, 1);
      const opacity = style.opacity ?? 1;
      const floorLineSpacing = style.floorLineSpacing ?? 4;
      const material = new THREE.ShaderMaterial({
        name: "Tiles3DLayer cyber building",
        uniforms: {
          uBottomColor: {
            value: new THREE.Color(style.bottomColor ?? 0x031a2a),
          },
          uTopColor: {
            value: new THREE.Color(style.topColor ?? 0x00eaff),
          },
          uAccentColor: {
            value: new THREE.Color(style.accentColor ?? 0xff8a2a),
          },
          uMinHeight: { value: minHeight },
          uHeightRange: { value: heightRange },
          uOpacity: { value: opacity },
          uEmissiveIntensity: { value: style.emissiveIntensity ?? 1.4 },
          uTopViewRoofStrength: {
            value: THREE.MathUtils.clamp(style.topViewRoofStrength ?? 0.55, 0, 1),
          },
          uFloorLineSpacing: {
            value: Math.max(floorLineSpacing, 0.01),
          },
          uFloorLineStrength: {
            value: floorLineSpacing > 0 ? (style.floorLineStrength ?? 0.28) : 0,
          },
          uScanStrength: { value: style.scanStrength ?? 0.3 },
          uScanSpeed: { value: style.scanSpeed ?? 0.08 },
          uTime: { value: 0 },
        },
        vertexShader: `
          #include <common>
          #include <logdepthbuf_pars_vertex>

          varying float vHeight;
          varying float vLocalHeight;
          varying float vRoof;
          varying vec3 vNormal;
          varying vec3 vViewPosition;
          uniform float uMinHeight;
          uniform float uHeightRange;

          void main() {
            vLocalHeight = position.y;
            vHeight = clamp((position.y - uMinHeight) / uHeightRange, 0.0, 1.0);
            vRoof = smoothstep(0.65, 0.95, normal.y);
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vViewPosition = -viewPosition.xyz;
            gl_Position = projectionMatrix * viewPosition;
            #include <logdepthbuf_vertex>
          }
        `,
        fragmentShader: `
          #include <logdepthbuf_pars_fragment>

          varying float vHeight;
          varying float vLocalHeight;
          varying float vRoof;
          varying vec3 vNormal;
          varying vec3 vViewPosition;
          uniform vec3 uBottomColor;
          uniform vec3 uTopColor;
          uniform vec3 uAccentColor;
          uniform float uMinHeight;
          uniform float uOpacity;
          uniform float uEmissiveIntensity;
          uniform float uTopViewRoofStrength;
          uniform float uFloorLineSpacing;
          uniform float uFloorLineStrength;
          uniform float uScanStrength;
          uniform float uScanSpeed;
          uniform float uTime;

          void main() {
            #include <logdepthbuf_fragment>

            float heightMix = pow(vHeight, 0.72);
            vec3 color = mix(uBottomColor, uTopColor, heightMix);

            vec3 normal = normalize(vNormal);
            vec3 viewDirection = normalize(vViewPosition);
            float sideLight = 0.91 + 0.09 * max(
              dot(normal, normalize(vec3(0.35, 0.42, 0.84))),
              0.0
            );
            float fresnel = pow(
              1.0 - clamp(abs(dot(normal, viewDirection)), 0.0, 1.0),
              2.0
            );
            color *= sideLight;
            color += uTopColor * fresnel * 0.08;

            float wallMask = 1.0 - vRoof;
            float floorPhase = (vLocalHeight - uMinHeight) * 6.28318530718
              / uFloorLineSpacing;
            float floorGlow = pow(max(cos(floorPhase), 0.0), 20.0);
            color += uTopColor * floorGlow * wallMask * uFloorLineStrength;

            float roofAccent = vRoof * (
              0.2 + 0.8 * smoothstep(0.12, 0.58, vHeight)
            );
            float towerAccent = smoothstep(0.42, 0.9, vHeight) * 0.48;
            color = mix(
              color,
              uAccentColor,
              clamp(roofAccent * 0.62 + towerAccent, 0.0, 0.76)
            );

            float topView = vRoof * pow(
              clamp(abs(dot(normal, viewDirection)), 0.0, 1.0),
              1.5
            );
            color = mix(
              color,
              uTopColor * 1.12,
              clamp(topView * uTopViewRoofStrength, 0.0, 1.0)
            );

            float scanPosition = fract(uTime * uScanSpeed);
            float scanDistance = abs(vHeight - scanPosition);
            float scanGlow = 1.0 - smoothstep(0.0, 0.035, scanDistance);
            color += mix(uTopColor, uAccentColor, 0.35)
              * scanGlow * uScanStrength;

            gl_FragColor = vec4(color * uEmissiveIntensity, uOpacity);
          }
        `,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        depthWrite: true,
      });

      mesh.material = material;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Tile-level culling already owns visibility and includes style exaggeration.
      mesh.frustumCulled = false;
      this.styledMaterials.add(material);

      const edgeWidth = style.edgeWidth ?? 1.25;
      const roofEdgeWidth = style.roofEdgeWidth ?? edgeWidth;
      if (edgeWidth > 0 || roofEdgeWidth > 0) {
        const sourceEdges = new THREE.EdgesGeometry(geometry, style.edgeThresholdAngle ?? 22);
        const positions = sourceEdges.getAttribute("position");
        const facadeSegments: number[] = [];
        const roofSegments: number[] = [];
        const roofBase = minHeight + 0.5;

        for (let index = 0; index + 1 < positions.count; index += 2) {
          const x0 = positions.getX(index);
          const y0 = positions.getY(index);
          const z0 = positions.getZ(index);
          const x1 = positions.getX(index + 1);
          const y1 = positions.getY(index + 1);
          const z1 = positions.getZ(index + 1);
          const isHorizontal = Math.abs(y1 - y0) <= 0.05;
          const target =
            isHorizontal && Math.min(y0, y1) > roofBase ? roofSegments : facadeSegments;
          target.push(x0, y0, z0, x1, y1, z1);
        }
        sourceEdges.dispose();

        const edgeColor = style.edgeColor ?? style.topColor ?? 0x18f6ff;
        const edgeOpacity = style.edgeOpacity ?? 0.95;
        const edgeIntensity = style.edgeIntensity ?? 2.4;
        this.addEdgeOverlay(mesh, facadeSegments, {
          name: "Tiles3DLayer building edges",
          color: edgeColor,
          width: edgeWidth,
          opacity: edgeOpacity,
          intensity: edgeIntensity,
          renderOrderOffset: 1,
        });
        this.addEdgeOverlay(mesh, roofSegments, {
          name: "Tiles3DLayer roof edges",
          color: style.roofEdgeColor ?? edgeColor,
          width: roofEdgeWidth,
          opacity: style.roofEdgeOpacity ?? edgeOpacity,
          intensity: style.roofEdgeIntensity ?? edgeIntensity,
          renderOrderOffset: 2,
        });
      }
    }

    for (const material of sourceMaterials) material.dispose();
  }

  // ─── 可见性维护 + LRU 卸载 ─────────────────────────────────

  private evictIfNeeded() {
    // 卸载本帧不可见的瓦片
    for (const tile of this.loadedTiles) {
      if (tile.lastFrameVisible !== this.frameCount && tile.group) {
        this.remove(tile.group);
      }
    }

    // 超出缓存上限：按最近访问时间卸载最久未用的
    if (this.loadedTiles.size > this.maxCacheSize) {
      const sorted = [...this.loadedTiles].sort((a, b) => a.lastFrameVisible - b.lastFrameVisible);
      const toRemove = sorted.slice(0, this.loadedTiles.size - this.maxCacheSize);
      for (const tile of toRemove) {
        this.disposeTile(tile);
      }
    }
  }

  private disposeTile(tile: Tile3D) {
    if (tile.group) {
      this.remove(tile.group);
      tile.group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const materials = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const material of materials) {
          if (material instanceof LineMaterial) {
            this.edgeMaterials.delete(material);
          }
          if (material instanceof THREE.ShaderMaterial) {
            this.styledMaterials.delete(material);
          }
          material.dispose();
        }
      });
      tile.group.traverse((obj) => {
        if (obj instanceof THREE.Group) this.styledModels.delete(obj);
      });
      tile.group = null;
    }
    tile.state = TileState.Unloaded;
    this.loadedTiles.delete(tile);
  }

  // ─── 释放 ───────────────────────────────────────────────────

  public dispose() {
    this.disposed = true;
    this.queue.length = 0;
    for (const tile of this.loadedTiles) this.disposeTile(tile);
    this.loadedTiles.clear();
    this.styledMaterials.clear();
    this.styledModels.clear();
    this.edgeMaterials.clear();
  }
}

// ─── 坐标工具 ───────────────────────────────────────────────────

/** 大地坐标（弧度,弧度,米）→ ECEF */
function geodeticToEcef(lngRad: number, latRad: number, h: number): THREE.Vector3 {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (N + h) * cosLat * Math.cos(lngRad);
  const y = (N + h) * cosLat * Math.sin(lngRad);
  const z = (N * (1 - WGS84_E2) + h) * sinLat;
  return new THREE.Vector3(x, y, z);
}

/** ECEF → 大地坐标 [lngRad, latRad, h] */
function ecefToGeodetic(p: THREE.Vector3): [number, number, number] {
  const a = WGS84_A;
  const e2 = WGS84_E2;
  const lng = Math.atan2(p.y, p.x);
  const pDist = Math.hypot(p.x, p.y);
  // 迭代求纬度（Bowring 初值）
  let lat = Math.atan2(p.z, pDist * (1 - e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    h = pDist / Math.cos(lat) - N;
    lat = Math.atan2(p.z, pDist * (1 - e2 * (N / (N + h))));
  }
  return [lng, lat, h];
}

/** 构建 ECEF → ENU（东,北,上）旋转矩阵（以给定大地坐标为原点） */
function ecefToEnuMatrix(lngRad: number, latRad: number): THREE.Matrix4 {
  const sinLng = Math.sin(lngRad),
    cosLng = Math.cos(lngRad);
  const sinLat = Math.sin(latRad),
    cosLat = Math.cos(latRad);

  // ECEF → ENU 旋转矩阵：行向量为 E/N/U 在 ECEF 中的方向
  // E = [-sinLng, cosLng, 0]
  // N = [-sinLat*cosLng, -sinLat*sinLng, cosLat]
  // U = [cosLat*cosLng, cosLat*sinLng, sinLat]
  const m = new THREE.Matrix4();
  // m.set 按行填充：Row0=E, Row1=N, Row2=U
  m.set(
    -sinLng,
    cosLng,
    0,
    0,
    -sinLat * cosLng,
    -sinLat * sinLng,
    cosLat,
    0,
    cosLat * cosLng,
    cosLat * sinLng,
    sinLat,
    0,
    0,
    0,
    0,
    1,
  );
  return m;
}
