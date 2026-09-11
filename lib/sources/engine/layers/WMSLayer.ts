import { getTileBounds } from "../utils/gis-utils";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { TileRequest } from "./TileRequestQueue";
import { RasterTileLayer, RasterTileLayerOptions } from "./RasterTileLayer";

/**
 * WMS 服务配置（OGC Web Map Service）
 */
export interface WMSOptions {
  /** WMS 服务地址（如 https://example.com/geoserver/wms） */
  url: string;
  /** 图层名，多图层用逗号分隔 */
  layers: string;
  /** WMS 版本（默认 1.3.0） */
  version?: string;
  /** 输出图片格式（默认 image/png） */
  format?: string;
  /** 是否透明（默认 true） */
  transparent?: boolean;
  /** 请求图片尺寸（默认 256） */
  tileSize?: number;
  /** 样式（默认空） */
  styles?: string;
  /** 额外查询参数（如 CQL_FILTER） */
  extraParams?: Record<string, string>;
}

export type WMSLayerOptions = RasterTileLayerOptions;

/** 地球半径（Web墨卡托） */
/**
 * WMS 图层
 *
 * 通过 OGC WMS GetMap 协议按瓦片 BBOX 请求地图图片。
 * 继承 RasterTileLayer 的全部能力：
 * 优先级队列、多级LOD、LRU缓存、父级Fallback、z-fighting防护。
 *
 * 坐标系：BBOX 使用 EPSG:3857（Web墨卡托米坐标），与瓦片系统一致。
 * 注意 WMS 1.3.0 的 EPSG:3857 轴序为 (x=东, y=北)，即 minx,miny,maxx,maxy。
 *
 * 用法：
 * ```ts
 * const layer = new WMSLayer(gis, {
 *   url: 'https://example.com/geoserver/wms',
 *   layers: 'topp:states',
 * });
 * scene.add(layer);
 * ```
 */
export class WMSLayer extends RasterTileLayer {
  private opts: Required<Omit<WMSOptions, "extraParams">> & { extraParams: Record<string, string> };

  constructor(gis: WebMercatorGIS, wmsOptions: WMSOptions, layerOptions: WMSLayerOptions = {}) {
    // buildUrl 是延迟调用（请求时才执行），此时 this.opts 已赋值
    super(gis, { buildUrl: (req) => this.buildWmsUrl(req) }, layerOptions);

    this.opts = {
      url: wmsOptions.url,
      layers: wmsOptions.layers,
      version: wmsOptions.version ?? "1.3.0",
      format: wmsOptions.format ?? "image/png",
      transparent: wmsOptions.transparent ?? true,
      tileSize: wmsOptions.tileSize ?? 256,
      styles: wmsOptions.styles ?? "",
      extraParams: wmsOptions.extraParams ?? {},
    };
  }

  // ─── WMS URL 构建 ───────────────────────────────────────────

  /**
   * 经纬度 → Web墨卡托米坐标
   */
  /**
   * 根据瓦片 xyz 构建 WMS GetMap URL
   */
  private buildWmsUrl(req: TileRequest): string {
    const bounds = getTileBounds(req.x, req.y, req.zoom);
    const [minx, miny] = this.gis.lngLatToMercator(bounds.west, bounds.south);
    const [maxx, maxy] = this.gis.lngLatToMercator(bounds.east, bounds.north);

    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: this.opts.version,
      REQUEST: "GetMap",
      LAYERS: this.opts.layers,
      STYLES: this.opts.styles,
      CRS: "EPSG:3857",
      BBOX: `${minx},${miny},${maxx},${maxy}`,
      WIDTH: String(this.opts.tileSize),
      HEIGHT: String(this.opts.tileSize),
      FORMAT: this.opts.format,
      TRANSPARENT: String(this.opts.transparent).toUpperCase(),
      ...this.opts.extraParams,
    });

    const sep = this.opts.url.includes("?") ? "&" : "?";
    return `${this.opts.url}${sep}${params.toString()}`;
  }
}
