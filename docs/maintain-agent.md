# Graph maintenance with a dedicated agent

Tier 1 of graph maintenance is mechanical and already automatic: write-time
checks (size/degree caps, every F-series advisory) append one line each to
`<graphRoot>/.advisories`, and `bin/graph-maintain` heals what is deterministic
(half-edges, dangling edges, stale locks). Tier 2 — **semantic rebalancing** —
is the judgment half: merging sparse confetti nodes that shard one fact,
splitting multi-topic junk-drawer hubs into linked children, reconciling forks,
closing out stale pending ledgers. That takes an LLM reading the graph whole,
so it runs as a **dedicated headless agent**, not in the user's conversation.
The backlog notice triggers the work; no cron job is required.

## Trigger

Run a pass when a `memory_write` result carries the one-line notice:

> Maintenance due: N advisories queued at the graph root — …

It appears when `.advisories` depth crosses `maintenanceBacklog` (config,
default 25) and repeats on every write until the queue is rotated away by a
pass. Queue depth is the trigger — accumulation of unaddressed findings — not
wall-clock time and not write count.

## Running a pass

On the host that owns the graph (the plugin and graph live server-side):

```sh
ROOT=~/memory_fs/memories

# 1. Take the pass lock — kernel-atomic mkdir, the graph's own lock idiom
#    (ADR-0013), so two maintain runs can never both claim the queue. NOT
#    .maintain.lock: graph-maintain takes that name itself in step 3 and
#    would always find it held. A leftover lock means a pass is live or died
#    mid-run: inspect before removing it by hand.
mkdir "$ROOT/.maintain-pass.lock" || { echo "another maintain pass holds $ROOT/.maintain-pass.lock" >&2; exit 1; }
trap 'rmdir "$ROOT/.maintain-pass.lock"' EXIT

# 2. Claim the queue — one atomic rename. Concurrent sessions keep appending
#    to a fresh .advisories (appendFile recreates it), so nothing they write
#    during the pass is drained unseen; it queues for the next pass. A
#    leftover .advisories.processing is an earlier pass that died after
#    claiming: drain it first, never overwrite it.
[ -e "$ROOT/.advisories.processing" ] && { echo "unfinished claimed queue at $ROOT/.advisories.processing — drain it first" >&2; exit 1; }
mv "$ROOT/.advisories" "$ROOT/.advisories.processing" || exit 1

# 3. Mechanical heals — cheap, deterministic, no LLM. Same root, and a
#    failure aborts before any LLM spend.
GRAPH_ROOT="$ROOT" ~/memory_fs/bin/graph-maintain --apply || exit 1

# 4. The semantic pass.
dsh --profile headless "$(cat <<'PROMPT'
You are the memory-graph maintenance agent. The graph's advisory queue has
crossed its backlog threshold; your job is one rebalancing pass, then stop.

1. Read <graphRoot>/.advisories.processing (the claimed queue — never touch
   <graphRoot>/.advisories, which is collecting new findings). Group lines by
   node id. Each line is `<ISO> [turn=<id>] <kind> <node-id> <digest>` — a
   write-time finding nobody has acted on yet.
2. node_size / node_degree: memory_read the node. If its body holds several
   distinct topics, split it — for each topic, create a NEW node via
   memory_write with `links` naming the old node (the child must be born with
   that edge — a split may never mint an orphan), move that topic's facts into
   it, then rewrite the old body down to its own single topic. If it is
   genuinely one big topic, leave it and say why. For a pure hub (node_degree),
   also check whether some edges belong on more specific nodes.
3. similar / link_candidates: memory_read the named nodes; if two state the
   same fact, memory_merge(keep_id, absorb_id); if they are distinct but
   related, link them; if unrelated, skip with a note.
   restated_lines: a past merge left the kept body stating a fact twice —
   memory_read the node and rewrite it to ONE statement of each fact, keeping
   one `Merged from <id> on <date>.` provenance line (the absorbed original
   stays in the archive, so the synthesis loses nothing).
4. stale_description: memory_read the node; refresh its description/type.
   stale_pending: the line's node field is the WRITER that triggered the
   sweep, not the stale ledger — the ledger's id is the first token of the
   digest. memory_read the LEDGER and close out its delivered pending lines.
   node_degree lines about a hub grown by incoming links name the HUB in the
   node field (the writer appears only in nearby lines) — treat them like any
   node_degree.
5. verbatim_deliverable: if the body carries a verbatim deliverable (a
   recited report, a multi-row table, quoted full text, a transcript or
   dump), move the payload to an attachment via memory_attach and keep the
   body a gist card; if the lines are the writer's own synthesis there is
   nothing to attach verbatim — but a long_body line on the same node is
   still its own finding, handled below.
   long_body: move the bulk (transcripts, notes, dumps, extended reasoning)
   into an attachment and keep the body a gist. This holds for synthesized
   bodies too — size is the trigger here, not provenance.
   attach_failed: a write carried an inline attachment that did not store
   (F74). The node itself landed; the payload existed only in that turn's
   conversation, so it is NOT recoverable here. memory_read the node and check
   the named file BOTH ways: absent — fix the body so it stops promising a
   file nobody can open; present — the write was an overwrite that failed, so
   the file is the PRIOR payload while the body describes the new one. Note it
   in the body as the older version (never delete it) and report the node, so
   nobody re-serves stale content as the delivered one.
6. blind_rewrite / replaced_body / dropped_body / dropped_ids: read the node
   AND its .node.md.prev (raw file under <graphRoot>/<id>/); if the flagged
   revision dropped facts or identifiers still absent today, restore them
   (put ids back verbatim; record a changed decision as a supersede, never a
   rewrite). If the loss was a legitimate rephrase, note it and move on.
7. Any kind not listed above: read the node, act only when the fix is obvious,
   otherwise report it as skipped. Never silently discard a finding.
8. Never delete content. Changed decisions are superseded, never rewritten;
   nodes are merged or archived, never removed. When unsure, leave the node
   and note it.
9. When every line is addressed or explicitly skipped, archive the claimed
   queue — rename <graphRoot>/.advisories.processing to
   <graphRoot>/.advisories.done-<UTC timestamp> — never delete it. Then
   report: nodes split, merged, refreshed, findings skipped and why.
PROMPT
)"
```

