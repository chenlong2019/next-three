# GeoJSON to 3D Tiles

This offline converter extrudes GeoJSON building footprints and writes a
GLB-based 3D Tiles 1.1 tileset for the flat Web Mercator scene used by this
project.

## Install

```powershell
python -m pip install -r scripts/geojson-to-3dtiles/requirements.txt
```

## Convert the Xiamen buildings

The input and output paths below are the script defaults:

```powershell
python scripts/geojson-to-3dtiles/convert.py
```

To replace an existing generated dataset:

```powershell
python scripts/geojson-to-3dtiles/convert.py --overwrite
```

Equivalent explicit command:

```powershell
python scripts/geojson-to-3dtiles/convert.py `
  --input "E:\矢量数据\outxiamen\building.geojson" `
  --output "public/models/xiamen-buildings" `
  --height-property height `
  --base-height 0.2 `
  --grid-size 8 `
  --overwrite
```

The generated entry point is:

```text
/models/xiamen-buildings/tileset.json
```

Each non-empty grid cell is merged into one GLB mesh. Earcut preserves polygon
holes and concave roofs, invalid polygonal geometry is repaired, and vertex
colors are stored directly in the GLB without Draco or Meshopt compression.
