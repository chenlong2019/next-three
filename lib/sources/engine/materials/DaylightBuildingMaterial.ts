import * as THREE from "three";

/** Procedural facade styling for extruded, Y-up building meshes. */
export interface DaylightBuildingStyle {
  wallColor?: THREE.ColorRepresentation;
  roofColor?: THREE.ColorRepresentation;
  windowColor?: THREE.ColorRepresentation;
  glassColor?: THREE.ColorRepresentation;
  /** Window bay width and floor height in model meters. */
  windowSpacing?: number;
  floorHeight?: number;
  /** Roof elevation above which a facade uses the glass palette. */
  glassHeight?: number;
}

/** Each extruded wall triangle spans from the base to the roof. */
export function prepareDaylightGeometry(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  if (!position) return;
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const top = new Float32Array(position.count);
  const indices = geometry.getIndex();
  const count = indices?.count ?? position.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const a = indices ? indices.getX(i) : i;
    const b = indices ? indices.getX(i + 1) : i + 1;
    const c = indices ? indices.getX(i + 2) : i + 2;
    const height = Math.max(position.getY(a), position.getY(b), position.getY(c));
    top[a] = Math.max(top[a], height);
    top[b] = Math.max(top[b], height);
    top[c] = Math.max(top[c], height);
  }
  geometry.setAttribute("buildingTop", new THREE.BufferAttribute(top, 1));
}

export function createDaylightBuildingMaterial(
  style: DaylightBuildingStyle = {},
  opacity = 1,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: "Daylight building facade",
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0.08,
    side: THREE.DoubleSide,
    opacity,
    transparent: opacity < 1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uWallColor: { value: new THREE.Color(style.wallColor ?? 0xd4d6d3) },
      uRoofColor: { value: new THREE.Color(style.roofColor ?? 0xc1c5c1) },
      uWindowColor: { value: new THREE.Color(style.windowColor ?? 0x4b5b60) },
      uGlassColor: { value: new THREE.Color(style.glassColor ?? 0x647b87) },
      uWindowSpacing: { value: Math.max(style.windowSpacing ?? 3.2, 0.5) },
      uFloorHeight: { value: Math.max(style.floorHeight ?? 3.6, 0.5) },
      uGlassHeight: { value: Math.max(style.glassHeight ?? 55, 1) },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `
      #include <common>
      attribute float buildingTop;
      varying vec3 vFacadePosition;
      varying vec3 vFacadeNormal;
      varying float vBuildingTop;
    `,
      )
      .replace(
        "#include <begin_vertex>",
        `
      #include <begin_vertex>
      vFacadePosition = position;
      vFacadeNormal = normal;
      vBuildingTop = buildingTop;
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `
      #include <common>
      varying vec3 vFacadePosition;
      varying vec3 vFacadeNormal;
      varying float vBuildingTop;
      uniform vec3 uWallColor;
      uniform vec3 uRoofColor;
      uniform vec3 uWindowColor;
      uniform vec3 uGlassColor;
      uniform float uWindowSpacing;
      uniform float uFloorHeight;
      uniform float uGlassHeight;
    `,
      )
      .replace(
        "#include <color_fragment>",
        `
      #include <color_fragment>
      vec3 facadeNormal = normalize(vFacadeNormal);
      float roof = step(0.65, abs(facadeNormal.y));
      vec2 tangent = vec2(-facadeNormal.z, facadeNormal.x);
      tangent /= max(length(tangent), 0.0001);
      vec2 grid = vec2(
        dot(vFacadePosition.xz, tangent) / uWindowSpacing,
        vFacadePosition.y / uFloorHeight
      );
      vec2 footprint = fwidth(grid);
      vec2 cell = abs(fract(grid) - 0.5);
      vec2 window = 1.0 - smoothstep(vec2(0.27) - footprint, vec2(0.27) + footprint, cell);
      // Fade subpixel windows to their mean coverage instead of shimmering.
      float detail = 1.0 - smoothstep(0.18, 0.65, max(footprint.x, footprint.y));
      float windows = mix(0.29, window.x * window.y, detail);
      float glass = smoothstep(uGlassHeight - 5.0, uGlassHeight + 5.0, vBuildingTop);
      vec3 wall = mix(uWallColor, uGlassColor, glass);
      vec3 facade = mix(wall, uWindowColor, windows * mix(0.85, 0.32, glass));
      float baseShade = mix(0.74, 1.0, smoothstep(0.0, 10.0, vFacadePosition.y));
      diffuseColor.rgb *= mix(facade * baseShade, uRoofColor, roof);
    `,
      );
  };
  material.customProgramCacheKey = () => "daylight-building-v1";
  return material;
}
