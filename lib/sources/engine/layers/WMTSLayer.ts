import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { TileRequest } from "./TileRequestQueue";
import { RasterTileLayer, RasterTileLayerOptions } from "./RasterTileLayer";

/**
 * WMTS 服务配置（OGC Web Map Tile Service）
 */
export interface WMTSOptions {
  /** WMTS 服务地址（如 https://example.com/geoserver/gwc/service/wmts） */
  url: string;
  /** 图层名 */
  layer: string;
  /** TileMatrixSet 标识（如 'EPSG:3857'、'GoogleMapsCompatible'） */
  tileMatrixSet: string;
  /** 样式（默认 'default'） */
  style?: string;
  /** 输出图片格式（默认 image/png） */
  format?: string;
  /**
   * TileMatrix 标识生成函数
   * 默认返回 zoom 数字字符串（如 "0", "1", "2"...）
   * 某些服务需要前缀，如 (z) => `EPSG:3857:${z}`
   */
  tileMatrixLabel?: (zoom: number) => string;
  /** 额外查询参数 */
  extraParams?: Record<string, string>;
}

export type WMTSLayerOptions = RasterTileLayerOptions;

/**
 * WMTS 图层（OGC Web Map Tile Service）
 *
 * 通过 KVP（Key-Value Pair）编码方式请求瓦片。
 * WMTS 瓦片网格与标准 slippy map 一致（Y=0 在北端），无需翻转。
 *
 * 继承 RasterTileLayer 全部能力：
 * 优先级队列、多级LOD、LRU缓存、父级Fallback、z-fighting防护。
 *
 * 用法：
 * ```ts
 * const layer = new WMTSLayer(gis, {
 *   url: 'https://example.com/geoserver/gwc/service/wmts',
 *   layer: 'topp:states',
 *   tileMatrixSet: 'EPSG:3857',
 *   tileMatrixLabel: (z) => `EPSG:3857:${z}`,
 * });
 * scene.add(layer);
 * ```
 */
export class WMTSLayer extends RasterTileLayer {
  private wmtsOpts: Required<Omit<WMTSOptions, "extraParams" | "tileMatrixLabel">> & {
    tileMatrixLabel: (zoom: number) => string;
    extraParams: Record<string, string>;
  };

  constructor(gis: WebMercatorGIS, wmtsOptions: WMTSOptions, layerOptions: WMTSLayerOptions = {}) {
    super(gis, { buildUrl: (req) => WMTSLayer.buildWmtsUrl(req, wmtsOptions) }, layerOptions);

    this.wmtsOpts = {
      url: wmtsOptions.url,
      layer: wmtsOptions.layer,
      tileMatrixSet: wmtsOptions.tileMatrixSet,
      style: wmtsOptions.style ?? "default",
      format: wmtsOptions.format ?? "image/png",
      tileMatrixLabel: wmtsOptions.tileMatrixLabel ?? ((z) => String(z)),
      extraParams: wmtsOptions.extraParams ?? {},
    };
  }

  /**
   * 构建 WMTS GetTile KVP URL
   */
  private static buildWmtsUrl(req: TileRequest, opts: WMTSOptions): string {
    const style = opts.style ?? "default";
    const format = opts.format ?? "image/png";
    const tileMatrixLabel = opts.tileMatrixLabel ?? ((z) => String(z));
    const extraParams = opts.extraParams ?? {};

    const params = new URLSearchParams({
      SERVICE: "WMTS",
      REQUEST: "GetTile",
      VERSION: "1.0.0",
      LAYER: opts.layer,
      STYLE: style,
      TILEMATRIXSET: opts.tileMatrixSet,
      TILEMATRIX: tileMatrixLabel(req.zoom),
      TILEROW: String(req.y),
      TILECOL: String(req.x),
      FORMAT: format,
      ...extraParams,
    });

    const sep = opts.url.includes("?") ? "&" : "?";
    return `${opts.url}${sep}${params.toString()}`;
  }
}
