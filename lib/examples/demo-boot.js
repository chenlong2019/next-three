/**
 * three-gis 演示页面的公共启动逻辑。
 *
 * 刻意写成普通脚本（非 ES module）：这样「全局脚本」和「ESM + importmap」两种页面
 * 可以共用同一份代码——全局页直接调 window.bootThreeGis(ThreeGIS)，
 * ESM 页 import 构建产物之后把模块命名空间传进来。
 */
(function () {
  /**
   * 天地图 token 由使用方提供，仓库不内置（避免密钥进入公开仓库）。
   * 读取优先级：window.__THREE_GIS_CONFIG__.tiandituToken > URL 的 ?tk= 参数 > 空串。
   * 用法：打开页面时加 `?tk=你的天地图token`。
   */
  function resolveTiandituToken() {
    var config = window.__THREE_GIS_CONFIG__;
    if (config && config.tiandituToken) return String(config.tiandituToken);
    try {
      return new URLSearchParams(window.location.search).get("tk") || "";
    } catch (error) {
      return "";
    }
  }

  function bootThreeGis(ThreeGIS) {
    const status = document.getElementById("status");
    const setStatus = (text) => {
      if (status) status.textContent = text;
    };

    const {
      Scene,
      WebMercatorGIS,
      TileLayer,
      getViewGroundCorners,
      cornersToLngLatBounds,
      getSuggestZoom,
    } = ThreeGIS;

    // 场景初始化必须在真实容器里，容器需要有非零尺寸
    const container = document.getElementById("app");
    const gis = new WebMercatorGIS(118.1371, 24.49);
    const scene = new Scene(container, { gis });
    const tiandituToken = resolveTiandituToken();

    return scene
      .ready()
      .then(() => {
        scene.flyTo(118.1371, 24.49, 120000);

        // 天地图影像：token 不在仓库内置，请用 ?tk=xxx 传入（跨域请求在自动化测试中会被拦截）
        const imagery = new TileLayer(
          "https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=" + tiandituToken,
          gis,
          {
            minZoom: 1,
            maxZoom: 18,
            subdomains: ["0", "1", "2", "3", "4", "5", "6", "7"],
            maxConcurrent: 4,
            maxCacheSize: 180,
          },
        );
        scene.add(imagery);

        scene.addFrameCallback("demo-update-tiles", () => {
          const camera = scene.getCamera();
          if (!camera) return;

          const controller = scene.getGISController();
          const target = controller?.controls?.target ?? camera.position.clone();
          const cameraDistance = camera.position.distanceTo(target);
          const latitude = controller?.getTargetLngLat?.()?.[1] ?? 24.49;

          const corners = getViewGroundCorners(camera, 0);
          const bounds = cornersToLngLatBounds(corners, gis);
          if (!bounds) return;

          const zoom = getSuggestZoom(
            cameraDistance,
            camera.fov,
            container.clientHeight || 900,
            latitude,
          );

          imagery.updateTilesInView(
            [bounds.west, bounds.east],
            [bounds.south, bounds.north],
            zoom,
            target,
            cameraDistance,
            camera,
          );
        });

        window.__threeGisDemo = { scene, gis, imagery };
        window.__threeGisReady = true;
        setStatus(
          tiandituToken
            ? "场景就绪 · WebGL 已初始化"
            : "场景就绪 · WebGL 已初始化（未提供天地图 token，影像不可见；用 ?tk=xxx 打开）",
        );
        return scene;
      })
      .catch((error) => {
        window.__threeGisError = String((error && error.stack) || error);
        setStatus("初始化失败：" + ((error && error.message) || error));
        throw error;
      });
  }

  window.bootThreeGis = bootThreeGis;
})();
