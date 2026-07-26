export const GODOT_RUNTIME_BRIDGE = String.raw`extends SceneTree

var socket := StreamPeerTCP.new()
var receive_buffer := ""
var authenticated := false
var scene_root: Node
var tap_frames: Dictionary = {}
var heartbeat_frames := 0

func _initialize() -> void:
	var packed = load(OS.get_environment("DEVSPACE_GAME_SCENE"))
	if packed == null or not packed is PackedScene:
		push_error("GAME_SESSION_SCENE_LOAD_FAILED")
		quit(91)
		return
	scene_root = packed.instantiate()
	root.add_child(scene_root)
	var error = socket.connect_to_host("127.0.0.1", int(OS.get_environment("DEVSPACE_BRIDGE_PORT")))
	if error != OK:
		push_error("GAME_SESSION_BRIDGE_CONNECT_FAILED")
		quit(92)

func _process(_delta: float) -> bool:
	socket.poll()
	if socket.get_status() == StreamPeerTCP.STATUS_CONNECTED and not authenticated:
		authenticated = true
		_send({
			"type": "hello",
			"token": OS.get_environment("DEVSPACE_BRIDGE_TOKEN"),
			"engineVersion": Engine.get_version_info().get("string", "unknown")
		})
	if authenticated:
		_read_messages()
		_tick_taps()
		heartbeat_frames += 1
		if heartbeat_frames >= 60:
			heartbeat_frames = 0
			_send({"type": "heartbeat"})
	return false

func _read_messages() -> void:
	while socket.get_available_bytes() > 0:
		var packet = socket.get_partial_data(min(socket.get_available_bytes(), 65536))
		if packet[0] != OK:
			return
		receive_buffer += packet[1].get_string_from_utf8()
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
			_reply(request_id, {"nodes": _limited_tree()})
		"action":
			_inject_action(message)
			_reply(request_id, {"accepted": true})
		"click":
			_inject_click(message)
			_reply(request_id, {"accepted": true})
		"capture":
			_capture.call_deferred(request_id, str(message.get("path", "")))
		"quit":
			_reply(request_id, {"stopping": true})
			quit()
		_:
			_reply(request_id, {}, "GAME_SESSION_COMMAND_REJECTED")

func _inject_action(message: Dictionary) -> void:
	var event := InputEventAction.new()
	event.action = str(message.get("action", ""))
	event.strength = float(message.get("strength", 1.0))
	var operation = str(message.get("operation", "tap"))
	event.pressed = operation != "release"
	Input.parse_input_event(event)
	if operation == "tap":
		tap_frames[event.action] = int(message.get("frames", 1))

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
	var event := InputEventMouseButton.new()
	event.position = Vector2(float(message.get("x", 0)), float(message.get("y", 0)))
	event.button_index = int(message.get("buttonIndex", MOUSE_BUTTON_LEFT))
	event.pressed = true
	Input.parse_input_event(event)
	event = event.duplicate()
	event.pressed = false
	Input.parse_input_event(event)

func _capture(request_id: String, output_path: String) -> void:
	await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	var error = image.save_png(output_path)
	if error != OK:
		_reply(request_id, {}, "GAME_SESSION_CAPTURE_FAILED")
		return
	_reply(request_id, {"width": image.get_width(), "height": image.get_height()})

func _limited_tree() -> Array:
	var result: Array = []
	var queue: Array = [{"node": scene_root, "depth": 0}]
	while not queue.is_empty() and result.size() < 500:
		var current: Dictionary = queue.pop_front()
		var node: Node = current.node
		var depth: int = current.depth
		var visible = null
		if node is CanvasItem:
			visible = node.visible
		elif node is Node3D:
			visible = node.visible
		result.append({
			"path": str(scene_root.get_path_to(node)) if node != scene_root else ".",
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