Substitute the deployment's real `graphRoot` for `<graphRoot>` (the `stress`
profile uses `~/memory_fs/memories`).

## Why rotate-then-drain

The journal is the queue and nothing marks a single line handled, so the pass
must reset it — but the plugin appends to `.advisories` without a lock (one
atomic O_APPEND write per memory_write), so a read-then-truncate pass would
erase any findings that landed between its read and its truncate. The atomic
rename closes that window: everything before the rename is the pass's to
drain, everything after lands in a fresh `.advisories` and queues for the next
pass. The rename itself resets the backlog count, which silences the
maintenance-due notice until findings accumulate again; a pass that dies
mid-run leaves `.advisories.processing` behind as evidence (the guard above
refuses to start over it), and new findings keep accumulating loudly in the
live file.

Accepted residue: the plugin appends with a per-call open (no held fd), so an
append already in flight at the rename instant can land in the claimed file
microseconds later. The pass reads the claimed file seconds after claiming it,
so those lines are drained with the rest; and because the pass ARCHIVES the
claimed file instead of deleting it (step 9), even a pathologically stalled
append that lands after the read is preserved in the `.advisories.done-*`
archive rather than destroyed — delayed processing is the worst case, never
loss.

## What is deliberately NOT here

- **No cron / scheduler entry.** Excluded by design (#149): the backlog notice
  is the only trigger.
- **No in-process LLM loop.** The plugin only counts the queue and prints the
  notice; the rebalancing intelligence lives entirely in this headless run.
- **No session-end sweep.** dsh exposes no session-close hook to the plugin
  (one `dsh web` process serves many sessions; process exit handlers must stay
  synchronous), so touched-node sweeping is covered by the inline write-time
  checks plus this pass — see the NODE_SIZE_CAP docblock in
  `dsh_plugin/lib/index.js`.
