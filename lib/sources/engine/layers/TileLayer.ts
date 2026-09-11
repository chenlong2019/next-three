import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { RasterTileLayer, RasterTileLayerOptions } from "./RasterTileLayer";

export type TileLayerOptions = RasterTileLayerOptions;

/**
 * XYZ 瓦片图层（高德/Google/OSM 等 slippy map 瓦片）
 *
 * 继承 RasterTileLayer 的全部能力：
 * 优先级队列、多级LOD、LRU缓存、父级Fallback、z-fighting防护。
 *
 * 用法：
 * ```ts
 * const layer = new TileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', gis);
 * scene.add(layer);
 * ```
 */
export class TileLayer extends RasterTileLayer {
  constructor(urlTemplate: string, gis: WebMercatorGIS, options: TileLayerOptions = {}) {
    super(gis, { urlTemplate }, options);
  }
}
