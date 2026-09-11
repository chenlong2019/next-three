import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { TileRequest } from "./TileRequestQueue";
import { RasterTileLayer, RasterTileLayerOptions } from "./RasterTileLayer";

/**
 * TMS 服务配置（Tile Map Service）
 */
export interface TMSOptions {
  /** TMS 服务基础地址（如 https://example.com/tms/1.0.0/layer） */
  url: string;
  /** 图片格式扩展名（默认 png） */
  format?: string;
  /** 是否翻转Y轴（TMS规范默认true，即Y=0在南端） */
  flipY?: boolean;
}

export type TMSLayerOptions = RasterTileLayerOptions;

/**
 * TMS 图层（Tile Map Service）
 *
 * TMS 与 XYZ 瓦片的唯一区别：Y 轴方向相反。
 * - XYZ（slippy map）：Y=0 在北端（左上角）
 * - TMS：Y=0 在南端（左下角）
 *
 * 转换公式：tmsY = (2^zoom - 1) - xyzY
 *
 * 继承 RasterTileLayer 全部能力：
 * 优先级队列、多级LOD、LRU缓存、父级Fallback、z-fighting防护。
 *
 * 用法：
 * ```ts
 * const layer = new TMSLayer(gis, {
 *   url: 'https://example.com/tms/1.0.0/my_layer',
 *   format: 'png',
 * });
 * scene.add(layer);
 * ```
 */
export class TMSLayer extends RasterTileLayer {
  private tmsOpts: Required<TMSOptions>;

  constructor(gis: WebMercatorGIS, tmsOptions: TMSOptions, layerOptions: TMSLayerOptions = {}) {
    super(gis, { buildUrl: (req) => TMSLayer.buildTmsUrl(req, tmsOptions) }, layerOptions);

    this.tmsOpts = {
      url: tmsOptions.url,
      format: tmsOptions.format ?? "png",
      flipY: tmsOptions.flipY ?? true,
    };
  }

  /**
   * 构建 TMS 瓦片 URL
   * 格式：{url}/{z}/{x}/{y}.{format}
   */
  private static buildTmsUrl(req: TileRequest, opts: TMSOptions): string {
    const format = opts.format ?? "png";
    const flipY = opts.flipY ?? true;

    let y = req.y;
    if (flipY) {
      // TMS Y轴翻转：Y=0 在南端
      y = Math.pow(2, req.zoom) - 1 - req.y;
    }

    const base = opts.url.endsWith("/") ? opts.url.slice(0, -1) : opts.url;
    return `${base}/${req.zoom}/${req.x}/${y}.${format}`;
  }
}
