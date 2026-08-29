import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { resolveExistingWorkspacePath } from "./workspace-paths.js";
import { RunnerRegistry } from "./runner-registry.js";
import {
  type InspectorResult,
  MAX_BLEND_INSPECT_BYTES,
  MAX_GLB_INSPECT_BYTES,
  assertInspectorFileSize,
  boundedResult,
  previewDimension,
  runFixed,
  sha256,
  sha256File,
  unavailable,
} from "./inspectors-common.js";

export class ExternalInspectorManager {
  private readonly evidenceDir: string;
  private readonly scriptDir: string;

  constructor(
    private readonly stateDir: string,
    private readonly runners = new RunnerRegistry(),
  ) {
    this.evidenceDir = join(stateDir, "inspector-evidence");
    this.scriptDir = join(stateDir, "inspectors");
  }

  async inspectBlend(
    workspaceRoot: string,
    path: string,
  ): Promise<InspectorResult> {
    const source = resolveExistingWorkspacePath(workspaceRoot, path, "file");
    if (extname(source.relativePath).toLowerCase() !== ".blend") {
      throw new Error("INSPECTOR_FORMAT_REJECTED: Expected a BLEND file.");
    }
    const size = assertInspectorFileSize(
      source.absolutePath,
      MAX_BLEND_INSPECT_BYTES,
      "BLEND",
    );
    const originalSha256 = await sha256File(source.absolutePath);
    const output = this.privateOutput("blend-inspection", ".json");
    const script = this.writeScript("inspect_blend.py", BLEND_INSPECTOR);
    const runner = await this.runners
      .resolve("blender")
      .catch(() => unavailable("Blender"));
    await runFixed(
      runner.executable,
      [
        "--background",
        "--disable-autoexec",
        "--offline-mode",
        source.absolutePath,
        "--python-exit-code",
        "23",
        "--python",
        script,
        "--",
        output,
      ],
      this.stateDir,
      runner.environment,
    );
    if (!existsSync(output)) {
      throw new Error("INSPECTOR_FAILED: Blender returned no inspection.");
    }
    const data = JSON.parse(readFileSync(output, "utf8")) as Record<
      string,
      unknown
    >;
    if ((await sha256File(source.absolutePath)) !== originalSha256) {
      throw new Error("INSPECTOR_SOURCE_MUTATED");
    }
    return boundedResult({
      path: source.relativePath,
      sha256: originalSha256,
      size,
      ...data,
    });
  }

