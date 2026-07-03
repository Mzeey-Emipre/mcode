---
name: block-process-kill-by-name
enabled: true
event: all
action: block
conditions:
  - field: command
    operator: regex_match
    pattern: Stop-Process\s+-Name|taskkill[^\n]*[/-][Ii][Mm]|Get-Process[^|\n]*\|\s*Stop-Process|\bpkill\b|\bkillall\b|kill\s[^\n]*\$\(\s*pgrep
---

🛑 **Blocked: process kill by name.**

Name-based or broad process kills (`Stop-Process -Name`, `taskkill /IM`, `Get-Process | Stop-Process`, `pkill`, `killall`) are forbidden in this repo. The user's **production Mcode app** shares process names (bun, node, electron) with dev processes, and this has repeatedly killed their live app.

Allowed alternatives:
- Stop harness background tasks with TaskStop.
- Kill only by explicit PID (`Stop-Process -Id <pid>`, `taskkill /PID <pid>`) **after** verifying ownership: `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object CommandLine, ExecutablePath` and confirming the path is under the dev worktree (`~\.mcode\worktrees\...`), never the installed app.
- If a port is busy, do not kill its owner — ask the user or use another port.
