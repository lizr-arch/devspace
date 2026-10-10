/**
 * DevSpace Godot Runtime Bridge (protocol v2).
 *
 * This GDScript is written into DevSpace private state at startup and executed
 * by a real, non-headless Godot process via `--script`. It owns one
 * authenticated loopback connection to the DevSpace host and provides:
 *
 *  - scene lifecycle that lets product code call `change_scene_to_file` /
 *    `reload_current_scene` without stacking the original scene underneath;
 *  - ordered input injection (pointer press/move/release/wheel/double-click,
 *    keyboard press/release with modifiers, InputMap actions, and multi-step
 *    sequences) with a mandatory release path;
 *  - GPU read-back frame capture plus renderer identity used for evidence.
 *
 * Protocol v1 commands (`inspect`, `action`, `click`, `capture`, `quit`) keep
 * their exact request and response shapes so existing clients are unaffected.
 */
export const GODOT_RUNTIME_BRIDGE_PROTOCOL_VERSION = 2;

export const GODOT_RUNTIME_BRIDGE = String.raw`extends SceneTree

# DevSpace Godot Runtime Bridge, protocol v2.
#
# Runs as the process main loop inside a real (non-headless) Godot engine so a
# remote agent can drive and photograph an actual GPU-rendered session.

const DEFAULT_CAPTURE_WAIT_FRAMES := 2
const MAX_CAPTURE_WAIT_FRAMES := 600
const DEFAULT_SEQUENCE_STEP_FRAMES := 1
const MAX_SEQUENCE_STEPS := 512

var socket := StreamPeerTCP.new()
var receive_buffer := ""
var authenticated := false

# SceneTree.current_scene is the authoritative root: the engine reassigns it
# whenever product code switches or reloads scenes, so we never hold a stale
# pointer and never render a replaced scene underneath a new one.
var launched_scene: Node = null
var observed_scene_path := ""
var scene_generation := 0

var tap_frames: Dictionary = {}
var pending_sequences: Array = []
var pending_captures: Array = []

# Latched input state. Everything recorded here is released on quit, on host
# disconnect, and on demand, so an interrupted session cannot strand a held
# key or mouse button inside the engine.
var pressed_mouse: Dictionary = {}
var pressed_keys: Dictionary = {}
var pressed_actions: Dictionary = {}
var last_pointer_position := Vector2.ZERO

var heartbeat_frames := 0
var frame_count := 0
var quitting := false
var stop_reason := ""
var render_info: Dictionary = {}


func _initialize() -> void:
	render_info = _collect_render_info()
	var requested := OS.get_environment("DEVSPACE_GAME_SCENE")
	var packed = load(requested)
	if packed == null or not packed is PackedScene:
		push_error("GAME_SESSION_SCENE_LOAD_FAILED")
		quit(91)
		return
	var instance = packed.instantiate()
	root.add_child(instance)
	# Registering the launched scene as the current scene is what makes a later
	# product change_scene_to_file() *replace* it. Without this the tree has no
	# current scene, the engine simply adds the new scene as another child of
	# root, and the original scene keeps rendering underneath it.
	current_scene = instance
	launched_scene = instance
	observed_scene_path = _scene_path_of(instance)
	scene_generation = 1
	var error = socket.connect_to_host("127.0.0.1", int(OS.get_environment("DEVSPACE_BRIDGE_PORT")))
	if error != OK:
		push_error("GAME_SESSION_BRIDGE_CONNECT_FAILED")
		quit(92)


func _process(_delta: float) -> bool:
	if quitting:
		return true
	frame_count += 1
	socket.poll()
	var status := socket.get_status()
	if authenticated and status != StreamPeerTCP.STATUS_CONNECTED:
		# DevSpace restarted, the socket was reset, or the tunnel dropped.
		# Release latched input before leaving so the engine is never stuck.
		stop_reason = "host_disconnected"
		_release_all()
		quitting = true
		return true
	if status == StreamPeerTCP.STATUS_CONNECTED and not authenticated:
		authenticated = true
		_send({
			"type": "hello",
			"token": OS.get_environment("DEVSPACE_BRIDGE_TOKEN"),
			"protocol": 2,
			"engineVersion": _safe_call(Engine, "get_version_info", {}).get("string", "unknown"),
			"engineVersionInfo": _safe_call(Engine, "get_version_info", {}),
			"scene": observed_scene_path,
			"projectPath": ProjectSettings.globalize_path("res://"),
			"resourcePath": ProjectSettings.globalize_path("res://"),
			"processId": OS.get_process_id(),
			"renderInfo": render_info,
		})
	if authenticated:
		_read_messages()
		_tick_taps()
		_tick_sequences()
		_tick_captures()
		_tick_scene()
		heartbeat_frames += 1
		if heartbeat_frames >= 60:
			heartbeat_frames = 0
			_send({
				"type": "heartbeat",
				"frame": frame_count,
				"scene": observed_scene_path,
				"sceneGeneration": scene_generation,
			})
	return false


func _read_messages() -> void:
	while socket.get_available_bytes() > 0:
		receive_buffer += socket.get_utf8_string(min(socket.get_available_bytes(), 65536))
		if receive_buffer.length() > 1048576:
			push_error("GAME_SESSION_PROTOCOL_TOO_LARGE")
			quit(93)
			return
		while receive_buffer.contains("\n"):
			var newline = receive_buffer.find("\n")
			var line = receive_buffer.substr(0, newline)
			receive_buffer = receive_buffer.substr(newline + 1)
			if not line.is_empty():
				_handle_message(line)


func _handle_message(line: String) -> void:
	var message = JSON.parse_string(line)
	if not message is Dictionary:
		return
	var request_id = str(message.get("id", ""))
	var command = str(message.get("command", ""))
	match command:
		"inspect":
			_reply(request_id, {
				"nodes": _limited_tree(),
				"scene": observed_scene_path,
				"sceneGeneration": scene_generation,
				"frame": frame_count,
				"renderInfo": render_info,
				"pressed": _pressed_state(),
			})
		"state":
			_reply(request_id, {
				"scene": observed_scene_path,
				"sceneGeneration": scene_generation,
				"frame": frame_count,
				"pressed": _pressed_state(),
				"pendingSequences": pending_sequences.size(),
				"pendingCaptures": pending_captures.size(),
			})
		"action":
			if not InputMap.has_action(str(message.get("action", ""))):
				_reply(request_id, {}, "GAME_SESSION_ACTION_UNKNOWN")
			else:
				_inject_action(message)
				_reply(request_id, {"accepted": true, "scene": observed_scene_path})
		"click":
			# Protocol v1 single click: press and release in one step.
			_inject_click(message)
			_reply(request_id, {"accepted": true, "scene": observed_scene_path})
		"pointer":
			var pointer_error := _inject_pointer(message)
			if pointer_error.is_empty():
				_reply(request_id, {
					"accepted": true,
					"scene": observed_scene_path,
					"pressed": _pressed_state(),
				})
			else:
				_reply(request_id, {}, pointer_error)
		"key":
			var key_error := _inject_key(message)
			if key_error.is_empty():
				_reply(request_id, {
					"accepted": true,
					"scene": observed_scene_path,
					"pressed": _pressed_state(),
				})
			else:
				_reply(request_id, {}, key_error)
		"sequence":
			_begin_sequence(request_id, message)
		"release_all":
			_release_all()
			_reply(request_id, {"accepted": true, "released": true})
		"capture":
			_request_capture(
				request_id,
				str(message.get("path", "")),
				int(message.get("waitFrames", DEFAULT_CAPTURE_WAIT_FRAMES))
			)
		"quit":
			# Always drop latched input before the process goes away.
			_release_all()
			stop_reason = "requested"
			_reply(request_id, {"stopping": true, "scene": observed_scene_path})
			quitting = true
		_:
			_reply(request_id, {}, "GAME_SESSION_COMMAND_REJECTED")


func _finalize() -> void:
	# MainLoop shutdown (including a forced window close / engine quit): never
	# strand input state inside the engine.
	_release_all()


# --- input -----------------------------------------------------------------

func _inject_action(message: Dictionary) -> void:
	var action := str(message.get("action", ""))
	var event := InputEventAction.new()
	event.action = action
	event.strength = float(message.get("strength", 1.0))
	var operation = str(message.get("operation", "tap"))
	event.pressed = operation != "release"
	Input.parse_input_event(event)
	if operation == "press":
		pressed_actions[action] = true
	elif operation == "release":
		pressed_actions.erase(action)
	if operation == "tap":
		tap_frames[action] = int(message.get("frames", 1))


func _tick_taps() -> void:
	for action in tap_frames.keys():
		tap_frames[action] = int(tap_frames[action]) - 1
		if int(tap_frames[action]) <= 0:
			var event := InputEventAction.new()
			event.action = str(action)
			event.pressed = false
			Input.parse_input_event(event)
			tap_frames.erase(action)


func _inject_click(message: Dictionary) -> void:
	var position := Vector2(float(message.get("x", 0)), float(message.get("y", 0)))
	var button := int(message.get("buttonIndex", MOUSE_BUTTON_LEFT))
	var modifiers = message.get("modifiers", {})
	Input.parse_input_event(_apply_modifiers(_make_mouse_button(position, button, true), modifiers))
	Input.parse_input_event(_apply_modifiers(_make_mouse_button(position, button, false), modifiers))


func _inject_pointer(message: Dictionary) -> String:
	var event_kind := str(message.get("event", ""))
	var position := Vector2(float(message.get("x", 0)), float(message.get("y", 0)))
	var modifiers = message.get("modifiers", {})
	match event_kind:
		"move":
			_send_mouse_motion(position, modifiers)
		"down":
			var button := int(message.get("buttonIndex", MOUSE_BUTTON_LEFT))
			Input.parse_input_event(_apply_modifiers(_make_mouse_button(position, button, true), modifiers))
			pressed_mouse[button] = true
		"up":
			var button := int(message.get("buttonIndex", MOUSE_BUTTON_LEFT))
			Input.parse_input_event(_apply_modifiers(_make_mouse_button(position, button, false), modifiers))
			pressed_mouse.erase(button)
		"wheel":
			var wheel_button := _wheel_button(message)
			if wheel_button == 0:
				return "GAME_SESSION_WHEEL_DIRECTION_UNKNOWN"
			# Godot delivers a wheel notch as a press immediately followed by a
			# release carrying the same factor.
			var wheel_event := _make_mouse_button(position, wheel_button, true)
			wheel_event.factor = float(message.get("factor", 1.0))
			Input.parse_input_event(_apply_modifiers(wheel_event, modifiers))
			var wheel_release := _make_mouse_button(position, wheel_button, false)
			wheel_release.factor = wheel_event.factor
			Input.parse_input_event(_apply_modifiers(wheel_release, modifiers))
		"double_click":
			var button := int(message.get("buttonIndex", MOUSE_BUTTON_LEFT))
			var press := _make_mouse_button(position, button, true)
			press.double_click = true
			Input.parse_input_event(_apply_modifiers(press, modifiers))
			var release := _make_mouse_button(position, button, false)
			release.double_click = true
			Input.parse_input_event(_apply_modifiers(release, modifiers))
		_:
			return "GAME_SESSION_POINTER_EVENT_UNKNOWN"
	return ""


func _send_mouse_motion(position: Vector2, modifiers) -> void:
	var motion := InputEventMouseMotion.new()
	motion.position = position
	motion.global_position = position
	motion.relative = position - last_pointer_position
	motion.velocity = Vector2.ZERO
	motion.button_mask = _button_mask()
	Input.parse_input_event(_apply_modifiers(motion, modifiers))
	last_pointer_position = position


func _inject_key(message: Dictionary) -> String:
	var event_kind := str(message.get("event", ""))
	var keycode := _resolve_keycode(message)
	if keycode == KEY_NONE:
		return "GAME_SESSION_KEY_UNKNOWN"
	var modifiers = message.get("modifiers", {})
	var typed := _text_for_key(message)
	match event_kind:
		"press", "tap":
			Input.parse_input_event(_apply_modifiers(_make_key(keycode, true, message, typed), modifiers))
			pressed_keys[keycode] = message.get("physical", false)
			if event_kind == "tap":
				Input.parse_input_event(_apply_modifiers(_make_key(keycode, false, message, typed), modifiers))
				pressed_keys.erase(keycode)
		"release":
			Input.parse_input_event(_apply_modifiers(_make_key(keycode, false, message, typed), modifiers))
			pressed_keys.erase(keycode)
		_:
			return "GAME_SESSION_KEY_EVENT_UNKNOWN"
	return ""


# Common spellings a caller may use for the same Godot key. Godot's own
# find_keycode_from_string only accepts its internal names ("Ctrl", not
# "Control"), so accept the obvious synonyms instead of failing opaquely.
const KEY_ALIASES := {
	"control": "Ctrl",
	"ctrl": "Ctrl",
	"command": "Meta",
	"cmd": "Meta",
	"super": "Meta",
	"win": "Meta",
	"meta": "Meta",
	"option": "Alt",
	"alt": "Alt",
	"shift": "Shift",
	"escape": "Escape",
	"esc": "Escape",
	"return": "Enter",
	"enter": "Enter",
	"spacebar": "Space",
	"space": "Space",
	"del": "Delete",
	"delete": "Delete",
	"backspace": "Backspace",
	"tab": "Tab",
	"capslock": "Capslock",
	"pageup": "Pageup",
	"pagedown": "Pagedown",
}

const NAMED_KEYS := {
	# Modifier keys must be mapped directly: OS.find_keycode_from_string does
	# not resolve "Alt" or "Meta" (it treats them as modifier prefixes), so a
	# caller asking for Command/Option would otherwise get KEY_UNKNOWN.
	"ctrl": KEY_CTRL,
	"control": KEY_CTRL,
	"shift": KEY_SHIFT,
	"alt": KEY_ALT,
	"option": KEY_ALT,
	"meta": KEY_META,
	"command": KEY_META,
	"cmd": KEY_META,
	"super": KEY_META,
	"up": KEY_UP,
	"down": KEY_DOWN,
	"left": KEY_LEFT,
	"right": KEY_RIGHT,
	"home": KEY_HOME,
	"end": KEY_END,
	"insert": KEY_INSERT,
	"f1": KEY_F1, "f2": KEY_F2, "f3": KEY_F3, "f4": KEY_F4,
	"f5": KEY_F5, "f6": KEY_F6, "f7": KEY_F7, "f8": KEY_F8,
	"f9": KEY_F9, "f10": KEY_F10, "f11": KEY_F11, "f12": KEY_F12,
}

func _resolve_keycode(message: Dictionary) -> int:
	var raw := str(message.get("key", "")).strip_edges()
	if raw.is_empty():
		return KEY_NONE
	# A single printable character is the character itself.
	if raw.length() == 1:
		var upper := raw.to_upper()
		var code := int(upper.unicode_at(0))
		if code > 0:
			return code
	var lowered := raw.to_lower()
	if NAMED_KEYS.has(lowered):
		return int(NAMED_KEYS[lowered])
	# Explicit Key-enum spelling, e.g. "KEY_ESCAPE".
	if lowered.begins_with("key_"):
		var stripped := lowered.substr(4)
		if NAMED_KEYS.has(stripped):
			return int(NAMED_KEYS[stripped])
		var by_enum := int(OS.find_keycode_from_string(stripped.capitalize()))
		if by_enum != 0:
			return by_enum
	var candidate := raw
	if KEY_ALIASES.has(lowered):
		candidate = str(KEY_ALIASES[lowered])
	var resolved := int(OS.find_keycode_from_string(candidate))
	if resolved != 0:
		return resolved
	# Accept the explicit Key-enum spelling too ("KEY_ESCAPE").
	if lowered.begins_with("key_"):
		resolved = int(OS.find_keycode_from_string(raw.substr(4).capitalize()))
		if resolved != 0:
			return resolved
	return KEY_NONE


# Text-entry controls (LineEdit, TextEdit) insert characters from
# InputEventKey.unicode, NOT from keycode. Without this, typing into a dialog
# field silently does nothing even though every key event is delivered.
func _text_for_key(message: Dictionary) -> String:
	var explicit := str(message.get("text", ""))
	if not explicit.is_empty():
		return explicit
	var raw := str(message.get("key", "")).strip_edges()
	if raw.length() == 1 and raw.unicode_at(0) >= 32:
		return raw
	return ""

func _make_key(keycode: int, pressed: bool, message: Dictionary, typed := "") -> InputEventKey:
	var event := InputEventKey.new()
	event.pressed = pressed
	event.echo = bool(message.get("echo", false))
	if bool(message.get("physical", false)):
		event.physical_keycode = keycode
	else:
		event.keycode = keycode
	event.key_label = keycode
	if not typed.is_empty():
		event.unicode = typed.unicode_at(0)
	return event


func _make_mouse_button(position: Vector2, button: int, pressed: bool) -> InputEventMouseButton:
	var event := InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button
	event.pressed = pressed
	event.button_mask = _button_mask() if pressed else 0
	return event


func _wheel_button(message: Dictionary) -> int:
	if message.has("wheelDirection"):
		match str(message.get("wheelDirection", "")):
			"up":
				return MOUSE_BUTTON_WHEEL_UP
			"down":
				return MOUSE_BUTTON_WHEEL_DOWN
			"left":
				return MOUSE_BUTTON_WHEEL_LEFT
			"right":
				return MOUSE_BUTTON_WHEEL_RIGHT
			_:
				return 0
	var raw := int(message.get("buttonIndex", 0))
	if raw == MOUSE_BUTTON_WHEEL_UP or raw == MOUSE_BUTTON_WHEEL_DOWN \
			or raw == MOUSE_BUTTON_WHEEL_LEFT or raw == MOUSE_BUTTON_WHEEL_RIGHT:
		return raw
	return 0


func _button_mask() -> int:
	var mask := 0
	for button in pressed_mouse.keys():
		match int(button):
			MOUSE_BUTTON_LEFT:
				mask |= MOUSE_BUTTON_MASK_LEFT
			MOUSE_BUTTON_RIGHT:
				mask |= MOUSE_BUTTON_MASK_RIGHT
			MOUSE_BUTTON_MIDDLE:
				mask |= MOUSE_BUTTON_MASK_MIDDLE
	return mask


func _apply_modifiers(event: InputEvent, modifiers) -> InputEvent:
	if not event is InputEventWithModifiers or not modifiers is Dictionary:
		return event
	var typed := event as InputEventWithModifiers
	typed.shift_pressed = bool(modifiers.get("shift", false))
	typed.ctrl_pressed = bool(modifiers.get("ctrl", false))
	typed.alt_pressed = bool(modifiers.get("alt", false))
	typed.meta_pressed = bool(modifiers.get("meta", false))
	return typed


# --- multi-step sequences --------------------------------------------------

func _begin_sequence(request_id: String, message: Dictionary) -> void:
	var raw = message.get("steps", [])
	if not raw is Array or raw.is_empty():
		_reply(request_id, {}, "GAME_SESSION_SEQUENCE_INVALID")
		return
	if raw.size() > MAX_SEQUENCE_STEPS:
		_reply(request_id, {}, "GAME_SESSION_SEQUENCE_TOO_LARGE")
		return
	var steps: Array = []
	for entry in raw:
		if not entry is Dictionary:
			_reply(request_id, {}, "GAME_SESSION_SEQUENCE_INVALID")
			return
		steps.append(entry)
	pending_sequences.append({
		"id": request_id,
		"steps": steps,
		"index": 0,
		"wait": 0,
		"dispatched": 0,
		"releaseAtEnd": bool(message.get("releaseAtEnd", true)),
	})


func _tick_sequences() -> void:
	if pending_sequences.is_empty():
		return
	var remaining: Array = []
	for sequence in pending_sequences:
		if int(sequence.wait) > 0:
			sequence.wait = int(sequence.wait) - 1
			remaining.append(sequence)
			continue
		var steps: Array = sequence.steps
		if int(sequence.index) >= steps.size():
			if bool(sequence.releaseAtEnd):
				_release_all()
			_reply(str(sequence.id), {
				"accepted": true,
				"steps": int(sequence.dispatched),
				"scene": observed_scene_path,
				"pressed": _pressed_state(),
			})
			continue
		var step: Dictionary = steps[int(sequence.index)]
		sequence.index = int(sequence.index) + 1
		var failure := _dispatch_step(step)
		if not failure.is_empty():
			_release_all()
			_reply(str(sequence.id), {"accepted": false, "failedStep": int(sequence.index)}, failure)
			continue
		sequence.dispatched = int(sequence.dispatched) + 1
		sequence.wait = max(0, int(step.get("frameDelay", DEFAULT_SEQUENCE_STEP_FRAMES)) - 1)
		remaining.append(sequence)
	pending_sequences = remaining


func _dispatch_step(step: Dictionary) -> String:
	match str(step.get("type", "")):
		"pointer":
			return _inject_pointer(step)
		"key":
			return _inject_key(step)
		"action":
			if not InputMap.has_action(str(step.get("action", ""))):
				return "GAME_SESSION_ACTION_UNKNOWN"
			_inject_action(step)
			return ""
		"wait":
			return ""
		_:
			return "GAME_SESSION_SEQUENCE_STEP_UNKNOWN"


func _release_all() -> void:
	var release_modifiers := {}
	for button in pressed_mouse.keys():
		var event := _make_mouse_button(last_pointer_position, int(button), false)
		Input.parse_input_event(event)
	pressed_mouse.clear()
	for keycode in pressed_keys.keys():
		var key_event := InputEventKey.new()
		key_event.pressed = false
		if bool(pressed_keys[keycode]):
			key_event.physical_keycode = int(keycode)
		else:
			key_event.keycode = int(keycode)
		key_event.key_label = int(keycode)
		Input.parse_input_event(_apply_modifiers(key_event, release_modifiers))
	pressed_keys.clear()
	for action in pressed_actions.keys():
		var action_event := InputEventAction.new()
		action_event.action = str(action)
		action_event.pressed = false
		Input.parse_input_event(action_event)
	pressed_actions.clear()
	tap_frames.clear()


func _pressed_state() -> Dictionary:
	return {
		"mouse": pressed_mouse.keys(),
		"keys": pressed_keys.keys(),
		"actions": pressed_actions.keys(),
	}


# --- scene lifecycle -------------------------------------------------------

func _tick_scene() -> void:
	var path := _current_scene_path()
	if path != observed_scene_path:
		observed_scene_path = path
		scene_generation += 1
		_send({
			"type": "event",
			"event": "scene_changed",
			"scene": path,
			"sceneGeneration": scene_generation,
			"frame": frame_count,
		})


func _current_scene_path() -> String:
	var scene := current_scene
	if scene == null or not is_instance_valid(scene):
		return ""
	return _scene_path_of(scene)


func _scene_path_of(node: Node) -> String:
	if node == null:
		return ""
	var path := str(node.scene_file_path)
	if path.is_empty():
		path = str(node.get("name"))
	return path


func _instantiated_scene_nodes() -> Array:
	# Every direct child of root that came from a PackedScene. A healthy
	# single-scene session has exactly one.
	var result: Array = []
	for child in root.get_children():
		var path := _scene_path_of(child)
		if not path.is_empty():
			result.append(path)
	return result


# --- capture ---------------------------------------------------------------

func _request_capture(request_id: String, output_path: String, wait_frames: int) -> void:
	if output_path.is_empty():
		_reply(request_id, {}, "GAME_SESSION_CAPTURE_FAILED")
		return
	pending_captures.append({
		"id": request_id,
		"path": output_path,
		"wait": clampi(wait_frames, 1, MAX_CAPTURE_WAIT_FRAMES),
		"requestedFrame": frame_count,
	})


func _tick_captures() -> void:
	if pending_captures.is_empty():
		return
	var remaining: Array = []
	for capture in pending_captures:
		capture.wait = int(capture.wait) - 1
		if int(capture.wait) > 0:
			remaining.append(capture)
			continue
		_perform_capture(str(capture.id), str(capture.path), int(capture.requestedFrame))
	pending_captures = remaining


func _perform_capture(request_id: String, output_path: String, requested_frame: int) -> void:
	var texture := root.get_texture()
	if texture == null:
		_reply(request_id, {}, "GAME_SESSION_CAPTURE_FAILED")
		return
	var image := texture.get_image()
	if image == null or image.is_empty():
		_reply(request_id, {}, "GAME_SESSION_CAPTURE_FAILED")
		return
	var error := image.save_png(output_path)
	if error != OK:
		_reply(request_id, {"godotError": error}, "GAME_SESSION_CAPTURE_FAILED")
		return
	var driver := str(render_info.get("renderingDriver", ""))
	# Refresh the live sizes: root.size is not final until the first frame, and
	# the window may have been resized since startup.
	render_info["windowSize"] = [
		DisplayServer.window_get_size().x,
		DisplayServer.window_get_size().y,
	]
	render_info["viewportSize"] = [root.size.x, root.size.y]
	_reply(request_id, {
		"width": image.get_width(),
		"height": image.get_height(),
		"frameRequestedAt": requested_frame,
		"frameCapturedAt": frame_count,
		"scene": observed_scene_path,
		"sceneGeneration": scene_generation,
		"renderingMethod": render_info.get("renderingMethod", ""),
		"renderingDriver": driver,
		"adapterName": render_info.get("adapterName", ""),
		"adapterApiVersion": render_info.get("adapterApiVersion", ""),
		"displayServer": render_info.get("displayServer", ""),
		"isDummyRenderer": bool(render_info.get("isDummyDriver", true)),
		"instances": _instantiated_scene_nodes(),
	})


# --- introspection ---------------------------------------------------------

func _collect_render_info() -> Dictionary:
	var driver := str(_safe_call(RenderingServer, "get_current_rendering_driver_name", ""))
	var window_size: Vector2i = DisplayServer.window_get_size()
	return {
		"displayServer": DisplayServer.get_name(),
		"renderingMethod": str(_safe_call(RenderingServer, "get_current_rendering_method", "")),
		"renderingDriver": driver,
		"projectRenderingMethod": str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "")),
		"adapterName": str(_safe_call(RenderingServer, "get_video_adapter_name", "")),
		"adapterVendor": str(_safe_call(RenderingServer, "get_video_adapter_vendor", "")),
		"adapterApiVersion": str(_safe_call(RenderingServer, "get_video_adapter_api_version", "")),
		"windowSize": [window_size.x, window_size.y],
		"viewportSize": [root.size.x, root.size.y],
		"isHeadless": DisplayServer.get_name() == "headless",
		"isDummyDriver": driver.is_empty() or driver == "dummy",
	}


func _safe_call(object: Object, method: String, fallback):
	if object != null and object.has_method(method):
		return object.call(method)
	return fallback


func _limited_tree() -> Array:
	var result: Array = []
	var scene := current_scene
	if scene == null or not is_instance_valid(scene):
		return result
	var queue: Array = [{"node": scene, "depth": 0}]
	while not queue.is_empty() and result.size() < 500:
		var current: Dictionary = queue.pop_front()
		var node: Node = current.node
		if node == null or not is_instance_valid(node):
			continue
		var depth: int = current.depth
		var visible = null
		if node is CanvasItem:
			visible = node.visible
		elif node is Node3D:
			visible = node.visible
		result.append({
			"path": str(scene.get_path_to(node)) if node != scene else ".",
			"type": node.get_class(),
			"childCount": node.get_child_count(),
			"visible": visible
		})
		if depth < 7:
			for child in node.get_children():
				queue.append({"node": child, "depth": depth + 1})
	return result


func _reply(request_id: String, result: Dictionary, error := "") -> void:
	var response = {"type": "response", "id": request_id, "result": result}
	if not error.is_empty():
		response["error"] = error
	_send(response)


func _send(value: Dictionary) -> void:
	var bytes = (JSON.stringify(value) + "\n").to_utf8_buffer()
	if bytes.size() <= 1048576:
		socket.put_data(bytes)
`;
