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

## Trust boundary

Artifact tracking does not constrain what trusted Blender, Godot, compiler, or
package scripts can write as the local user. It makes declared outputs
traceable and rejects known path escapes; it is not an OS sandbox.

Artifact registration also does not make a file publicly readable. Milestone C
adds a separate short-lived publication gate that revalidates the ledger
record, current path, hash, type, and size at request time.
