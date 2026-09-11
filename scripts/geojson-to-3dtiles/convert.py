#!/usr/bin/env python3
"""Convert extruded GeoJSON building footprints to GLB-based 3D Tiles 1.1."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import mapbox_earcut as earcut
import numpy as np
from pyproj import Transformer
from pygltflib import (
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    FLOAT,
    SCALAR,
    TRIANGLES,
    UNSIGNED_BYTE,
    UNSIGNED_INT,
    UNSIGNED_SHORT,
    VEC3,
    VEC4,
    Accessor,
    Asset,
    Attributes,
    Buffer,
    BufferView,
    GLTF2,
    Material,
    Mesh,
    Node,
    PbrMetallicRoughness,
    Primitive,
    Scene,
)
from shapely import affinity
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import transform as transform_geometry
from shapely.validation import make_valid


DEFAULT_INPUT = Path(r"E:\矢量数据\outxiamen\building.geojson")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = PROJECT_ROOT / "public" / "models" / "xiamen-buildings"
NUMBER_PATTERN = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)")


@dataclass(slots=True)
class BuildingPart:
    feature_index: int
    part_index: int
    source_id: str
    polygon: Polygon
    base_height: float
    height: float


@dataclass(slots=True)
class ConversionStats:
    input_features: int = 0
    building_parts: int = 0
    skipped_features: int = 0
    repaired_features: int = 0
    tile_count: int = 0
    vertex_count: int = 0
    triangle_count: int = 0
    output_bytes: int = 0
    min_height: float = math.inf
    max_height: float = -math.inf


@dataclass(slots=True)
class Bounds3D:
    min_x: float = math.inf
    min_y: float = math.inf
    min_z: float = math.inf
    max_x: float = -math.inf
    max_y: float = -math.inf
    max_z: float = -math.inf

    def include(self, x: float, y: float, z: float) -> None:
        self.min_x = min(self.min_x, x)
        self.min_y = min(self.min_y, y)
        self.min_z = min(self.min_z, z)
        self.max_x = max(self.max_x, x)
        self.max_y = max(self.max_y, y)
        self.max_z = max(self.max_z, z)

    def include_bounds(self, other: "Bounds3D") -> None:
        self.include(other.min_x, other.min_y, other.min_z)
        self.include(other.max_x, other.max_y, other.max_z)

    @property
    def valid(self) -> bool:
        return self.min_x <= self.max_x and self.min_y <= self.max_y and self.min_z <= self.max_z

    @property
    def horizontal_diagonal(self) -> float:
        return math.hypot(self.max_x - self.min_x, self.max_y - self.min_y)


@dataclass(slots=True)
class MeshBuilder:
    positions: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    colors: bytearray = field(default_factory=bytearray)
    indices: list[int] = field(default_factory=list)
    bounds: Bounds3D = field(default_factory=Bounds3D)

    def add_vertex(
        self,
        east: float,
        north: float,
        up: float,
        normal: tuple[float, float, float],
        color: tuple[int, int, int, int],
    ) -> int:
        index = len(self.positions) // 3
        # glTF is Y-up. The loader rotates (east, up, -north) to Z-up ENU.
        self.positions.extend((east, up, -north))
        self.normals.extend(normal)
        self.colors.extend(color)
        self.bounds.include(east, north, up)
        return index

    def add_triangle(self, a: int, b: int, c: int) -> None:
        self.indices.extend((a, b, c))

    @property
    def vertex_count(self) -> int:
        return len(self.positions) // 3

    @property
    def triangle_count(self) -> int:
        return len(self.indices) // 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extrude GeoJSON building footprints into a tiled GLB dataset.",
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Input GeoJSON path.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output tileset directory.")
    parser.add_argument("--input-crs", default="EPSG:4326", help="Input CRS understood by pyproj.")
    parser.add_argument("--height-property", default="height", help="Building height property.")
    parser.add_argument("--base-height-property", default=None, help="Optional per-feature base height property.")
    parser.add_argument("--default-height", type=float, default=12.0, help="Fallback building height in meters.")
    parser.add_argument("--base-height", type=float, default=0.2, help="Default base altitude in meters.")
    parser.add_argument("--height-scale", type=float, default=1.0, help="Scale applied to building heights.")
    parser.add_argument("--min-height", type=float, default=1.0, help="Minimum accepted building height.")
    parser.add_argument("--max-height", type=float, default=1000.0, help="Maximum accepted building height.")
    parser.add_argument("--grid-size", type=int, default=8, help="Grid columns and rows.")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output directory.")
    return parser


def parse_number(value: Any, fallback: float) -> float:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        match = NUMBER_PATTERN.search(value)
        if match:
            parsed = float(match.group(0))
            if math.isfinite(parsed):
                return parsed
    return fallback


def iter_polygons(geometry: BaseGeometry) -> Iterator[Polygon]:
    if isinstance(geometry, Polygon):
        if not geometry.is_empty and geometry.area > 0:
            yield geometry
        return
    if isinstance(geometry, MultiPolygon):
        for polygon in geometry.geoms:
            yield from iter_polygons(polygon)
        return
    if isinstance(geometry, GeometryCollection):
        for child in geometry.geoms:
            yield from iter_polygons(child)


def load_building_parts(args: argparse.Namespace, stats: ConversionStats) -> list[BuildingPart]:
    with args.input.open("r", encoding="utf-8") as source:
        document = json.load(source)
    features = document.get("features")
    if document.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise ValueError("Input must be a GeoJSON FeatureCollection.")

    stats.input_features = len(features)
    to_wgs84 = Transformer.from_crs(args.input_crs, "EPSG:4326", always_xy=True)
    to_mercator = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    parts: list[BuildingPart] = []
    for feature_index, feature in enumerate(features):
        geometry_json = feature.get("geometry")
        if not geometry_json:
            stats.skipped_features += 1
            continue
        try:
            geometry = shape(geometry_json)
        except (TypeError, ValueError):
            stats.skipped_features += 1
            continue
        if geometry.is_empty:
            stats.skipped_features += 1
            continue
        if not geometry.is_valid:
            geometry = make_valid(geometry)
            stats.repaired_features += 1

        if args.input_crs.upper() not in {"EPSG:4326", "OGC:CRS84", "CRS84"}:
            geometry = transform_geometry(to_wgs84.transform, geometry)
        geometry = transform_geometry(to_mercator.transform, geometry)
        properties = feature.get("properties") or {}
        height = parse_number(properties.get(args.height_property), args.default_height)
        height = min(args.max_height, max(args.min_height, height * args.height_scale))
        base_height = args.base_height
        if args.base_height_property:
            base_height = parse_number(properties.get(args.base_height_property), base_height)

        source_id = str(properties.get("osm_id") or feature.get("id") or feature_index)
        feature_parts = list(iter_polygons(geometry))
        if not feature_parts:
            stats.skipped_features += 1
            continue
        for part_index, polygon in enumerate(feature_parts):
            parts.append(BuildingPart(feature_index, part_index, source_id, polygon, base_height, height))
        stats.min_height = min(stats.min_height, height)
        stats.max_height = max(stats.max_height, height)

    if not parts:
        raise ValueError("No polygonal building features were found.")
    stats.building_parts = len(parts)
    return parts


def center_parts(parts: Sequence[BuildingPart]) -> tuple[float, float, tuple[float, float, float, float]]:
    min_x = min(part.polygon.bounds[0] for part in parts)
    min_y = min(part.polygon.bounds[1] for part in parts)
    max_x = max(part.polygon.bounds[2] for part in parts)
    max_y = max(part.polygon.bounds[3] for part in parts)
    origin_x = (min_x + max_x) * 0.5
    origin_y = (min_y + max_y) * 0.5
    for part in parts:
        part.polygon = affinity.translate(part.polygon, xoff=-origin_x, yoff=-origin_y)
    return origin_x, origin_y, (min_x, min_y, max_x, max_y)


def assign_tiles(parts: Sequence[BuildingPart], grid_size: int) -> dict[tuple[int, int], list[BuildingPart]]:
    if grid_size < 1:
        raise ValueError("--grid-size must be at least 1.")
    min_x = min(part.polygon.bounds[0] for part in parts)
    min_y = min(part.polygon.bounds[1] for part in parts)
    max_x = max(part.polygon.bounds[2] for part in parts)
    max_y = max(part.polygon.bounds[3] for part in parts)
    span_x = max(max_x - min_x, 1.0)
    span_y = max(max_y - min_y, 1.0)
    tiles: dict[tuple[int, int], list[BuildingPart]] = {}
    for part in parts:
        point = part.polygon.representative_point()
        column = min(grid_size - 1, max(0, int((point.x - min_x) / span_x * grid_size)))
        row = min(grid_size - 1, max(0, int((point.y - min_y) / span_y * grid_size)))
        tiles.setdefault((column, row), []).append(part)
    return tiles


def feature_colors(source_id: str, height: float, max_height: float) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    digest = hashlib.blake2b(source_id.encode("utf-8"), digest_size=2).digest()
    variation = digest[0] / 255.0
    height_ratio = min(1.0, height / max(max_height, 1.0))
    wall_base = np.array((174.0, 181.0, 186.0))
    wall_shift = np.array((18.0, 12.0, 4.0)) * (variation - 0.5)
    wall_height_shift = np.array((-12.0, -8.0, 8.0)) * height_ratio
    wall_rgb = np.clip(wall_base + wall_shift + wall_height_shift, 0, 255).astype(np.uint8)
    roof_rgb = np.clip(wall_rgb.astype(np.int16) + np.array((24, 23, 20)), 0, 255).astype(np.uint8)
    return (
        (int(wall_rgb[0]), int(wall_rgb[1]), int(wall_rgb[2]), 255),
        (int(roof_rgb[0]), int(roof_rgb[1]), int(roof_rgb[2]), 255),
    )


def add_roof(builder: MeshBuilder, polygon: Polygon, roof_height: float, color: tuple[int, int, int, int]) -> int:
    vertices: list[tuple[float, float]] = []
    ring_ends: list[int] = []
    for ring in (polygon.exterior, *polygon.interiors):
        ring_vertices = [(float(point[0]), float(point[1])) for point in list(ring.coords)[:-1]]
        if len(ring_vertices) < 3:
            continue
        vertices.extend(ring_vertices)
        ring_ends.append(len(vertices))
    if not vertices or not ring_ends:
        return 0

    vertex_array = np.asarray(vertices, dtype=np.float64)
    triangle_indices = earcut.triangulate_float64(
        vertex_array,
        np.asarray(ring_ends, dtype=np.uint32),
    )
    quantized_vertices = vertex_array.astype(np.float32)
    roof_vertices = [
        builder.add_vertex(east, north, roof_height, (0.0, 1.0, 0.0), color)
        for east, north in vertices
    ]
    accepted = 0
    for offset in range(0, len(triangle_indices), 3):
        a, b, c = (int(value) for value in triangle_indices[offset:offset + 3])
        pa, pb, pc = quantized_vertices[a], quantized_vertices[b], quantized_vertices[c]
        edge_ab = pb - pa
        edge_ac = pc - pa
        signed_area = float(edge_ab[0] * edge_ac[1] - edge_ab[1] * edge_ac[0])
        if abs(signed_area) <= 1e-10:
            continue
        if signed_area < 0:
            b, c = c, b
        builder.add_triangle(roof_vertices[a], roof_vertices[b], roof_vertices[c])
        accepted += 1
    return accepted


def add_wall_ring(
    builder: MeshBuilder,
    coordinates: Iterable[Sequence[float]],
    base_height: float,
    roof_height: float,
    color: tuple[int, int, int, int],
) -> None:
    points = [(float(point[0]), float(point[1])) for point in coordinates]
    for (east0, north0), (east1, north1) in zip(points, points[1:]):
        delta_east = east1 - east0
        delta_north = north1 - north0
        length = math.hypot(delta_east, delta_north)
        if length <= 1e-7:
            continue
        # Oriented rings keep polygon material on the left; outward is right.
        outward_east = delta_north / length
        outward_north = -delta_east / length
        normal = (outward_east, 0.0, -outward_north)
        bottom0 = builder.add_vertex(east0, north0, base_height, normal, color)
        bottom1 = builder.add_vertex(east1, north1, base_height, normal, color)
        top1 = builder.add_vertex(east1, north1, roof_height, normal, color)
        top0 = builder.add_vertex(east0, north0, roof_height, normal, color)
        builder.add_triangle(bottom0, bottom1, top1)
        builder.add_triangle(bottom0, top1, top0)


def build_tile_mesh(parts: Sequence[BuildingPart], max_height: float) -> tuple[MeshBuilder, int]:
    builder = MeshBuilder()
    rendered_parts = 0
    for part in parts:
        polygon = orient(part.polygon, sign=1.0)
        roof_height = part.base_height + part.height
        wall_color, roof_color = feature_colors(part.source_id, part.height, max_height)
        if add_roof(builder, polygon, roof_height, roof_color) == 0:
            continue
        add_wall_ring(builder, polygon.exterior.coords, part.base_height, roof_height, wall_color)
        for interior in polygon.interiors:
            add_wall_ring(builder, interior.coords, part.base_height, roof_height, wall_color)
        rendered_parts += 1
    return builder, rendered_parts


def append_aligned(blob: bytearray, data: bytes, alignment: int = 4) -> tuple[int, int]:
    padding = (-len(blob)) % alignment
    if padding:
        blob.extend(b"\x00" * padding)
    offset = len(blob)
    blob.extend(data)
    return offset, len(data)


def write_glb(path: Path, builder: MeshBuilder, building_parts: int) -> int:
    if builder.vertex_count == 0 or builder.triangle_count == 0:
        raise ValueError(f"Cannot write empty tile: {path}")
    positions = np.asarray(builder.positions, dtype="<f4").reshape((-1, 3))
    normals = np.asarray(builder.normals, dtype="<f4").reshape((-1, 3))
    colors = np.frombuffer(builder.colors, dtype=np.uint8).reshape((-1, 4))
    if builder.vertex_count <= np.iinfo(np.uint16).max:
        indices = np.asarray(builder.indices, dtype="<u2")
        index_component_type = UNSIGNED_SHORT
    else:
        indices = np.asarray(builder.indices, dtype="<u4")
        index_component_type = UNSIGNED_INT

    blob = bytearray()
    position_offset, position_length = append_aligned(blob, positions.tobytes())
    normal_offset, normal_length = append_aligned(blob, normals.tobytes())
    color_offset, color_length = append_aligned(blob, colors.tobytes())
    index_offset, index_length = append_aligned(blob, indices.tobytes())
    buffer_views = [
        BufferView(buffer=0, byteOffset=position_offset, byteLength=position_length, target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=normal_offset, byteLength=normal_length, target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=color_offset, byteLength=color_length, target=ARRAY_BUFFER),
        BufferView(buffer=0, byteOffset=index_offset, byteLength=index_length, target=ELEMENT_ARRAY_BUFFER),
    ]
    accessors = [
        Accessor(
            bufferView=0,
            componentType=FLOAT,
            count=builder.vertex_count,
            type=VEC3,
            min=positions.min(axis=0).astype(float).tolist(),
            max=positions.max(axis=0).astype(float).tolist(),
        ),
        Accessor(bufferView=1, componentType=FLOAT, count=builder.vertex_count, type=VEC3),
        Accessor(bufferView=2, componentType=UNSIGNED_BYTE, normalized=True, count=builder.vertex_count, type=VEC4),
        Accessor(bufferView=3, componentType=index_component_type, count=len(indices), type=SCALAR),
    ]
    material = Material(
        name="Xiamen buildings",
        doubleSided=False,
        pbrMetallicRoughness=PbrMetallicRoughness(
            baseColorFactor=[1.0, 1.0, 1.0, 1.0],
            metallicFactor=0.0,
            roughnessFactor=0.88,
        ),
    )
    primitive = Primitive(
        attributes=Attributes(POSITION=0, NORMAL=1, COLOR_0=2),
        indices=3,
        material=0,
        mode=TRIANGLES,
    )
    gltf = GLTF2(
        asset=Asset(version="2.0", generator="next-cad geojson-to-3dtiles"),
        buffers=[Buffer(byteLength=len(blob))],
        bufferViews=buffer_views,
        accessors=accessors,
        materials=[material],
        meshes=[Mesh(
            name=path.stem,
            primitives=[primitive],
            extras={"buildingParts": building_parts, "triangles": builder.triangle_count},
        )],
        nodes=[Node(mesh=0, name=path.stem)],
        scenes=[Scene(nodes=[0], name="Buildings")],
        scene=0,
    )
    gltf.set_binary_blob(bytes(blob))
    path.parent.mkdir(parents=True, exist_ok=True)
    gltf.save_binary(path)
    return path.stat().st_size


def bounding_box(bounds: Bounds3D, force_horizontal_center: bool = False) -> list[float]:
    if not bounds.valid:
        raise ValueError("Cannot create a bounding volume from empty bounds.")
    if force_horizontal_center:
        center_x = 0.0
        center_y = 0.0
        half_x = max(abs(bounds.min_x), abs(bounds.max_x))
        half_y = max(abs(bounds.min_y), abs(bounds.max_y))
    else:
        center_x = (bounds.min_x + bounds.max_x) * 0.5
        center_y = (bounds.min_y + bounds.max_y) * 0.5
        half_x = (bounds.max_x - bounds.min_x) * 0.5
        half_y = (bounds.max_y - bounds.min_y) * 0.5
    center_z = (bounds.min_z + bounds.max_z) * 0.5
    half_z = max((bounds.max_z - bounds.min_z) * 0.5, 0.01)
    return [
        center_x, center_y, center_z,
        max(half_x, 0.01), 0.0, 0.0,
        0.0, max(half_y, 0.01), 0.0,
        0.0, 0.0, half_z,
    ]


def enu_to_ecef_transform(longitude: float, latitude: float) -> list[float]:
    longitude_rad = math.radians(longitude)
    latitude_rad = math.radians(latitude)
    sin_lon = math.sin(longitude_rad)
    cos_lon = math.cos(longitude_rad)
    sin_lat = math.sin(latitude_rad)
    cos_lat = math.cos(latitude_rad)
    to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
    origin_x, origin_y, origin_z = to_ecef.transform(longitude, latitude, 0.0)
    east = (-sin_lon, cos_lon, 0.0)
    north = (-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat)
    up = (cos_lat * cos_lon, cos_lat * sin_lon, sin_lat)
    return [
        east[0], east[1], east[2], 0.0,
        north[0], north[1], north[2], 0.0,
        up[0], up[1], up[2], 0.0,
        origin_x, origin_y, origin_z, 1.0,
    ]


def create_tileset(
    output: Path,
    tiles: dict[tuple[int, int], list[BuildingPart]],
    center_wgs84: tuple[float, float],
    stats: ConversionStats,
) -> None:
    tile_directory = output / "tiles"
    root_bounds = Bounds3D()
    children: list[dict[str, Any]] = []
    for tile_number, ((column, row), tile_parts) in enumerate(sorted(tiles.items())):
        builder, rendered_parts = build_tile_mesh(tile_parts, stats.max_height)
        if rendered_parts == 0:
            continue
        filename = f"tile_{column:02d}_{row:02d}.glb"
        file_size = write_glb(tile_directory / filename, builder, rendered_parts)
        root_bounds.include_bounds(builder.bounds)
        stats.tile_count += 1
        stats.vertex_count += builder.vertex_count
        stats.triangle_count += builder.triangle_count
        stats.output_bytes += file_size
        children.append({
            "boundingVolume": {"box": bounding_box(builder.bounds)},
            "geometricError": 0,
            "content": {"uri": f"tiles/{filename}"},
            "extras": {
                "grid": [column, row],
                "buildingParts": rendered_parts,
                "vertices": builder.vertex_count,
                "triangles": builder.triangle_count,
            },
        })
        print(
            f"[{tile_number + 1:02d}/{len(tiles):02d}] {filename}: "
            f"{rendered_parts} parts, {builder.triangle_count} triangles"
        )

    if not children:
        raise ValueError("All generated tiles were empty.")
    geometric_error = max(root_bounds.horizontal_diagonal, 1.0)
    tileset = {
        "asset": {"version": "1.1", "generator": "next-cad geojson-to-3dtiles"},
        "geometricError": geometric_error,
        "root": {
            "boundingVolume": {"box": bounding_box(root_bounds, force_horizontal_center=True)},
            "geometricError": geometric_error,
            "refine": "REPLACE",
            "transform": enu_to_ecef_transform(center_wgs84[0], center_wgs84[1]),
            "children": children,
        },
        "extras": {
            "centerWgs84": [center_wgs84[0], center_wgs84[1], 0.0],
            "buildingParts": stats.building_parts,
            "tileCount": stats.tile_count,
            "coordinateMode": "local Web Mercator offsets for next-cad flat map alignment",
        },
    }
    tileset_path = output / "tileset.json"
    tileset_path.write_text(json.dumps(tileset, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    stats.output_bytes += tileset_path.stat().st_size


def write_report(
    output: Path,
    args: argparse.Namespace,
    stats: ConversionStats,
    center_wgs84: tuple[float, float],
    mercator_bounds: tuple[float, float, float, float],
) -> None:
    report = {
        "source": args.input.name,
        "sourceCrs": args.input_crs,
        "centerWgs84": list(center_wgs84),
        "sourceMercatorBounds": list(mercator_bounds),
        "heightProperty": args.height_property,
        "baseHeightProperty": args.base_height_property,
        "defaultBaseHeight": args.base_height,
        "gridSize": args.grid_size,
        "statistics": {
            "inputFeatures": stats.input_features,
            "buildingParts": stats.building_parts,
            "skippedFeatures": stats.skipped_features,
            "repairedFeatures": stats.repaired_features,
            "tiles": stats.tile_count,
            "vertices": stats.vertex_count,
            "triangles": stats.triangle_count,
            "minHeight": stats.min_height,
            "maxHeight": stats.max_height,
            "outputBytes": stats.output_bytes,
        },
    }
    path = output / "conversion-report.json"
    path.write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def validate_arguments(args: argparse.Namespace) -> None:
    args.input = args.input.expanduser().resolve()
    args.output = args.output.expanduser().resolve()
    if not args.input.is_file():
        raise FileNotFoundError(f"Input GeoJSON does not exist: {args.input}")
    if args.grid_size < 1 or args.grid_size > 64:
        raise ValueError("--grid-size must be between 1 and 64.")
    if args.default_height <= 0 or args.min_height <= 0 or args.max_height < args.min_height:
        raise ValueError("Height limits must be positive and max-height must be >= min-height.")
    if args.height_scale <= 0:
        raise ValueError("--height-scale must be positive.")
    if args.output.exists() and not args.overwrite:
        raise FileExistsError(f"Output already exists; pass --overwrite to replace it: {args.output}")
    if args.output.parent == args.output:
        raise ValueError("Refusing to use a filesystem root as output.")


def publish_output(temporary_output: Path, output: Path) -> None:
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(temporary_output, output)
    shutil.rmtree(temporary_output)


def convert(args: argparse.Namespace) -> ConversionStats:
    validate_arguments(args)
    stats = ConversionStats()
    parts = load_building_parts(args, stats)
    origin_x, origin_y, mercator_bounds = center_parts(parts)
    from_mercator = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    center_wgs84 = from_mercator.transform(origin_x, origin_y)
    tiles = assign_tiles(parts, args.grid_size)
    temporary_output = args.output.with_name(f"{args.output.name}.tmp")
    if temporary_output.exists():
        shutil.rmtree(temporary_output)
    temporary_output.mkdir(parents=True)
    try:
        create_tileset(temporary_output, tiles, center_wgs84, stats)
        write_report(temporary_output, args, stats, center_wgs84, mercator_bounds)
        publish_output(temporary_output, args.output)
    except Exception:
        # Keep a complete temporary dataset for diagnostics or manual recovery.
        raise
    return stats


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        stats = convert(args)
    except Exception as error:
        print(f"Conversion failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Created {stats.tile_count} tiles with {stats.building_parts} building parts, "
        f"{stats.vertex_count} vertices and {stats.triangle_count} triangles."
    )
    print(f"Output: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
