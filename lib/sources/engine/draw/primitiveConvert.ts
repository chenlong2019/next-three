// primitiveConvert.ts
import * as THREE from "three";
import { DrawEntity } from "../three/DrawingManager";
import { BasePrimitive } from "../primitives/BasePrimitive";
import { PolygonPrimitive } from "../primitives/PolygonPrimitive";
import { PolylinePrimitive } from "../primitives/PolylinePrimitive";
import { SpherePrimitive } from "../primitives/SpherePrimitive";

/**
 * 将绘制输出实体 DrawEntity 转换为 BasePrimitive 图元实例
 * @remarks
 * 映射规则：
 * - marker  → SpherePrimitive（单点标记球）
 * - line    → PolylinePrimitive（开放折线）
 * - wall    → PolygonPrimitive（闭合拉伸多边形墙体）
 * @param entity 绘图管理器双击完成后输出实体
 * @returns 对应类型图元实例
 * @throws 遇到不支持的 entity.type 抛出异常
 */
export function drawEntityToPrimitive(entity: DrawEntity): BasePrimitive {
  const points = entity.positions.map((p) => new THREE.Vector3(p.x, p.y, p.z));

  switch (entity.type) {
    case "marker": {
      const props = entity.props as { size?: number };
      const radius = props.size ?? 1;
      return new SpherePrimitive({
        id: entity.id,
        position: points[0].clone(),
        style: {
          color: "#ff4444",
          radius,
        },
      });
    }

    case "line": {
      const props = entity.props as { width?: number };
      const lineWidth = props.width ?? 0.3;
      return new PolylinePrimitive({
        id: entity.id,
        points,
        style: {
          color: "#00ffff",
          lineWidth,
        },
      });
    }

    case "wall": {
      const props = entity.props as { depth?: number };
      const depth = props.depth ?? 5;
      return new PolygonPrimitive({
        id: entity.id,
        points,
        style: {
          color: "#4a9eff",
          depth,
        },
      });
    }

    default:
      throw new Error(`无法转换DrawEntity，未知类型: ${entity.type}`);
  }
}

/**
 * 将 BasePrimitive 图元反向转换为 DrawEntity
 * @remarks
 * 映射规则：
 * - SpherePrimitive   → marker
 * - PolylinePrimitive → line
 * - PolygonPrimitive  → wall
 * @param primitive 基础图元实例
 * @returns DrawEntity 绘图实体
 * @throws 遇到不支持的图元类型抛出异常
 */
export function primitiveToDrawEntity(primitive: BasePrimitive): DrawEntity {
  if (primitive instanceof SpherePrimitive) {
    const sphere = primitive as SpherePrimitive;
    return {
      id: sphere.id,
      type: "marker",
      positions: [{ x: sphere.position.x, y: sphere.position.y, z: sphere.position.z }],
      props: {
        size: sphere.style.radius,
      },
    };
  }

  if (primitive instanceof PolylinePrimitive) {
    const polyline = primitive as PolylinePrimitive;
    return {
      id: polyline.id,
      type: "line",
      positions: polyline.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      props: {
        width: polyline.style.lineWidth,
      },
    };
  }

  if (primitive instanceof PolygonPrimitive) {
    const polygon = primitive as PolygonPrimitive;
    return {
      id: polygon.id,
      type: "wall",
      positions: polygon.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      props: {
        depth: polygon.style.depth,
      },
    };
  }

  throw new Error(`无法转换Primitive，不支持图元类型: ${primitive.constructor.name}`);
}
