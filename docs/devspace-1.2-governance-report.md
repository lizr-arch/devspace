# DevSpace 1.2 — Storage & Worktree Governance Report

Generated: 2026-10-10T07:54:07.113Z

**This report is read-only. Nothing described here was deleted.**

## 1. Job store retention

Directory: `/Users/liz/.local/share/devspace/jobs`

- Total records: **4755**
- Total bytes: **68.5 MiB**
- Policy: succeeded runs become eligible after **30 days**; nothing is deleted automatically (`deletesAnything: false`).

| Class | Count | Bytes (MiB) | Removable? |
|---|---|---|---|
| running | 0 | 0.0 | No — still running |
| recovery_pending | 0 | 0.0 | No — pid/token needed to reap the group |
| failure_evidence | 525 | 32.0 | **Never** — this is the forensics of a failed run |
| expirable | 4230 | 36.5 | Only when outside the window |
| unattributed | 0 | 0.0 | No — ownership cannot be established |

**Eligible for a future cleanup right now: 3717** (only succeeded runs older than the window).

| Job | Ended | Age (days) | Log bytes |
|---|---|---|---|
| job_001b4466-d509-433f-8e34-007414691e7c | 2026-07-29T04:12:50.629Z | 73.15 | 0 |
| job_002e556a-9dbc-4139-a828-036ecec06ebd | 2026-07-28T09:31:03.626Z | 73.93 | 1239 |
| job_00459544-c213-420f-9a30-59dca09e9b6f | 2026-07-27T04:56:28.196Z | 75.12 | 255 |
| job_0052e992-8597-48d7-878d-ca0c650da4b1 | 2026-09-01T15:47:23.794Z | 38.67 | 1261 |
| job_005fb4bc-84c0-430c-9334-c4bc75862383 | 2026-09-02T05:39:10.258Z | 38.09 | 240 |
| job_00604194-7f54-4915-a1f7-5f9d26d8abb4 | 2026-07-25T13:37:28.285Z | 76.76 | 0 |
| job_00650113-eb95-4ee0-bd6a-16a632ed24eb | 2026-09-01T18:26:15.219Z | 38.56 | 435 |
| job_00675fd6-ab96-47e7-912c-316e1526216a | 2026-08-31T04:05:49.769Z | 40.16 | 3710 |
| job_0075390e-ede5-498f-9e92-a4611e96e8d5 | 2026-08-31T07:10:33.558Z | 40.03 | 159 |
| job_009e996d-c7f6-4362-9b5c-53a8c59f7d49 | 2026-09-01T18:27:37.276Z | 38.56 | 502 |
| job_00aef293-7440-418e-9e8a-9c9df02cc3dd | 2026-07-28T17:32:15.107Z | 73.6 | 1705 |
| job_00bea36b-a090-4786-a727-1e976ad39d98 | 2026-08-31T19:14:45.515Z | 39.53 | 7374 |
| job_01160f39-e6b4-4fe9-8cb7-99e913274e15 | 2026-07-27T08:50:32.209Z | 74.96 | 355 |
| job_0117ffd4-f4de-419d-a908-d223a2f7d038 | 2026-09-01T18:45:56.753Z | 38.55 | 356 |
| job_011988e0-8888-4c0b-98b6-24c7d8b61884 | 2026-08-29T11:31:20.302Z | 41.85 | 159 |
| job_011f756c-f3ee-45ab-9ec0-a6c4c6068680 | 2026-09-02T16:08:49.314Z | 37.66 | 501 |
| job_0138836a-3960-42b9-b491-9b40dfdc0cd4 | 2026-07-25T14:57:36.965Z | 76.71 | 5535 |
| job_01448506-77a0-4364-9133-9cd44c94f144 | 2026-08-30T13:54:46.229Z | 40.75 | 502 |
| job_014b1a8c-9cc9-4e76-9a58-1ade1609ac81 | 2026-08-30T15:05:31.470Z | 40.7 | 159 |
| job_0160b24a-b033-4d85-830d-94292e67acc5 | 2026-07-29T09:57:51.256Z | 72.91 | 1397 |
| job_01743ea5-d7c1-4b4a-8f80-c9e8fa1ce581 | 2026-07-28T17:11:30.173Z | 73.61 | 626 |
| job_017770cd-515c-4b7a-bd10-72a584958ff2 | 2026-09-01T10:57:46.709Z | 38.87 | 414 |
| job_0189fe85-8ce0-439c-b2c3-d1e44d075ccb | 2026-07-26T12:31:20.602Z | 75.81 | 1160 |
| job_01b845ac-030b-4e63-a460-d4a6428dff78 | 2026-08-31T07:09:49.709Z | 40.03 | 431 |
| job_01befeeb-2ebb-4997-bd9f-7abca9d5c375 | 2026-09-01T14:57:04.696Z | 38.71 | 159 |
| job_01d64923-d41f-4069-a3cf-9a1f30f11498 | 2026-08-31T04:09:55.012Z | 40.16 | 2321 |
| job_01dce200-03a9-4484-bb46-9bbdd1da2de5 | 2026-07-28T04:43:15.143Z | 74.13 | 349 |
| job_01e44b81-a5af-4341-b609-3fa2e63cce32 | 2026-09-01T18:46:28.332Z | 38.55 | 335 |
| job_01e7edd6-656c-4184-bad2-357af64d13c2 | 2026-07-29T06:58:42.585Z | 73.04 | 349 |
| job_01f23d15-1b2f-439d-98ef-5fc5d6e8da91 | 2026-07-28T08:03:47.097Z | 73.99 | 0 |

