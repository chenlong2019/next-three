"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { demoList } from "./demos";
import type { DemoKey } from "./demoRoutes";
import styles from "./page.module.css";

export default function ExamplesExplorer({
  activeKey,
  standalone = false,
}: {
  activeKey: DemoKey;
  standalone?: boolean;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentDemoItem = demoList.find((demo) => demo.key === activeKey);
  const DemoComponent = currentDemoItem?.component;

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen();
      } else {
        if (document.fullscreenElement) await document.exitFullscreen();
        await container.requestFullscreen();
      }
    } catch (error) {
      console.error("切换全屏失败", error);
    }
  };

  return (
    <main className={`${styles.shell} ${standalone ? styles.standaloneShell : ""}`}>
      {!standalone && (
        <nav className={styles.menu} aria-label="GIS demos" role="tablist">
          {demoList.map((demo) => {
            const isActive = activeKey === demo.key;
            return (
              <Link
                key={demo.key}
                href={`/examples/${demo.key}`}
                role="tab"
                aria-selected={isActive}
                className={styles.tab}
                data-active={isActive}
              >
                {demo.label}
              </Link>
            );
          })}
        </nav>
      )}

      <div
        className={`${styles.content} ${currentDemoItem?.immersive ? styles.immersiveContent : ""} ${standalone ? styles.standaloneContent : ""}`}
      >
        <div
          ref={containerRef}
          className={`${styles.viewport} ${currentDemoItem?.immersive ? styles.immersiveViewport : ""} ${standalone ? styles.standaloneViewport : ""}`}
        >
          {!standalone && (
            <Link
              href={`/examples/${activeKey}/fullscreen`}
              className={`${styles.fullscreenButton} ${styles.fullscreenRouteButton}`}
              aria-label="打开独立全屏地图页面"
              title="打开独立全屏地图页面"
            >
              <ExternalLink aria-hidden="true" size={18} strokeWidth={2} />
            </Link>
          )}
          <button
            type="button"
            className={styles.fullscreenButton}
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "退出全屏" : "进入全屏"}
            title={isFullscreen ? "退出全屏" : "进入全屏"}
          >
            {isFullscreen ? (
              <Minimize2 aria-hidden="true" size={18} strokeWidth={2} />
            ) : (
              <Maximize2 aria-hidden="true" size={18} strokeWidth={2} />
            )}
          </button>
        </div>
        <div className={standalone ? styles.hiddenDemoUi : styles.demoUi}>
          {DemoComponent && <DemoComponent key={activeKey} containerRef={containerRef} />}
        </div>
      </div>
    </main>
  );
}
