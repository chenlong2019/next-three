import Link from "next/link";
import {
  ArrowUpRight,
  Box,
  Braces,
  ChevronRight,
  CircleDot,
  Code2,
  Layers3,
  Map,
  Orbit,
  Play,
  Sparkles,
} from "lucide-react";

const capabilities = [
  { icon: Map, title: "地理空间底座", copy: "Web Mercator、地形与 3D Tiles" },
  { icon: Layers3, title: "图层系统", copy: "树形组织、显隐、锁定与复制" },
  { icon: Orbit, title: "相机控制", copy: "轨道、缩放与场景导航" },
  { icon: Box, title: "几何与材质", copy: "面向 CAD 的可组合实体" },
];

const demos = [
  { key: "scene-init", label: "场景初始化", type: "CORE" },
  { key: "google-tiles", label: "Google 瓦片加载", type: "TILES" },
  { key: "cesium-terrain", label: "Cesium 地形加载", type: "TERRAIN" },
  { key: "draw", label: "点线面绘制", type: "TOOLS" },
];

export default function Home() {
  return (
    <div className="product-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="next-three 首页">
          <span className="brand-mark"><CircleDot size={18} strokeWidth={2.4} /></span>
          <span>next<span className="brand-accent">-</span>three</span>
        </Link>
        <nav className="topnav" aria-label="主导航">
          <Link className="active" href="/">概览</Link>
          <Link href="/examples">示例</Link>
          <Link href="/sceneengine">场景引擎</Link>
          <Link href="/docs">API 文档</Link>
        </nav>
        <div className="top-actions">
          <span className="status"><i /> ENGINE ONLINE</span>
          <Link className="icon-link" href="/docs" aria-label="查看 API 文档"><Braces size={17} /></Link>
        </div>
      </header>

      <main>
        <section className="hero-grid">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14} /> THREE.JS SPATIAL ENGINE</div>
            <h1>把地理空间<br /><em>带入浏览器。</em></h1>
            <p className="hero-lede">一套仿 Cesium 设计的 Three.js 引擎，面向三维 GIS、CAD 与城市级数字孪生应用。</p>
            <div className="hero-actions">
              <Link href="/examples" className="button button-primary"><Play size={16} fill="currentColor" /> 开始探索</Link>
              <Link href="/sceneengine" className="button button-quiet">打开场景编辑器 <ArrowUpRight size={16} /></Link>
            </div>
            <div className="hero-meta"><span>v0.1.0 / ALPHA</span><span>•</span><span>WEBGL 2.0</span><span>•</span><span>MIT LICENSE</span></div>
          </div>

          <div className="viewport-card" aria-label="三维场景预览">
            <div className="viewport-toolbar"><span><i className="live-dot" /> LIVE VIEWPORT</span><span>EPSG:3857 <ChevronRight size={13} /></span></div>
            <div className="scene-preview">
              <div className="scene-grid" />
              <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" />
              <div className="terrain terrain-back" /><div className="terrain terrain-front" />
              <div className="city-block block-a" /><div className="city-block block-b" /><div className="city-block block-c" />
              <div className="scene-pin"><span>厦门城市模型</span><b /></div>
              <div className="axis"><span>X</span><span>Y</span><span>Z</span></div>
              <div className="coordinates">118.0894° E<br />24.4798° N</div>
            </div>
            <div className="viewport-footer"><span><i className="green-dot" /> 12,428 objects</span><span>60 FPS</span><span>OrbitControls</span></div>
          </div>
        </section>

        <section className="capability-section">
          <div className="section-heading"><span className="section-number">01</span><div><p className="section-kicker">ENGINE MODULES</p><h2>为真实场景而生</h2></div><p className="section-note">从地球表面到工程实体，保持 Three.js 的灵活，也拥有 Cesium 的空间感知。</p></div>
          <div className="capability-grid">{capabilities.map(({ icon: Icon, title, copy }) => <div className="capability" key={title}><Icon size={20} /><h3>{title}</h3><p>{copy}</p><span className="capability-arrow"><ArrowUpRight size={15} /></span></div>)}</div>
        </section>

        <section className="demos-section">
          <div className="section-heading"><span className="section-number">02</span><div><p className="section-kicker">SELECTED EXAMPLES</p><h2>从一个场景开始</h2></div><Link className="text-link" href="/examples">查看全部示例 <ArrowUpRight size={15} /></Link></div>
          <div className="demo-list">{demos.map((demo, index) => <Link href={`/examples/${demo.key}`} className="demo-row" key={demo.key}><span className="demo-index">0{index + 1}</span><span className="demo-type">{demo.type}</span><strong>{demo.label}</strong><span className="demo-open"><Code2 size={15} /> RUN DEMO <ArrowUpRight size={15} /></span></Link>)}</div>
        </section>
      </main>
      <footer className="footer"><span>© 2026 next-three</span><span>BUILT WITH THREE.JS · DESIGNED FOR OPEN WORLDS</span><Link href="/docs">阅读文档 <ArrowUpRight size={13} /></Link></footer>
    </div>
  );
}
