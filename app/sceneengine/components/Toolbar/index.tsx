"use client";

import { useEffect, useState } from "react";
import styles from "./TopToolbar.module.css";
import { drawingManager } from "@/lib/sources/engine/draw/DrawingManager";

export default function TopToolbar() {
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    const unsubscribe = drawingManager.onStateChange((running) => {
      setIsDrawing(running);
    });
    return unsubscribe;
  }, []);

  const drawRectLayer = async () => {
    console.log("开始绘制矩形图层");
    await new Promise((r) => setTimeout(r, 1200));
    console.log("矩形图层绘制完成");
  };

  const drawCircleLayer = async () => {
    console.log("开始绘制圆形图层");
    await new Promise((r) => setTimeout(r, 800));
    console.log("圆形图层绘制完成");
  };

  const handleAddRect = () => {
    drawingManager
      .addTask(drawRectLayer)
      .then(() => console.log("矩形图层绘制完成回调"))
      .catch((err) => console.error(err));
  };

  const handleAddCircle = () => {
    drawingManager.addTask(drawCircleLayer);
  };

  const handleClearQueue = () => {
    drawingManager.clearQueue();
  };

  const handleStopFreeDraw = () => {
    drawingManager.stopFreeDraw();
  };

  return (
    <div className={styles.toolbarWrap}>
      <div className={styles.toolGroup}>
        <button disabled={isDrawing} onClick={handleAddRect} className={styles.toolBtn}>
          ▭ 矩形图层
        </button>
        <button disabled={isDrawing} onClick={handleAddCircle} className={styles.toolBtn}>
          ○ 圆形图层
        </button>
      </div>

      <div className={styles.divider} />

      <div className={styles.toolGroup}>
        <button onClick={handleClearQueue} className={styles.toolBtn}>
          ⟲ 清空任务
        </button>
        <button disabled={!isDrawing} onClick={handleStopFreeDraw} className={styles.toolBtn}>
          ⏹ 停止绘制
        </button>
      </div>

      <div className={styles.statusBox}>
        <span className={isDrawing ? styles.statusActive : styles.statusIdle}>
          {isDrawing ? "绘制中…" : "就绪"}
        </span>
      </div>
    </div>
  );
}
