# Conversation residency byte budgets

## Method

The measurement fixture uses the retained `Message` shape from the web app.
Each message contains 16,000 content bytes and the normal identity, role,
timestamp, sequence, attachment, tool, file, cost, and token fields.

The measurement uses UTF-8 encoded JSON size. This value is deterministic and
includes all retained message fields. It is a policy weight, not a V8 heap
snapshot. The runtime also measures the complete cache record, prefetched page,
and narrative maps before it applies each budget.

## Results

| History | Encoded bytes |
| --- | ---: |
| 100 messages | 1,621,734 |
| 1,000 messages | 16,219,286 |

The 1,000-message history exceeds the active message budget. Thus, the active
window must evict rows during long-history traversal. The 100-message history
fits without eviction.

## Budgets

| Residency class | Budget |
| --- | ---: |
| Active conversation, total | 13 MiB |
| Active message rows | 8 MiB |
| Inactive conversation records | 16 MiB |
| Prefetched pages | 4 MiB |
| Narrative metadata | 4 MiB |
| Active message rows under critical pressure | 4 MiB |

The active budget holds two maximum-size 4 MiB history pages plus separate
narrative and keyed metadata space. The inactive budget permits several warm
threads but stays small relative to the 150 MB app idle-memory target. The
prefetch budget holds at most one maximum-size speculative page.

Automatic pressure removes prefetched pages first. It removes inactive records
next. Critical pressure reduces the active window only after those classes are
empty. The selected window keeps the visible message anchor and sets both page
boundaries when it removes rows on both sides.