Notes:
- This is a preview. DevSpace does not delete job state, and no cleanup runs automatically.
- 525 failed/timed-out/cancelled record(s) are retained as evidence and are never proposed for removal.

## 2. Managed worktree root

Root: `/Users/liz/.devspace/worktrees`

- Directories on disk: **114**
- Mentioned by a workspace record: **86**
- Orphaned (no record): **28**

Orphaned directories are invisible to every DevSpace tool: they are neither listed nor removable. Nothing was deleted.

| Directory | Owning repo | Worktree of it | Modified | Untracked | Unmerged vs origin/main | HEAD | Classification |
|---|---|---|---|---|---|---|---|
| ProceduralTerrains-m5-production | ProceduralTerrains | yes | 0 | 0 | 69 | ea205f6 | **keep — needs review** |
| ProceduralTerrains-main | ProceduralTerrains | yes | 0 | 0 | 56 | 8944f84 | **keep — needs review** |
| ProceduralTerrains-pinned-f8c9c06 | ProceduralTerrains | yes | 0 | 1 | 65 | f8c9c06 | **keep — needs review** |
| ProceduralTerrains-ti1-ref | ProceduralTerrains | yes | 0 | 0 | 13 | 83376d5 | **keep — needs review** |
| TriaRegna-ti0 | TriaRegna | yes | 0 | 0 | 6 | b231ef5 | **keep — needs review** |
| TriaRegna-ti1 | TriaRegna | yes | 0 | 0 | 12 | d4cb968 | **keep — needs review** |
| TriaRegna-ti2 | TriaRegna | yes | 0 | 0 | 29 | 03f524c | **keep — needs review** |
| TriaRegna-ti3 | TriaRegna | yes | 0 | 0 | 39 | 2f3dd87 | **keep — needs review** |
| gamedemo-unit-shadow-v4-review | gamedemo | yes | 0 | 0 | unknown | a6c39ed | **keep — needs review** |
| gamedemo-unit-shadow-v5-planar-realtime | gamedemo | yes | 0 | 0 | unknown | 70ed175 | **keep — needs review** |
| threecountries-destruction-foundation-integration-r2 | threecountries | yes | 0 | 0 | 5 | 2c44a5b4 | **keep — needs review** |
| threecountries-destruction-foundation-r1 | threecountries | yes | 0 | 0 | 2 | b162da58 | **keep — needs review** |
| threecountries-destruction-r1 | threecountries | yes | 0 | 0 | 11 | b91e1e28 | **keep — needs review** |
| threecountries-destruction-v0-1-eval-game-preview | threecountries | yes | 0 | 0 | 23 | dee0c527 | **keep — needs review** |
| threecountries-frozen-authority-restoration-v1 | threecountries | yes | 0 | 0 | 0 | cfb437e6 | no local work detected |
| threecountries-jingzhou-g2-10 | threecountries | yes | 0 | 648 | 12 | 8f05101b | **keep — needs review** |
| threecountries-jingzhou-g2-10-p2 | threecountries | yes | 0 | 0 | 15 | d0d5190a | **keep — needs review** |
| threecountries-jingzhou-g2-3 | threecountries | yes | 0 | 277 | 2 | 9318edf5 | **keep — needs review** |
| threecountries-jingzhou-g2-4 | threecountries | yes | 0 | 0 | 6 | b8612bc7 | **keep — needs review** |
| threecountries-jingzhou-g2-8 | threecountries | yes | 0 | 428 | 7 | c46985a1 | **keep — needs review** |
| threecountries-jingzhou-g2-8b | threecountries | yes | 0 | 428 | 8 | 10882165 | **keep — needs review** |
| threecountries-jingzhou-g2-9 | threecountries | yes | 0 | 522 | 10 | 3a1d68a2 | **keep — needs review** |
| threecountries-siege-wall-gate-reference-v1-eval | threecountries | yes | 1 | 4566 | 28 | 2e7426ac | **keep — needs review** |
| threecountries-siege-wall-v8-4d-apprentice-eval | threecountries | yes | 0 | 0 | 22 | 972726fc | **keep — needs review** |
| threecountries-unit-ground-shadow-visibility-v2 | threecountries | yes | 0 | 0 | 2 | d93b1cd5 | **keep — needs review** |
| threecountries-unit-shadow-c-day-battlefield-v3 | threecountries | yes | 0 | 0 | 5 | 9667add7 | **keep — needs review** |
| threecountries-unit-shadow-native-r-ab-v2 | threecountries | yes | 0 | 0 | 2 | 2b2ceece | **keep — needs review** |
| threecountries-unit-shadow-native-r-v1 | threecountries | yes | 0 | 0 | 1 | 5b1cb12c | **keep — needs review** |

## 3. What is required before anything is removed

1. **Proof of safety** for each specific directory or job record, from the audit above — not from a filename pattern or an age rule alone.
2. **Explicit operator authorisation** for that specific set. DevSpace exposes no automatic cleanup path, and none was added.
3. For worktrees: `git worktree remove` **without `--force`**, so Git independently refuses anything dirty or locked.
4. For job records: only `succeeded` records already outside the retention window may ever be considered. Failed, cancelled, timed-out and interrupted runs are the evidence of what went wrong and are never eligible.

