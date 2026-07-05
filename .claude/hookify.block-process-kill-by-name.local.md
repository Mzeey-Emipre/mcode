---
name: block-process-kill-by-name
enabled: true
event: all
action: block
conditions:
  - field: command
    operator: regex_match
    pattern: (?i)(stop-process[^\n|;]*-name|get-process\b[^\n]*\|[^\n]*(stop-process|kill\b|foreach-object[^\n{]*\{[^\n}]*kill\b)|taskkill\b[^\n]*(/(im|f)\b|/pid\s*\()|pkill\b|killall\b|kill-port|fkill\b|stop-process[^\n]*-id\s*[\(\$]|get-nettcpconnection\b[^\n]*(stop-process|taskkill|kill\b|foreach-object[^\n{]*\{[^\n}]*kill\b)|kill\s[^\n]*\$\(\s*pgrep)
---

🛑 **BLOCKED: process kill by name/port/dynamic PID.**

This machine runs the user's **production Mcode app**, which shares process names (bun, node, electron) and ports with the dev worktree. Name-, port-, pipeline-, or dynamic PID-based kills have repeatedly taken down the user's live session.

Allowed alternatives:
- Stop harness-managed work with **TaskStop** (background task ID).
- Kill only a **literal numeric PID you spawned yourself** this session.
- For any other PID, first verify ownership: `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select CommandLine, ExecutablePath` and confirm the executable path is under the dev worktree (`~\.mcode\worktrees\...`). If it is not, do not kill it.
- If a port (5173/19400/etc.) is busy, do not free it by killing the owner. Ask the user or use another port.
