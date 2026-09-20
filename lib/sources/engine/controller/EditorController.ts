import { ToolType } from "../../types/tool";
import { DrawingManager } from "../three/DrawingManager";

/**
 * 编辑器工具控制器
 * @remarks
 * 负责将上层工具栏工具类型映射至DrawingManager对应的绘制行为
 * 切换选择/空工具时终止当前绘制流程
 */
export class EditorController {
  /**
   * 构造编辑器控制器
   * @param drawingManager 三维绘制管理器实例
   */
  constructor(private drawingManager: DrawingManager) {}

  /**
   * 切换当前编辑工具，触发对应绘制模式启动/停止
   * @param tool 目标工具类型枚举
   */
  setTool(tool: ToolType): void {
    switch (tool) {
      case ToolType.WALL:
        this.drawingManager.startPolygon();
        break;
      case ToolType.TRENCH:
        this.drawingManager.startPolygon();
        break;
      case ToolType.CABLE:
        this.drawingManager.startLine();
        break;
      case ToolType.SELECT:
      case ToolType.NONE:
        this.drawingManager.stop();
        break;
    }
  }
}
