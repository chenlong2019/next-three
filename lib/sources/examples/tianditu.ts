import type { TileLayerOptions } from "../engine/layers/TileLayer";
import type { MapExampleRasterLayer } from "./createMapExample";
import { requestScheduler } from "../engine/layers/RequestScheduler";
import { getTileRequestGroup } from "../engine/layers/TileUrlTemplate";

export type TiandituLayerType = "vec_w" | "img_w" | "cva_w" | "cia_w";

/**
 * 天地图浏览器端 token（tk）兜底值。
 *
 * 仓库**不内置任何真实 token**。请通过以下任一方式提供：
 *   1. 环境变量 `NEXT_PUBLIC_TIANDITU_TOKEN`（Next.js 会在构建期静态替换）；
 *   2. 直接调用 `createTiandituUrl(type, "你的token")` 显式传入。
 *
 * 取不到时返回空串，天地图会返回 403 —— 便于在 Network 面板直接定位配置缺失。
 */
export const DEFAULT_TIANDITU_TOKEN = process.env.NEXT_PUBLIC_TIANDITU_TOKEN ?? "";
export const TIANDITU_SUBDOMAINS = Array.from({ length: 8 }, (_, index) => String(index));
export const TIANDITU_REQUEST_GROUP = "tianditu";
/** 单个图层自己的并发参考值（组级总控会进一步约束总量）。 */
export const TIANDITU_MAX_CONCURRENT = 2;
/**
 * 天地图单 token 的总控并发上限：影像层、注记层、地形影像等所有消费
 * 同一 token 的图层共享这一个总控，避免叠加并发触发天地图风控封 token。
 */
export const TIANDITU_GLOBAL_MAX_CONCURRENT = 4;

requestScheduler.registerGroupLimit(TIANDITU_REQUEST_GROUP, TIANDITU_GLOBAL_MAX_CONCURRENT);
// 兜底：未显式传 requestGroup 的图层会按模板派生组名（tile-template:...），
// 同样纳入总控，保证任何路径的天地图请求都计入同一配额。
const templateGroup = getTileRequestGroup(createTiandituUrl("img_w"));
if (templateGroup) {
  requestScheduler.registerGroupLimit(templateGroup, TIANDITU_GLOBAL_MAX_CONCURRENT);
}

/**
 * 拼天地图瓦片地址。
 *
 * @param type  图层类型（vec_w / img_w / cva_w / cia_w）
 * @param token 天地图浏览器端 token；缺省时回退到 `NEXT_PUBLIC_TIANDITU_TOKEN`。
 *              非 Next.js 环境（或未配置环境变量）请显式传入。
 */
export function createTiandituUrl(
  type: TiandituLayerType,
  token: string = DEFAULT_TIANDITU_TOKEN,
): string {
  return `https://t{s}.tianditu.gov.cn/DataServer?T=${type}&x={x}&y={y}&l={z}&tk=${token}`;
}

const TIANDITU_TILE_OPTIONS = {
  minZoom: 1,
  maxZoom: 18,
  maxConcurrent: 4,
  maxRequestsPerFrame: 2,
  maxQueueSize: 192,
  maxCacheSize: 180,
  maxTilesPerView: 96,
  maxLodLevels: 1,
  lodNearRadiusMultiplier: 1.5,
  subdomains: TIANDITU_SUBDOMAINS,
  requestGroup: TIANDITU_REQUEST_GROUP,
  maximumRequestsPerServer: TIANDITU_MAX_CONCURRENT,
  failureCooldownMs: 30_000,
} as const;

export function createTiandituLayer({
  id,
  type,
  enabled = true,
  altitude = 0,
  options,
}: {
  id: string;
  type: TiandituLayerType;
  enabled?: boolean;
  altitude?: number;
  options?: TileLayerOptions;
}): MapExampleRasterLayer {
  const annotation = type === "cva_w" || type === "cia_w";
  return {
    id,
    url: createTiandituUrl(type),
    enabled,
    options: {
      ...TIANDITU_TILE_OPTIONS,
      altitude,
      transparent: annotation,
      ...(annotation ? { maxCacheSize: 120, maxConcurrent: 6 } : {}),
      ...options,
    },
  };
}

export function createTiandituImageryLayers({
  enabled = true,
  annotations = true,
}: {
  enabled?: boolean;
  annotations?: boolean;
} = {}): MapExampleRasterLayer[] {
  return [
    createTiandituLayer({
      id: "tianditu-imagery",
      type: "img_w",
      enabled,
    }),
    ...(annotations
      ? [
        createTiandituLayer({
          id: "tianditu-imagery-annotation",
          type: "cia_w",
          enabled,
          altitude: 1,
        }),
      ]
      : []),
  ];
}
