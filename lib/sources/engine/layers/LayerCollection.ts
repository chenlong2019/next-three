import { LayerCollectionEvents } from "../../types/layers";
import { Layer } from "./Layer";

export class LayerCollection {
  private readonly _layers: Layer[] = [];
  private _events: LayerCollectionEvents = {};

  get length(): number {
    return this._layers.length;
  }

  get layers(): readonly Layer[] {
    return [...this._layers];
  }

  setEvents(events: LayerCollectionEvents): void {
    this._events = events;
  }

  get(index: number): Layer | undefined {
    return this._layers[index];
  }

  getById(id: string): Layer | undefined {
    return this._layers.find((l) => l.id === id);
  }

  indexOf(layer: Layer): number {
    return this._layers.indexOf(layer);
  }

  contains(layer: Layer): boolean {
    return this._layers.includes(layer);
  }

  add(layer: Layer): void {
    const idx = this._layers.length;
    this._layers.push(layer);
    this._events.layerAdded?.(layer, idx);
  }

  addAt(layer: Layer, index: number): void {
    this._layers.splice(index, 0, layer);
    this._events.layerAdded?.(layer, index);
  }

  remove(layer: Layer): boolean {
    const idx = this.indexOf(layer);
    if (idx === -1) return false;
    this._layers.splice(idx, 1);
    this._events.layerRemoved?.(layer, idx);
    return true;
  }

  removeAll(): void {
    const snapshot = [...this._layers];
    snapshot.forEach((layer) => this.remove(layer));
  }

  move(layer: Layer, newIndex: number): void {
    const oldIndex = this.indexOf(layer);
    if (oldIndex === -1 || oldIndex === newIndex) return;
    this._layers.splice(oldIndex, 1);
    this._layers.splice(newIndex, 0, layer);
    this._events.layerMoved?.(layer, newIndex, oldIndex);
  }

  notifyUpdate(layer: Layer): void {
    this._events.layerUpdated?.(layer);
  }

  /** 获取所有图层UI视图数组 */
  toViewArray() {
    return this._layers.map((l) => l.toView());
  }
}
