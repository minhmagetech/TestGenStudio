---
oncalls: ['horizon_mhs_ai_skills']
description: Debugs issues using Horizon Studio logfiles from horizon_editor, asset_hub_app, and world_app directories. Use when investigating errors, crashes, or unexpected behavior in the editor, asset processing, or preview mode.
---

# Debugging Horizon Studio Logs

## Investigating

If the issue is unclear, ask the user for more details about what they experienced.

## Logfile Layout

| Element | Description |
|---------|-------------|
| Date folders | `YYYYMMDD` format (default: today's date) |
| Process ID folders | Numeric subfolders named by the process ID (PID) |

**Identifying the correct log folder:**

1. **If Horizon Studio is running:** Find the PID of the `metahorizonstudio.exe` process and use the subfolder matching that PID.
   ```powershell
   Get-Process metahorizonstudio | Select-Object Id
   ```
2. **If Horizon Studio is not running:** Use the subfolder with the most recent modified timestamp.
   ```powershell
   Get-ChildItem "<log_path>" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
   ```
**Example structure:**

```text
horizon_editor/
├── 20260226/
├── 20260227/
│   ├── 331728/
│   └── 369484/
└── 20260228/     ← The date the process was running
    ├── 363132/
    └── 384848/   ← The Process ID of the instance
```

---

## Log Locations

| Log Type | Path | Contains |
|----------|------|----------|
| Horizon Studio | `%USERPROFILE%\AppData\Local\Temp\horizon_editor` | Editor errors |
| Asset Hub | `%USERPROFILE%\AppData\Local\Temp\asset_hub_app` | Asset processing errors |
| World App | `%USERPROFILE%\AppData\Local\Temp\world_app` | Preview mode errors |
