# Codex environment settings UI research

Research date: 2026-08-12

This report separates published Codex behavior from recommendations for Mcode issue [#1256](https://github.com/Mzeey-Empire/mcode/issues/1256). OpenAI does not publish a complete current screenshot of the local-environment settings page. The field layout is therefore unknown.

## Evidence

### Directly observed

- Local environments are configured in the ChatGPT desktop app settings pane. They define setup steps and common actions for one project. Codex stores the generated configuration in the project-root `.codex` folder, and users can commit it to Git. [OpenAI: Local environments](https://learn.chatgpt.com/docs/environments/local-environment)
- A setup script runs automatically when Codex creates a worktree for a new chat. The Worktree composer lets the user select a local environment before submission. [OpenAI: Local environments](https://learn.chatgpt.com/docs/environments/local-environment), [OpenAI: Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- Setup supports a default script and macOS, Windows, or Linux overrides. Actions support the same override capability. OpenAI documents overrides, not four required independent scripts. [OpenAI: Local environments](https://learn.chatgpt.com/docs/environments/local-environment)
- Actions are named, icon-bearing commands. They appear in a compact top-bar menu and run in the integrated terminal. The published screenshot shows `Run`, `Build`, a selected action, and `Add action`. [OpenAI: actions screenshot](https://learn.chatgpt.com/images/codex/app/actions-light.webp), [OpenAI: Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)
- On Windows, Codex separates the agent environment from the integrated terminal shell. Local setup scripts use the agent environment. Actions use the integrated terminal environment. [OpenAI: Windows app](https://learn.chatgpt.com/docs/windows/windows-app)
- The local-environment documentation covers setup scripts and actions. It does not document a maintenance or update script. Maintenance scripts belong to Codex cloud environments and run when a cached container resumes. [OpenAI: Local environments](https://learn.chatgpt.com/docs/environments/local-environment), [OpenAI: Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment)
- Codex cloud exposes `Reset cache` on the environment page. For Business and Enterprise environments, the reset can affect every user who shares the cache. This is a cloud trust surface, not evidence for local setup confirmation. [OpenAI: Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment)

### Mcode constraints

- Project settings own one Project environment. Its storage mode is either **On this system** or **Shared in `.mcode`**. The modes never merge. [Mcode #1252](https://github.com/Mzeey-Empire/mcode/issues/1252#issuecomment-5259868832)
- A Platform command stores one default script plus optional operating-system overrides. The current operating-system override wins. Shared commands require approval of the exact resolved script before first execution. [Mcode #1253](https://github.com/Mzeey-Empire/mcode/issues/1253#issuecomment-5269920888)
- Setup owns automatic execution and recovery. Project actions own their run and terminal lifecycle. [Mcode #1254](https://github.com/Mzeey-Empire/mcode/issues/1254), [Mcode #1255](https://github.com/Mzeey-Empire/mcode/issues/1255)
- Issue #1256 locks Project settings as the editor location and one Project actions menu in the active Thread header. [Mcode #1256](https://github.com/Mzeey-Empire/mcode/issues/1256)

## Codex UI pattern

Codex uses a project environment as the configuration object. Setup and actions are its two local capabilities. Setup is lifecycle automation for new worktrees. Actions are named shortcuts in the work surface.

The action launcher is compact. It does not expose command text in the top bar. It shows action identity and opens the terminal when an action runs. Technical command editing stays in settings.

Codex exposes platform specificity as an override of a default script. It does not document separate required Default, Windows, macOS, and Linux values. The official sources do not show whether all optional fields are visible at once. A claim that Codex uses tabs, accordions, or an `Add override` control would be an inference.

## Gaps and unknowns

- The current local-environment list, detail layout, empty state, and naming controls are not visible in official sources.
- The setup editor's exact labels, save behavior, and platform-field disclosure are unknown.
- OpenAI does not document a local confirmation flow for shared setup scripts or actions.
- Local validation, test-run, execution-log, failure, duplicate, and delete surfaces are unknown.
- No official source shows a local maintenance or update script. Do not add one to the Mcode prototype from the Codex cloud model.

## Translation to Mcode

Use Codex's calm separation of identity, configuration, and execution. Do not copy its storage contract. Mcode must expose its exclusive storage mode and exact-script approval because these are locked product rules.

Show the command that applies on the current system first. Keep other operating-system overrides out of the default reading path. This preserves the full Platform command model without presenting four equal editors.

Keep Setup and Project actions as sibling sections. Their command shape is shared, but their lifecycle and recovery behavior differ. Keep execution out of settings: **Run setup** and Project actions launch from the active Thread header and use Thread-owned result surfaces.

For shared configuration, put the trust explanation near the storage choice. Show the exact resolved script only when execution needs approval. Do not turn approval into permanent warning chrome on every editor.

## Recommended settings hierarchy

### Project settings > Environment

1. **Storage**
   - One compact two-option control: **On this system** or **Shared in `.mcode`**.
   - One sentence below the selected option explains its scope and file location.
   - Show a confirmation only when changing storage would replace or relocate existing configuration. Name the source and destination.

2. **Setup**
   - Header: **Setup**. Supporting copy: `Runs when Mcode creates a new worktree.`
   - Primary editor: **Command for this system**, with a small resolved label such as `Windows override` or `Default`.
   - Secondary disclosure: **Other systems**. When open, show only the unused Default, Windows, macOS, and Linux overrides. Do not render empty editors before disclosure.
   - If no script applies, show `Not available on this system` beside the section header.

3. **Project actions**
   - A quiet list of action rows: icon, name, resolved command summary, and availability.
   - Select one row to edit it in place or in a detail region. Show **Name**, **Icon**, and **Command for this system** first.
   - Put **Other systems** behind the same disclosure as Setup.
   - End the list with **Add action**. Keep remove and reorder controls contextual.

4. **Trust and maintenance**
   - For **Shared in `.mcode`**, show `Mcode asks for approval before a shared command runs for the first time or after its effective script changes.`
   - Put **Clear command approvals** in a final maintenance row. Require confirmation because it changes future execution flow.
   - Do not add a maintenance-script editor. The local Codex model provides no evidence for it.

### Active Thread header

- Show one Project actions trigger. The menu lists Setup first only when a manual Setup action is available, then Project actions, then **Edit project actions**.
- Keep idle rows unmarked. Show running, completed, failed, interrupted, approval-required, and unavailable states through the locked Mcode icon and text model.
- Selecting a running action focuses its terminal. Starting an idle action opens its Action terminal. Settings never become a run console.

## Recommendation

Replace the four-field command matrix with one current-system editor and an **Other systems** disclosure. This is consistent with Codex's documented default-plus-overrides model, keeps Mcode's full cross-platform contract, and removes empty platform fields from the normal settings view.