  async renderModelPreview(input: {
    workspaceRoot: string;
    path: string;
    view?: "perspective" | "front" | "right" | "top";
    width?: number;
    height?: number;
  }): Promise<{
    path: string;
    view: string;
    width: number;
    height: number;
    sha256: string;
    bytes: number;
    data: string;
  }> {
    const source = resolveExistingWorkspacePath(
      input.workspaceRoot,
      input.path,
      "file",
    );
    const extension = extname(source.relativePath).toLowerCase();
    if (![".blend", ".glb"].includes(extension)) {
      throw new Error("INSPECTOR_FORMAT_REJECTED: Expected BLEND or GLB.");
    }
    const width = previewDimension(input.width ?? 512);
    const height = previewDimension(input.height ?? 512);
    const view = input.view ?? "perspective";
    const output = this.privateOutput("model-preview", ".png");
    assertInspectorFileSize(
      source.absolutePath,
      extension === ".glb" ? MAX_GLB_INSPECT_BYTES : MAX_BLEND_INSPECT_BYTES,
      extension === ".glb" ? "GLB" : "BLEND",
    );
    const sourceBefore = await sha256File(source.absolutePath);
    if (extension === ".glb") {
      await this.renderGlbWithGodot(
        source.absolutePath,
        output,
        view,
        width,
        height,
      );
    } else {
      const script = this.writeScript("render_model.py", MODEL_RENDERER);
      const runner = await this.runners
        .resolve("blender")
        .catch(() => unavailable("Blender"));
      await runFixed(
        runner.executable,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "23",
          "--python",
          script,
          "--",
          source.absolutePath,
          output,
          view,
          String(width),
          String(height),
        ],
        this.stateDir,
        runner.environment,
      );
    }
    if ((await sha256File(source.absolutePath)) !== sourceBefore) {
      throw new Error("INSPECTOR_SOURCE_MUTATED");
    }
    const bytes = readFileSync(output);
    if (
      bytes.length < 8 ||
      bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a"
    ) {
      throw new Error("INSPECTOR_PREVIEW_FAILED");
    }
    return {
      path: source.relativePath,
      view,
      width,
      height,
      sha256: sha256(bytes),
      bytes: bytes.length,
      data: bytes.toString("base64"),
    };
  }

  private writeScript(name: string, content: string): string {
    mkdirSync(this.scriptDir, { recursive: true, mode: 0o700 });
    const path = join(this.scriptDir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  private async renderGlbWithGodot(
    source: string,
    output: string,
    view: string,
    width: number,
    height: number,
  ): Promise<void> {
    const project = join(this.evidenceDir, `godot-preview-${randomUUID()}`);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    copyFileSync(source, join(project, "model.glb"));
    writeFileSync(
      join(project, "project.godot"),
      `[application]\nconfig/name="DevSpace Model Preview"\n[display]\nwindow/size/viewport_width=${width}\nwindow/size/viewport_height=${height}\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`,
      { mode: 0o600 },
    );
    const script = join(project, "preview.gd");
    writeFileSync(script, GODOT_MODEL_PREVIEW, { mode: 0o600 });
    const runner = await this.runners
      .resolve("godot")
      .catch(async () =>
        this.runners.resolve("godot-mono").catch(() => unavailable("Godot")),
      );
    await runFixed(
      runner.executable,
      ["--headless", "--editor", "--path", project, "--quit-after", "3"],
      project,
      runner.environment,
    );
    await runFixed(
      runner.executable,
      [
        "--path",
        project,
        "--resolution",
        `${width}x${height}`,
        "--script",
        script,
      ],
      project,
      {
        ...runner.environment,
        DEVSPACE_PREVIEW_OUTPUT: output,
        DEVSPACE_PREVIEW_VIEW: view,
      },
    );
  }

  private privateOutput(prefix: string, extension: string): string {
    mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    chmodSync(this.evidenceDir, 0o700);
    return join(this.evidenceDir, `${prefix}_${randomUUID()}${extension}`);
  }
}

const BLEND_INSPECTOR = String.raw`import bpy, json, math, os, sys
from mathutils import Vector
output = sys.argv[sys.argv.index("--") + 1]
objects = []
absolute_paths = []
missing = []
for obj in bpy.data.objects:
    bound = [list(obj.matrix_world @ Vector(corner)) for corner in obj.bound_box] if obj.type == "MESH" else []
    scale = list(obj.scale)
    objects.append({"name": obj.name, "type": obj.type, "scale": scale, "bounds": bound[:8],
        "warning": "extreme_scale" if min(abs(v) for v in scale) < 0.0001 or max(abs(v) for v in scale) > 10000 else
        "non_uniform_scale" if min(abs(v) for v in scale) > 0 and max(abs(v) for v in scale) / min(abs(v) for v in scale) > 100 else None})
for image in bpy.data.images:
    path = bpy.path.abspath(image.filepath) if image.filepath else ""
    if path and os.path.isabs(image.filepath): absolute_paths.append(image.filepath)
    if path and not os.path.exists(path): missing.append(image.filepath)
dependencies = [lib.filepath for lib in bpy.data.libraries] + [image.filepath for image in bpy.data.images if image.filepath]
meshes = [{"name": m.name, "vertices": len(m.vertices), "polygons": len(m.polygons),
    "triangles": sum(max(0, len(p.vertices)-2) for p in m.polygons)} for m in bpy.data.meshes]
actions = [{"name": a.name, "durationFrames": a.frame_range[1]-a.frame_range[0],
    "durationSeconds": (a.frame_range[1]-a.frame_range[0]) / max(1, bpy.context.scene.render.fps)} for a in bpy.data.actions]
result = {"blenderVersion": bpy.app.version_string, "objectCount": len(bpy.data.objects),
 "collectionCount": len(bpy.data.collections), "meshCount": len(bpy.data.meshes),
 "materialCount": len(bpy.data.materials), "imageCount": len(bpy.data.images),
 "armatureCount": len(bpy.data.armatures), "boneCount": sum(len(a.bones) for a in bpy.data.armatures),
 "objects": objects[:500], "meshes": meshes[:500], "collections": [c.name for c in bpy.data.collections][:500],
 "materials": [m.name for m in bpy.data.materials][:500], "images": [i.filepath for i in bpy.data.images][:500],
 "dependencies": dependencies[:500],
 "absolutePaths": absolute_paths[:500], "missingTextures": missing[:500], "actions": actions[:500],
 "truncated": any(len(x)>500 for x in [bpy.data.objects,bpy.data.meshes,bpy.data.collections,bpy.data.materials,bpy.data.images,bpy.data.actions])}
with open(output, "w", encoding="utf8") as f: json.dump(result, f)
`;

const MODEL_RENDERER = String.raw`import bpy, math, os, sys
from mathutils import Vector
source, output, view, width, height = sys.argv[sys.argv.index("--")+1:sys.argv.index("--")+6]
if source.lower().endswith(".glb"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes: raise RuntimeError("No mesh objects")
points = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
minimum = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
maximum = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (minimum + maximum) / 2
radius = max((maximum-minimum).length / 2, 0.01)
bpy.ops.object.camera_add()
camera = bpy.context.object
directions = {"front": Vector((0,-1,0)), "right": Vector((1,0,0)), "top": Vector((0,0,1)), "perspective": Vector((1,-1,0.75)).normalized()}
camera.location = center + directions[view] * radius * 3
camera.rotation_euler = (center-camera.location).to_track_quat("-Z","Y").to_euler()
camera.data.type = "ORTHO" if view != "perspective" else "PERSP"
camera.data.ortho_scale = radius * 2.5
bpy.context.scene.camera = camera
for direction, energy in [((4,-4,6),1200),((-3,2,2),500)]:
    bpy.ops.object.light_add(type="AREA", location=center+Vector(direction)*radius)
    bpy.context.object.data.energy=energy; bpy.context.object.data.shape="DISK"; bpy.context.object.data.size=radius*2
bpy.context.scene.world = bpy.context.scene.world or bpy.data.worlds.new("DevSpaceWorld")
bpy.context.scene.world.color=(0.035,0.035,0.05)
scene=bpy.context.scene
scene.render.engine="BLENDER_EEVEE"
scene.render.resolution_x=int(width); scene.render.resolution_y=int(height); scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"; scene.render.filepath=output; scene.render.film_transparent=False
bpy.ops.render.render(write_still=True)
`;

const GODOT_MODEL_PREVIEW = String.raw`extends SceneTree

func _initialize() -> void:
	_render.call_deferred()

func _render() -> void:
	var packed = load("res://model.glb")
	if packed == null or not packed is PackedScene:
		push_error("INSPECTOR_PREVIEW_IMPORT_FAILED")
		quit(23)
		return
	var model = packed.instantiate()
	root.add_child(model)
	var bounds := AABB()
	var found := false
	for node in model.find_children("*", "MeshInstance3D", true, false):
		var local: AABB = node.get_aabb()
		var world: AABB = node.global_transform * local
		bounds = world if not found else bounds.merge(world)
		found = true
	if not found:
		push_error("INSPECTOR_PREVIEW_NO_MESH")
		quit(23)
		return
	var center = bounds.get_center()
	var radius = max(bounds.size.length() * 0.5, 0.01)
	var world_environment := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.035, 0.035, 0.05)
	world_environment.environment = environment
	root.add_child(world_environment)
	var camera := Camera3D.new()
	var directions = {
		"front": Vector3(0, 0, 1),
		"right": Vector3(1, 0, 0),
		"top": Vector3(0, 1, 0),
		"perspective": Vector3(1, 0.75, 1).normalized()
	}
	var view = OS.get_environment("DEVSPACE_PREVIEW_VIEW")
	camera.position = center + directions.get(view, directions.perspective) * radius * 3.0
	camera.look_at(center, Vector3.UP if view != "top" else Vector3.FORWARD)
	if view != "perspective":
		camera.projection = Camera3D.PROJECTION_ORTHOGONAL
		camera.size = radius * 2.5
	root.add_child(camera)
	for rotation in [Vector3(-0.7, -0.7, 0), Vector3(0.5, 2.4, 0)]:
		var light := DirectionalLight3D.new()
		light.rotation = rotation
		light.light_energy = 1.2 if rotation.x < 0 else 0.5
		root.add_child(light)
	await process_frame
	await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	var error = image.save_png(OS.get_environment("DEVSPACE_PREVIEW_OUTPUT"))
	quit(0 if error == OK else 23)
`;
