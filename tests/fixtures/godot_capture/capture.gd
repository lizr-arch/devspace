extends Node3D

var _frame := 0
var _capturing := false
var _asset_loaded := false
var _asset_path := "res://artifacts/blender_fixture/ship.glb"


func _ready() -> void:
	_build_review_scene()
	print("DEVSPACE_CAPTURE_READY")


func _process(_delta: float) -> void:
	_frame += 1
	var warmup := int(_required_env("DEVSPACE_CAPTURE_WARMUP_FRAMES"))
	var capture_frame := int(_required_env("DEVSPACE_CAPTURE_FRAME"))
	if not _capturing and _frame >= max(warmup, capture_frame):
		_capturing = true
		_capture.call_deferred()


func _build_review_scene() -> void:
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#18263d")
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("#b7c8e8")
	environment.ambient_light_energy = 0.65
	var world := WorldEnvironment.new()
	world.environment = environment
	add_child(world)

	var camera := Camera3D.new()
	camera.position = Vector3(10.5, 7.0, 11.5)
	add_child(camera)
	camera.look_at(Vector3(0.0, 1.8, 0.0), Vector3.UP)
	camera.current = true

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-48.0, -35.0, 0.0)
	sun.light_energy = 1.3
	sun.shadow_enabled = true
	add_child(sun)

	var ground := MeshInstance3D.new()
	var ground_mesh := PlaneMesh.new()
	ground_mesh.size = Vector2(20.0, 20.0)
	ground.mesh = ground_mesh
	var ground_material := StandardMaterial3D.new()
	ground_material.albedo_color = Color("#30445c")
	ground_material.roughness = 0.92
	ground.material_override = ground_material
	add_child(ground)

	var asset_absolute := ProjectSettings.globalize_path(_asset_path)
	if FileAccess.file_exists(asset_absolute):
		var gltf_document := GLTFDocument.new()
		var gltf_state := GLTFState.new()
		var import_error := gltf_document.append_from_file(
			asset_absolute,
			gltf_state
		)
		if import_error == OK:
			var asset := gltf_document.generate_scene(gltf_state)
			if asset != null:
				asset.name = "ImportedBlenderAsset"
				add_child(asset)
				_asset_loaded = true
		else:
			push_warning("CAPTURE_FAILED: GLB import returned error %s" % import_error)

	if not _asset_loaded:
		var fallback := MeshInstance3D.new()
		var fallback_mesh := BoxMesh.new()
		fallback_mesh.size = Vector3(6.0, 2.0, 1.2)
		fallback.mesh = fallback_mesh
		fallback.position = Vector3(0.0, 0.7, 0.0)
		var fallback_material := StandardMaterial3D.new()
		fallback_material.albedo_color = Color("#a9472d")
		fallback_material.roughness = 0.75
		fallback.material_override = fallback_material
		add_child(fallback)


func _capture() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	print("DEVSPACE_CAPTURE_FRAME_READY")
	var output_relative := _required_env("DEVSPACE_CAPTURE_OUTPUT_PATH")
	var manifest_relative := _required_env("DEVSPACE_CAPTURE_MANIFEST_PATH")
	var output_absolute := ProjectSettings.globalize_path("res://" + output_relative)
	var manifest_absolute := ProjectSettings.globalize_path("res://" + manifest_relative)
	DirAccess.make_dir_recursive_absolute(output_absolute.get_base_dir())
	DirAccess.make_dir_recursive_absolute(manifest_absolute.get_base_dir())

	var image := get_viewport().get_texture().get_image()
	var save_error := image.save_png(output_absolute)
	if save_error != OK:
		push_error("CAPTURE_FAILED: PNG save returned error %s" % save_error)
		get_tree().quit(31)
		return

	var manifest := {
		"schemaVersion": 1,
		"engine": "Godot",
		"profile": _required_env("DEVSPACE_CAPTURE_PROFILE"),
		"project": _required_env("DEVSPACE_CAPTURE_PROJECT"),
		"scene": _required_env("DEVSPACE_CAPTURE_SCENE"),
		"viewport": [
			int(_required_env("DEVSPACE_CAPTURE_VIEWPORT_WIDTH")),
			int(_required_env("DEVSPACE_CAPTURE_VIEWPORT_HEIGHT"))
		],
		"randomSeed": int(_required_env("DEVSPACE_CAPTURE_RANDOM_SEED")),
		"warmupFrames": int(_required_env("DEVSPACE_CAPTURE_WARMUP_FRAMES")),
		"captureFrame": int(_required_env("DEVSPACE_CAPTURE_FRAME")),
		"capturedAt": Time.get_datetime_string_from_system(true),
		"sourceCommit": _required_env("DEVSPACE_CAPTURE_SOURCE_COMMIT"),
		"jobId": _required_env("DEVSPACE_JOB_ID"),
		"engineVersion": Engine.get_version_info(),
		"renderer": RenderingServer.get_current_rendering_driver_name(),
		"assetPath": _asset_path,
		"assetLoaded": _asset_loaded,
		"imagePath": output_relative,
		"imageSha256": FileAccess.get_sha256(output_absolute)
	}
	var file := FileAccess.open(manifest_absolute, FileAccess.WRITE)
	if file == null:
		push_error("CAPTURE_FAILED: Unable to open capture manifest.")
		get_tree().quit(32)
		return
	file.store_string(JSON.stringify(manifest, "\t") + "\n")
	file.close()
	print(JSON.stringify(manifest))
	get_tree().quit(0)


func _required_env(name: String) -> String:
	var value := OS.get_environment(name)
	if value.is_empty():
		push_error("CAPTURE_FAILED: Missing environment variable " + name)
		get_tree().quit(30)
	return value
