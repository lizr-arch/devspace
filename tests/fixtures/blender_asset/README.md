# Blender asset fixture

`create_asset.py` is an intentionally small production-chain fixture. Run it
from the repository root through the registered Blender runner:

```json
{
  "runner": "blender",
  "args": [
    "--background",
    "--factory-startup",
    "--offline-mode",
    "--disable-autoexec",
    "--python-exit-code",
    "23",
    "--python",
    "tests/fixtures/blender_asset/create_asset.py"
  ],
  "artifactRoots": ["artifacts/blender_fixture"]
}
```

It creates a low-detail multi-level tower ship, saves the source `.blend`,
exports a `.glb`, renders one PNG, and writes a JSON asset manifest. It proves
the controlled execution and artifact pipeline; it is not production art.
