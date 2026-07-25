"""Create a deterministic low-detail tower ship for DevSpace integration tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path.cwd()
OUTPUT = ROOT / "artifacts" / "blender_fixture"
BLEND_PATH = OUTPUT / "source.blend"
GLB_PATH = OUTPUT / "ship.glb"
PREVIEW_PATH = OUTPUT / "preview_perspective.png"
MANIFEST_PATH = OUTPUT / "asset_manifest.json"


def material(name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
    value = bpy.data.materials.new(name)
    value.diffuse_color = color
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    if shader is not None:
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Roughness"].default_value = 0.72
    return value


def cube(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    assigned_material: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location)
    value = bpy.context.object
    value.name = name
    value.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    value.data.materials.append(assigned_material)
    return value


def aim_at(value: bpy.types.Object, point: tuple[float, float, float]) -> None:
    direction = Vector(point) - value.location
    value.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


OUTPUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

wood = material("Wood", (0.22, 0.07, 0.025, 1.0))
deck = material("Deck", (0.48, 0.22, 0.07, 1.0))
cloth = material("Sail", (0.72, 0.12, 0.055, 1.0))
metal = material("Metal", (0.12, 0.14, 0.16, 1.0))

parts: list[bpy.types.Object] = []
parts.append(cube("LowerHull", (0.0, 0.0, 0.65), (3.8, 1.25, 0.55), wood))
parts.append(cube("UpperHull", (0.0, 0.0, 1.35), (3.2, 1.05, 0.28), deck))
parts.append(cube("ForeDeck", (-2.65, 0.0, 1.75), (0.75, 0.85, 0.18), deck))
parts.append(cube("AftDeck", (2.55, 0.0, 1.75), (0.75, 0.85, 0.18), deck))
parts.append(cube("TowerLower", (0.75, 0.0, 2.05), (0.82, 0.72, 0.55), wood))
parts.append(cube("TowerUpper", (0.75, 0.0, 2.88), (0.62, 0.58, 0.30), deck))
parts.append(cube("TowerRoof", (0.75, 0.0, 3.28), (0.82, 0.78, 0.12), cloth))
parts.append(cube("Mast", (-0.8, 0.0, 3.35), (0.10, 0.10, 2.15), metal))
parts.append(cube("Sail", (-0.8, 0.0, 3.65), (0.08, 1.15, 1.15), cloth))

for y in (-1.08, 1.08):
    for x in (-2.5, -1.25, 0.0, 1.25, 2.5):
        parts.append(cube(f"Rail_{x}_{y}", (x, y, 1.92), (0.08, 0.08, 0.42), metal))

bpy.ops.object.camera_add(location=(10.5, -11.5, 8.0))
camera = bpy.context.object
camera.name = "ReviewCamera"
aim_at(camera, (0.0, 0.0, 1.6))
bpy.context.scene.camera = camera

bpy.ops.object.light_add(type="AREA", location=(2.5, -4.0, 9.0))
key = bpy.context.object
key.data.energy = 1200.0
key.data.shape = "DISK"
key.data.size = 7.0
aim_at(key, (0.0, 0.0, 1.5))

bpy.ops.object.light_add(type="SUN", location=(-4.0, 2.0, 7.0))
sun = bpy.context.object
sun.rotation_euler = (0.45, -0.35, -0.55)
sun.data.energy = 1.4

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 640
scene.render.resolution_y = 480
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(PREVIEW_PATH)
scene.render.film_transparent = False
scene.world.color = (0.055, 0.065, 0.085)
scene.view_settings.look = "AgX - Medium High Contrast"

bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=False)
bpy.ops.export_scene.gltf(
    filepath=str(GLB_PATH),
    export_format="GLB",
    use_selection=False,
    export_apply=True,
)
bpy.ops.render.render(write_still=True)

mesh_objects = [value for value in parts if value.type == "MESH"]
vertex_count = sum(len(value.data.vertices) for value in mesh_objects)
triangle_count = 0
for value in mesh_objects:
    value.data.calc_loop_triangles()
    triangle_count += len(value.data.loop_triangles)

minimum = Vector((float("inf"), float("inf"), float("inf")))
maximum = Vector((float("-inf"), float("-inf"), float("-inf")))
for value in mesh_objects:
    for corner in value.bound_box:
        point = value.matrix_world @ Vector(corner)
        minimum.x = min(minimum.x, point.x)
        minimum.y = min(minimum.y, point.y)
        minimum.z = min(minimum.z, point.z)
        maximum.x = max(maximum.x, point.x)
        maximum.y = max(maximum.y, point.y)
        maximum.z = max(maximum.z, point.z)

manifest = {
    "schemaVersion": 1,
    "asset": "devspace_fixture_tower_ship",
    "format": "GLB",
    "dimensions": [round(value, 4) for value in (maximum - minimum)],
    "vertexCount": vertex_count,
    "triangleCount": triangle_count,
    "materialCount": len(bpy.data.materials),
    "textureReferences": [],
    "animationCount": len(bpy.data.actions),
    "armatureCount": len([value for value in bpy.data.objects if value.type == "ARMATURE"]),
    "files": {
        "source.blend": file_sha256(BLEND_PATH),
        "ship.glb": file_sha256(GLB_PATH),
        "preview_perspective.png": file_sha256(PREVIEW_PATH),
    },
}
MANIFEST_PATH.write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
print(json.dumps(manifest, sort_keys=True))
