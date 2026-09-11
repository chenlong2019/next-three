import { BasePrimitive, IPrimitiveStatic, PrimitiveSerializedJson } from "./BasePrimitive";
import { BoxPrimitive } from "./BoxPrimitive";
import { SpherePrimitive } from "./SpherePrimitive";
import { PolylinePrimitive } from "./PolylinePrimitive";
import { PolygonPrimitive } from "./PolygonPrimitive";

/**
 * 图元类型注册表
 * @internal
 * key：图元类型标识字符串，value：实现IPrimitiveStatic的图元类
 */
const registry = new Map<string, IPrimitiveStatic>();
registry.set(BoxPrimitive.type, BoxPrimitive);
registry.set(SpherePrimitive.type, SpherePrimitive);
registry.set(PolylinePrimitive.type, PolylinePrimitive);
registry.set(PolygonPrimitive.type, PolygonPrimitive);

/**
 * 图元工厂
 * @remarks
 * 根据序列化JSON中的primitiveType，自动匹配对应图元类完成实例重建
 * 采用注册机制，新增图元只需在registry注册，无需修改工厂主逻辑
 */
export class PrimitiveFactory {
  /**
   * 根据JSON序列化数据自动创建对应图元实例
   * @param json 图元序列化对象，必须包含 primitiveType 字段
   * @returns 继承 BasePrimitive 的图元实例
   * @throws 当注册表不存在对应 primitiveType 时抛出异常
   */
  static createFromJSON(json: PrimitiveSerializedJson): BasePrimitive {
    const primitiveType = json.primitiveType;
    const ctor = registry.get(primitiveType);
    if (!ctor) {
      throw new Error(`未知Primitive类型: ${primitiveType}`);
    }
    return ctor.fromJSON(json);
  }
}
