# Artifact Security

Game Art Production jobs may declare a small set of workspace-relative output
directories through `artifactRoots`. DevSpace snapshots those roots before the
job, scans them after the job reaches a terminal state, and persists versioned
metadata in the private DevSpace state directory.

The repository is not modified by ledger metadata.

## Artifact root contract

- one to eight explicit workspace-relative directories;
- no absolute paths, parent traversal, backslashes, or whole-workspace `.`;
- existing roots must be real directories;
- the nearest existing ancestor of a future root must remain inside the
  canonical workspace;
- symbolic links encountered at the root or during traversal reject the scan;
- at most 2,048 directories and 512 files are visited per job.

The roots are captured before process spawn. A failed, cancelled, timed-out, or
interrupted job still performs a bounded post-job scan and marks discovered
records `incomplete`.

## Ledger records

`list_artifacts` returns version records with:

- opaque artifact ID;
- workspace-relative path;
- type, format, and MIME type;
- byte size and SHA-256;
- created/modified classification;
- complete/incomplete classification;
- producing Job ID, runner, runner version, and Workspace ID;
- discovery timestamp;
- tracked, untracked, ignored, or unknown Git status;
- current presence: `present`, `missing`, `superseded`, `unsafe`, or
  `unverified`.

The same path may have multiple records. A new SHA-256 is a new version; an old
record remains visible as `superseded`. Deleted files remain visible as
`missing`.

The ledger stores metadata only, never binary contents. Records are written
atomically under the private state directory with owner-only directory/file
permissions. A service restart reloads both terminal Job state and the ledger.
Jobs that were running are marked `interrupted`; their persisted pre-job
baseline is used for a partial-artifact scan.

## Supported V1 formats

The ledger recognizes:

```text
BLEND
GLB
PNG
JPEG
WEBP
JSON
TXT
LOG
```

Signatures are checked for binary formats and JSON is parsed before
registration. The current Blender fixture saves an uncompressed `.blend` so the
native Blender file header can be verified. Individual registered artifacts are
limited to 512 MiB for hashing; JSON signature validation is limited to 4 MiB.
Files above these limits produce an explicit `ARTIFACT_TOO_LARGE` error instead
of an incomplete hash.

## Standard 3D review outputs

Project Blender scripts may use this reusable V1 naming contract:

```text
preview_front.png
preview_back.png
preview_left.png
preview_right.png
preview_top.png
preview_perspective.png
preview_wireframe.png
preview_contact_sheet.png
```

DevSpace registers and publishes these images but does not implement their
camera, composition, wireframe, or contact-sheet logic. A project script may
produce only the views relevant to its review gate; the integration fixture
uses `preview_perspective.png`.

## Trust boundary

Artifact tracking does not constrain what trusted Blender, Godot, compiler, or
package scripts can write as the local user. It makes declared outputs
traceable and rejects known path escapes; it is not an OS sandbox.

Artifact registration also does not make a file publicly readable.

## Short-lived publication

`publish_artifact` accepts a Workspace ID plus exactly one opaque artifact ID
or exact workspace-relative path. Before issuing a URL it revalidates the
ledger record, canonical path, signature-derived MIME type, size, and SHA-256.
Unregistered, missing, superseded, changed, symbolic-link, traversal, and
workspace-external files are rejected.

Publication grants use a random 256-bit bearer token. Only its SHA-256 is kept
in process memory; raw tokens are not persisted or written to audit events.
The default lifetime is ten minutes and callers may request 30-3,600 seconds.
A DevSpace restart intentionally invalidates every outstanding URL.

Every HTTP access repeats path, signature, size, and digest verification, then
opens the file with no-follow semantics and hashes the same descriptor that is
streamed. A file swapped between publication and access is rejected. Response
headers include:

```text
Content-Type: signature-derived type
Content-Disposition: inline for raster images, attachment otherwise
X-Content-Type-Options: nosniff
Cache-Control: private, no-store, max-age=0
Content-Security-Policy: default-src 'none'; sandbox
Referrer-Policy: no-referrer
```

PNG, JPEG, and WEBP are inline image previews. JSON, text/log, GLB, and BLEND
are safe downloads; V1 does not inline HTML, SVG, scripts, or a 3D viewer.
Publication caps are 32 MiB for images, 4 MiB for JSON/text/log, and 128 MiB for
GLB/BLEND.

The configured public base URL must be HTTPS. Plain HTTP is accepted only for
loopback integration tests. The URL is a bearer secret: share it only with the
intended reviewer and use the shortest practical TTL.

Audit events record publication, access, and rejection with artifact/workspace
identity, purpose, expiry, and a short token-hash prefix. They never record the
raw token or local absolute path.

Stable publication errors include:

```text
ARTIFACT_NOT_FOUND
ARTIFACT_MIME_REJECTED
ARTIFACT_TOO_LARGE
PUBLISH_TOKEN_EXPIRED
```
