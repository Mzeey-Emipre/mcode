---
status: accepted
---

# Shell sessions are repeatable Terminal tabs in the shared right-panel order

The right panel previously treated every tool type as a singleton and kept
multiple shell sessions inside one Terminal tab. That model added a second
terminal navigator inside the panel and made shells behave differently from
the tabs users already manage in the right-panel rail.

Each shell session is now represented by its own Terminal tab. Terminal tabs
are first-class peers of Browser, Review, Plan, and Files in one shared tab
order. New tabs append in creation order, tool types may interleave, and users
can reorder tabs by pointer drag or keyboard movement without changing panel
geometry or tab content. Closing a Terminal tab terminates its shell process
tree. The app-wide `terminal.behavior.sessionLimit` bounds all session scopes,
with a range of 1..20 and a default of 20. `starting`, `running`, and `exiting`
sessions plus `exited` and `failed` tombstones all consume capacity until
explicit close or a replacement reaches `running`; there is no per-scope cap.

Each thread owns its tab order. The workspace-level panel used without an
active thread owns a separate order, consistent with the existing terminal
scope boundary.

This supersedes ADR-0004's Terminal singleton and internal-multiplicity
decision, and the same retained decision in ADR-0012. Other tool types remain
singletons. ADR-0010's one-renderer bound remains: only the selected shell has
a terminal view, while inactive shell sessions keep running with bounded
server-side replay. A naturally exited shell keeps its Terminal tab and
tombstone until explicit close or replacement reaches `running`; it is not
removed automatically.

The trade-off is a richer right-panel tab identity model. The panel can no
longer represent open tabs as a unique list of tool-type strings; repeatable
tabs need stable instance identities and a persistent user-controlled order.
In return, the terminal loses its nested navigation layer and every shell
follows the same visible tab interaction as the rest of the panel.
