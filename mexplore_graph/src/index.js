/**
 * Persistent memory for a dsh agent, backed by a filesystem graph.
 *
 * Registers the model-facing memory tools on `ctx.tools` — `memory_search`,
 * `memory_read`, `memory_read_file`, `memory_write`, `memory_attach`,
 * `memory_restore`, `memory_merge` — and, when the composition mounts
 * `ctx.systemPrompt`, one prompt section carrying the live memory index so the
 * agent knows what it already remembers before it decides to ask.
 *
 * The on-disk format is the one the graph's own `bin/` helpers write:
 * directories are Nodes, `__edges__/<dst>` symlinks are Edges (plain edges
 * symmetric — one logical edge, a symlink in both node dirs, F54), and
 * `.access/<id>.log` records traversals. Both writers stay interchangeable.
 *
 * @module dsh-mexplore
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ATTACH_MAX_BYTES, ATTACH_READ_BYTES, DEFAULT_RANK_WEIGHTS, DIRECTED_EDGE_TYPES, EDGE_TYPES, INDEX_BUDGET, NODE_TYPES, ULID_RE, WORK_STATE_TYPES, addEdge, agentAttachmentNameViolation, appendProvenance, assertAttachmentName, attach, attachFromPath, crashAt, createNode, descriptionProblem, edgeSidecarOwners, fileIdentity, indexLines, indexLinesSync, inspectFileBytes, loadNode, mergeNodes, normalizeBody, openWorkState, orphanCensus, outEdges, parseNode, readAttachmentWithHash, readNode, renderNode, restoreNode, search, supersede, supersededBy, today, tokenize, touchEdge, touchRead, updateNode, weekdayName, withNodeLocks } from './graph.js'
import { defineTool } from './tool.js'

/**
 * Which commit this copy of the lib came from (F65, #110). deploy.sh rewrites
 * the whole line below in the STAGED copy just before the live sync; the repo
 * source keeps the `dev` placeholder, so a checkout is honest about being
 * unstamped and a stamped file is never committed. The trailing marker is the
 * point: on the server, grepping it out of this file answers "what exactly is
 * live" in one line, no feature fingerprinting. A `-dirty` suffix on the sha
 * means the deploy came from a tree that did not match its own commit.
 */
export const BUILD = { sha: 'dev', builtAt: null } // BUILD_SHA=dev BUILD_AT=dev

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-graph'

/** The tool registry this plugin registers into. */
export const inject = ['tools']

/** Defaults for every optional configuration field. `maintenanceBacklog`
 * (F70, #149) is the advisory-journal depth past which write results carry the
 * maintenance-due notice — the tier-2 trigger. Backlog, deliberately not cron
 * (#149's design comment): cron fires on idle graphs and sleeps through
 * bursts, while queue depth is the accumulation it exists to answer. 0
 * disables the notice. */
const DEFAULTS = { maxIndexEntries: 200, searchLimit: 20, indexCacheMs: 5000, maintenanceBacklog: 25 }

/** The write-batching bullet `batchWrites` adds to the section (P7-C).
 * Every `memory_write` sent in its own assistant message is its own request,
 * re-paying the prompt, the schemas, the index and every tool result so far;
 * a request-count profile of the reference batching replay (285 write turns) showed
 * 23% of turns writing 2+ times as S→W→W→W, one round-trip per write. dsh
 * executes several tool calls from ONE message inside a single round-trip,
 * sequentially in model order when a tool has not declared itself
 * concurrency-safe — and `memory_write` never does (pinned by test), so write
 * #2's `similar` scan still sees write #1. The bullet asks for exactly that
 * shape and nothing more: the T2 probe (2026-09-07) that paired it with a
 * mandatory "search first" phase LOST tokens (+14.4% input/turn) because the
 * forced search cost more than the batch saved, so the search half is
 * deliberately absent here. Off by default: the section is the product's
 * tested surface and a deployment opts into the behaviour change. */
const BATCH_WRITES_BULLET = `- When this turn needs more than one \`memory_write\`, plan them together and issue them in ONE message as parallel tool calls — never one write per message, because every separate message is a full request that re-sends this prompt, the tool schemas and every result so far. Batching changes nothing about the writes: they still land one after another in the order you gave them, so a later write's \`similar\` check sees the earlier one, and a node you revise must still have been \`memory_read\` in an earlier step. Do not add a search you would not otherwise have made just to precede the batch.
`

/** Body length past which a write result carries the keep-the-body-a-gist nudge
 * (F21, #37). Advisory only: nothing is blocked or truncated. */
const LONG_BODY_CHARS = 1500

/**
 * Verbatim-deliverable shape thresholds (F73, #159). #94's size trigger went
 * structurally dormant at turn granularity: the largest single assistant turn
 * in the 120-turn replay corpus is 2,518 chars (median 467), so a delivered
 * report arriving in per-turn slices never reaches LONG_BODY_CHARS and the
 * whole attach line sat at 0/120 calls. What survives the granularity change
 * is SHAPE, not length: an artifact's contents recited into a body keep their
 * structure — a multi-row table, a long enumeration of a report's items, a
 * quoted block of full text — at any size. Three cheap line scans, advisory
 * like every sibling.
 *
 * TABLE_ROWS counts contiguous |-delimited lines: three rows is already a
 * header, its separator, and data — prose never runs three such lines. The
 * list floor is TOTAL items, not a contiguous run, because the corpus's
 * recited reports interleave section headers (turn 21: 6 风控条, a heading,
 * 4 KYC 条 — 10 items no contiguous window sees); it sits at 8 so a gist
 * card's own three-to-five key conclusions never flag. QUOTE_LINES counts a
 * contiguous `>` block — "the report says…" recitals.
 *
 * Known ceiling, accepted: shape is a proxy for provenance. This cannot tell
 * a recited artifact from the writer's own well-structured synthesis (an
 * 8-bullet analysis it composed itself), and a deliverable flattened into
 * running prose before the write leaves no shape to see. Both stay with the
 * writer — the one party who knows whether the lines are an artifact — which
 * is exactly why this is an advisory and not a gate.
 */
const DELIVERABLE_TABLE_ROWS = 3
const DELIVERABLE_LIST_ITEMS = 8
const DELIVERABLE_QUOTE_LINES = 3

/** One enumeration item: a bullet, a latin/Chinese numbered marker (`(?!\d)`
 * keeps "1.5x…" out), or a circled digit — each with actual content after. */
const LIST_ITEM_RE = /^\s*(?:[-*•]\s+|(?:\d{1,3}[.)、．）]|[（(]\d{1,3}[)）]|[①-⑳])(?!\d)\s*)\S/

/**
 * The F73 detector: a short shape descriptor ("a 58-row table") when the text
 * carries a deliverable-shaped payload, undefined for ordinary prose.
 */
function deliverableShape(text) {
  let tableRun = 0, tableMax = 0, quoteRun = 0, quoteMax = 0, listItems = 0
  // Split on every separator that ends a line for someone (graph.js's
  // LINE_SEPARATOR set), mirrored exactly by metrics.py's LINE_SEP — a CRLF
  // or U+2028 payload must not read as one giant line here and many lines
  // there (codex review rounds 1 and 2).
  for (const line of text.split(/\r\n?|[\n\u2028\u2029]/)) {
    tableRun = (line.match(/[|｜]/g) ?? []).length >= 2 ? tableRun + 1 : 0
    if (tableRun > tableMax) tableMax = tableRun
    quoteRun = /^\s*[>＞]/.test(line) ? quoteRun + 1 : 0
    if (quoteRun > quoteMax) quoteMax = quoteRun
    if (LIST_ITEM_RE.test(line)) listItems += 1
  }
  if (tableMax >= DELIVERABLE_TABLE_ROWS) return `a ${tableMax}-row table`
  if (quoteMax >= DELIVERABLE_QUOTE_LINES) return `a ${quoteMax}-line quoted block`
  if (listItems >= DELIVERABLE_LIST_ITEMS) return `a ${listItems}-item enumeration`
  return undefined
}

/**
 * Tier-1 granularity caps (F70, #149) — the mechanical half of the
 * mega-hub/sparse-confetti equilibrium. In the 20260826-113709 audit one
 * 3-line roster hub accreted ~22% of the corpus's facts (every hardware fact,
 * a stale snapshot, a duplicated fact) because nothing ever said "this node is
 * full"; it then became the contention magnet of the concurrency runs (#145).
 * Both checks run inline at write time — one readdir and a length on the node
 * just written, no scan — and emit ADVISORIES: the caps block nothing, because
 * a legitimate big node exists (a long-running thread ledger) and only the
 * writer can tell it from a junk drawer.
 *
 * NODE_SIZE_CAP is deliberately above LONG_BODY_CHARS: `long_body` (F21) asks
 * for bulk to move into an attachment; `node_size` asks for TOPICS to move
 * into linked child nodes, and fires only once a body could plausibly hold
 * several. NODE_DEGREE_CAP sits just under the observed pathology — replay-v3
 * hubs ran degree 10–16 while the healthy loan line chunked at ~4 edges per
 * node — so a genuine index node clears it only after it has in fact become a
 * hub.
 *
 * #149's design also allowed a session-end sweep over the Session's touched
 * nodes, contingent on a clean session-close hook. There is none to build on:
 * the plugin's whole lifecycle surface is `apply()` (once per process), tool
 * executions, and prompt assemblies — dsh announces neither Session start nor
 * Session end, which is exactly why F69's session store falls back to LRU
 * eviction and why F62 reads the turn counter off the assemble context. The
 * two stand-ins are both wrong: process exit is not session end under
 * `dsh web` (one process, many Sessions) and its handlers must stay
 * synchronous, unfit for a sweep that appends advisories; the turn counter
 * marks turn boundaries INSIDE a live Session, so a sweep there would run
 * mid-conversation — the latency the design routed to the headless agent
 * precisely to avoid. So the sweep is skipped rather than hacked in: every
 * write already stats the node it touched inline, and read-only touches are
 * the maintain agent's census to make.
 */
const NODE_SIZE_CAP = 4000
const NODE_DEGREE_CAP = 12

/**
 * Evidential auto-attach of the raw observation (F79, #180). When a write's
 * body is a short gist distilled from a much larger prompting turn — the reference retrieval
 * shape: a gist card written over a 100k-char accessibility-tree chunk, with
 * every static UI enumeration dropped — the write path saw the answer and threw
 * it away. #174 proved the prompting turn is readable at execute time; this
 * captures it as `observation.txt` so the raw material the gist was distilled
 * from survives on the node.
 *
 * Two knobs, tuned on the reference replay corpus (see #180's acceptance):
 *   - MIN_TURN gates out ordinary short conversational turns — a user saying
 *     "remember X" discarded nothing, so there is nothing to preserve.
 *   - RATIO fires only when the observed turn dwarfs the gist, which is the
 *     lossy-by-construction case the issue is about.
 */
const AUTO_OBSERVE_MIN_TURN = 2000
const AUTO_OBSERVE_RATIO = 4
const OBSERVATION_FILE = 'observation.txt'

/**
 * Bytes held back from the attachment cap for the truncation marker an
 * over-cap observation ends with (F81, #182). A hard upper bound on that
 * marker: its fixed text is ~110 bytes and its two integers can never exceed
 * 16 digits each, so the stored file is always inside the cap and `attach()`
 * never rejects a capture for being one byte over.
 */
const OBSERVATION_MARKER_RESERVE = 256

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * character (F79, codex review of #180). A naive byte slice can cut a multibyte
 * sequence, and decoding the halves inserts U+FFFD whose re-encoding can push
 * the result BACK over the cap — so `attach()` would reject the whole payload
 * and the oversized-turn fallback would silently store nothing. Shave whole
 * characters until the bytes fit and no replacement tail remains.
 */
function capUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  if (out.endsWith('�')) out = out.slice(0, -1)
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return out
}

/**
 * Attachment stems that name nothing (F82, #191). An attachment is the node's
 * curated detail tier, and its filename is the only thing search rows, the node
 * view and the user's own question ("那份周报") carry before the file is opened —
 * so a file called `notes.md` throws that handle away at the moment it is
 * cheapest to keep. Exactly the six stems the issue names, each matched with or
 * without an extension and case-insensitively, so `Details`, `data.md` and
 * `INFO.txt` all fire. Deliberately not widened to plurals or near-misses:
 * this is an advisory on a landed write, and a false fire teaches the writer to
 * read past it — the same cost logic every sibling advisory is tuned by.
 */
const GENERIC_ATTACHMENT_STEMS = new Set(['attachment', 'notes', 'details', 'file', 'data', 'info'])

/**
 * The generic-attachment advice's own exemption, kept for the F79 capture.
 * `observation.txt` cannot be authored by an agent at all (#255: both write
 * tools refuse that filename in their `semantic` hook, because a Session that
 * wrote it would make the next autosave skip its `.prev` copy), so no writer
 * chose this name on any landing surface — which is exactly why it never draws
 * naming advice. The exemption stays as the belt to that brace: a legacy file,
 * or a future route that lands the capture through a path this comment does not
 * foresee, still gets no nag about a name the framework chose.
 */
function genericAttachmentName(name) {
  if (typeof name !== 'string' || name === OBSERVATION_FILE) return undefined
  const stem = name.replace(/\.[^.]*$/, '').trim().toLowerCase()
  return GENERIC_ATTACHMENT_STEMS.has(stem) ? name : undefined
}

/**
 * The generic-filename advisory's one wording (F82, #191), shared by
 * `memory_write` and `memory_attach` so identical content reports identically
 * whichever route stored it — the property #167/F78 shipped the standalone
 * route to hold. Forward-looking on purpose, and deliberately NOT prescribing a
 * repair of the file it fired on: nothing renames an attachment, and every
 * route recomputes this advisory from the landed name, so telling the writer to
 * overwrite the generic file would earn the same advisory a second time (gpt-5.6
 * review of this change). What it asks for instead cannot loop — name the file's
 * contents in the body, and name the NEXT detail file properly.
 */
function renderGenericFilename(rawFile, id) {
  // Folded through the journal digest (F64, #109) for the same reason the
  // search row JSON-quotes a filename (codex review of #182): an attachment
  // name may legally contain a newline — `assertAttachmentName` bars path
  // separators and dotfiles, not those — and a raw interpolation would let one
  // forge extra lines in a model-facing result.
  const file = advisoryDigest(rawFile)
  // F87 (#202): one line. The filename-is-a-retrieval-handle rationale is cut
  // (it lives in the prompt the model has read) — the rule and the fix stay,
  // and the example names keep showing what a real name looks like.
  return `Attached as ${file} — a generic name. Say in ${id}'s body what ${file} holds, and give detail files contentful names.`
}

/**
 * How much of the advisory journal the two read-back surfaces look at (F70,
 * #149): the per-node advisories a `memory_read` appends, and the backlog
 * count behind the maintenance-due notice. The file is append-only and
 * unbounded, so only the tail is read — but unlike ZERO_WRITE_TAIL these
 * readers run on tool execution, not synchronous prompt assembly, so the
 * window is 4 MiB: ~14k entries at typical line lengths, past which the graph
 * has been screaming maintenance-due for thousands of writes. Within it, the
 * backlog count is exact for any sane threshold and a node's queued lines
 * cannot be evicted by other nodes' traffic (codex review, round 1). Past it
 * both surfaces degrade gracefully to the window: the count is a floor that
 * still clears the threshold, and per-node surfacing goes opportunistic —
 * which is its spec. The one entry either can misread is a pathological one,
 * a single line longer than the window (same accepted case as
 * ZERO_WRITE_TAIL's over-long turnId). The read's cost is proportional to the
 * journal's ACTUAL size, not the cap — a maintained journal is a few KB — and
 * approaching the cap means maintenance is thousands of findings overdue,
 * where a heavier tool call is the acceptable degradation.
 */
const ADVISORY_TAIL = 4 * 1024 * 1024

/** How many of a node's journal lines one read view renders (F70, #149) —
 * newest last, like the journal itself. The view is a pointer at the queue,
 * not the queue. */
const NODE_ADVISORIES_SHOWN = 5

/** Rows a memory_write advisory list renders before it caps (F87, #202) —
 * `similar` and `link_candidates`, highest score first. The list is a pointer
 * at the duplicates/relatives, not the set: past this it appends a `… N more`
 * count. Bounds the block that ran to the 12k-char result tail. */
const ADVISORY_ROWS_SHOWN = 5

/** Hard ceiling on a whole memory_write result (F87, #202). mean write result
 * is ~1.3k chars; the tail hit 12,652, all advisory text re-sent on every later
 * step of the turn. The per-block bounds keep an ordinary write far under this;
 * this is the backstop, applied to the joined text with a loud truncation
 * marker (ADR 0006's bounded-surface rule — never a silent cut). */
const RESULT_CHAR_CEILING = 3000

/** The loud marker a truncated memory_write result ends with (F87, #202) — a
 * marker, never a silent cut (ADR 0006), and the whole result including it stays
 * within RESULT_CHAR_CEILING. It says the write LANDED so the marker is never
 * read as a failure. It does NOT tell the writer to re-run the write to see the
 * rest (codex review): a memory_write is state-changing — re-running a create
 * would duplicate the node — and the advisories beyond the cut are the tail, the
 * least urgent, with the load-bearing ones (duplicates, loss) rendered first. */
const RESULT_TRUNCATED_MARKER = '\n… truncated — the write landed; more advisories fired than fit here.'

/** Body chars a node view renders before it truncates loudly — a
 * multi-hundred-KB body would flood the model's context in one call. It is the
 * blind-rewrite guard's honesty bound too (F62, #107): past this, a
 * `memory_read` showed a prefix, not the body, so it confers no knowledge of
 * the tail a rewrite would destroy. */
const BODY_VIEW_CHARS = 50000

/** Longest payload digest an advisory journal line carries (F64, #109). The
 * line is a pointer for offline analysis, not a copy of the write: 200 chars
 * holds a suggestion pair or a description, and a run of them cannot bloat the
 * file past what `grep` and a terminal handle. */
const ADVISORY_JOURNAL_CHARS = 200

/** SHA-256 of raw node.md bytes, used only by the in-process version gate. */
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * One journal-safe rendering of an advisory's payload (F64, #109). The file is
 * line-oriented, so every character that ends a line for someone folds to a
 * space — descriptions are guarded against those at write time, but an
 * externally written node.md is not, and a forged line is worse than a folded
 * one. Truncation drops a trailing lone surrogate the same way the index does,
 * so the cap never emits half a character.
 */
function advisoryDigest(payload) {
  const flat = payload.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()
  if (flat.length <= ADVISORY_JOURNAL_CHARS) return flat
  return `${flat.slice(0, ADVISORY_JOURNAL_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}

/**
 * A `turnId` as the journal's `turn=` field carries it (F64, #109).
 *
 * `turnId` is validated as a single LINE at config load (F48, #84) — that is
 * all the zero-write marker needs, where a fixed `zero memory_write calls`
 * closes the line — but the journal's remaining fields are positional, so an
 * id holding a space or a tab would shift `kind`, the node id and the digest
 * one place each and make a replay's advisories ungroupable. Percent-encoding
 * is confined to the two characters that could do that damage — whitespace,
 * and `%` itself so the escape stays reversible — which leaves an ordinary
 * trace/step id (`420002/step-12`) byte-identical to an unencoded one and
 * round-trips the rest through `decodeURIComponent`. Config validation is
 * deliberately NOT tightened: it throws at load, and a replay already in
 * flight must not die on the id it has been passing all along.
 */
function journalTurn(id) {
  return id.replace(/[%\s]/g, (char) => encodeURIComponent(char))
}

/**
 * Every advisory a write result carries, as `[kind, payload, about?]` in the
 * order the render shows them (F64, #109). Empty for a clean write — the
 * journal is advisories only, and silence there means none fired. `about` is
 * the node id the journal line should carry when the finding is about a node
 * OTHER than the one written (F70's hub peers); absent means the written node,
 * which is every other advisory.
 *
 * A new advisory field has two surfaces to reach, this one and the render: an
 * advisory the agent is shown but the journal omits is precisely the blindness
 * F64 exists to end, so add it here in the same change.
 *
 * `maintenance_due` (F70, #149) is deliberately NOT here: it is a reading of
 * this very journal's depth, not a finding about a node, and journaling it
 * would grow the queue it measures — every over-threshold write would push the
 * backlog further over.
 */
function advisoryEntries(value) {
  const entries = []
  const suggestions = (list) => list.map((s) => `${s.id} — ${s.description}`).join('; ')
  // An inline attachment that failed after its write landed (F74, #163) — a
  // payload the writer may believe stored, which is exactly the blindness this
  // journal exists to end. A LANDED inline attach is an outcome, not a
  // finding, so it stays out, like `superseded`.
  if (value.attach_failed !== undefined) entries.push(['attach_failed', value.attach_failed])
  // The detail tier's name (F82, #191), beside the other attachment finding —
  // journaled from both routes, so a replay can count generic names per corpus.
  if (value.generic_filename !== undefined) entries.push(['generic_filename', value.generic_filename])
  if ((value.similar ?? []).length > 0) entries.push(['similar', suggestions(value.similar)])
  if (value.long_body !== undefined) entries.push(['long_body', `${value.long_body} chars`])
  if (value.verbatim_deliverable !== undefined) entries.push(['verbatim_deliverable', value.verbatim_deliverable])
  if (value.node_size !== undefined) entries.push(['node_size', `${value.node_size} chars`])
  if (value.node_degree !== undefined) entries.push(['node_degree', `${value.node_degree} edges`])
  // A peer this write's link pushed past the degree cap journals as
  // node_degree ABOUT THE PEER (F70, #149): grouping by node id must find the
  // hub, and reading the hub must surface it.
  for (const hub of value.hub_links ?? []) entries.push(['node_degree', `${hub.degree} edges`, hub.id])
  if ((value.link_candidates ?? []).length > 0) entries.push(['link_candidates', suggestions(value.link_candidates)])
  if (value.blind_rewrite !== undefined) entries.push(['blind_rewrite', `${value.blind_rewrite} chars`])
  // The append restatement (F89, #219) — a finding, so it journals; the
  // append's body_chars is an outcome and stays out, like `attached`.
  if (value.restated_append !== undefined) entries.push(['restated_append', `${value.restated_append}%`])
  if (value.replaced_body !== undefined) entries.push(['replaced_body', `${value.replaced_body} chars`])
  if (value.dropped_body !== undefined) entries.push(['dropped_body', `${value.dropped_body} chars`])
  if ((value.dropped_ids ?? []).length > 0) entries.push(['dropped_ids', value.dropped_ids.join(' ')])
  if (value.stale_description !== undefined) entries.push(['stale_description', value.stale_description])
  if ((value.unsourced_assertions ?? []).length > 0) entries.push(['unsourced_assertions', value.unsourced_assertions.join('; ')])
  if ((value.minted_precision ?? []).length > 0) entries.push(['minted_precision', value.minted_precision.join('; ')])
  // The merge synthesis nudge (F72, #152) rides a memory_merge result, whose
  // node field is keep_id, not id — the finding is about the kept node.
  if ((value.restated_lines ?? []).length > 0) entries.push(['restated_lines', value.restated_lines.join('; '), value.keep_id])
  if ((value.stale_pending ?? []).length > 0) entries.push(['stale_pending', value.stale_pending.map((m) => `${m.id} — ${m.line}`).join('; ')])
  return entries
}

/**
 * F52 (#88) revision-completeness thresholds. All three are advisory —
 * nothing is blocked, rewritten, or auto-generated.
 *
 * STALE_DESCRIPTION_DELTA: a body revision that moves the length by at least
 * this many chars without touching `description` gets the confirm-it-still-
 * summarizes nudge. 400 ≈ a paragraph: the F8 write-back convention grows
 * thread bodies by a status line or two every session, and nagging every
 * write-back would be advisory fatigue — while the misses this guards
 * (430003 s6's resolved-answer rewrite, 420002 s3's 149→944 fill) all moved
 * the body by several hundred chars. A big same-size rewrite is caught by the
 * replaced/dropped advisories feeding the same nudge, not by this delta.
 *
 * LOSSY_SHRINK_RATIO / LOSSY_DROPPED_FRACTION / LOSSY_MIN_UNITS: the
 * lossy-shrink widening of F47 (#80). The original check fires only when a
 * revision keeps NOTHING of the prior body; 420002 s10 kept most of the node
 * while dropping two dated facts (371→288 chars) and stayed under it. Fire
 * when the new body both shrank the char count past the ratio (s10: 0.78;
 * pure expansions like 430003 s5's 452→939 and s3's 149→944 are > 1 and
 * trivially silent) AND lost at least the fraction of the prior body's
 * content units (`descriptionUnits`: latin/digit tokens + Han characters
 * covered through bigrams — the #98 machinery, so Chinese text measures in
 * word-sized units, not opaque clause tokens). Both gates together keep a
 * tightening rephrase silent: trimming filler barely moves unit coverage, and
 * a same-length reword fails the shrink gate. LOSSY_MIN_UNITS keeps
 * few-word bodies out — at that size coverage fractions are too coarse to
 * mean anything and the wholesale F47 check already owns total loss.
 */
const STALE_DESCRIPTION_DELTA = 400
const LOSSY_SHRINK_RATIO = 0.9
const LOSSY_DROPPED_FRACTION = 0.3
const LOSSY_MIN_UNITS = 10

/**
 * Placeholder vocabulary a stub node advertises while its answer is still
 * being fetched (F52, #88). Deliberately tiny and literal — these are the
 * exact markers observed in the dossier replays ("（用户查询，后台检索中）",
 * "具体内容待检索确认") plus their English counterpart; a fuzzy list would
 * start flagging descriptions that merely discuss pending work. The CJK
 * markers match as substrings (they do not embed in longer unrelated words —
 * 检索中 inside a longer phrase still genuinely signals pending); the latin
 * one matches only as a whole word (codex review of #100: "CSV appending
 * strategy" contains the substring), case-insensitively.
 */
const PLACEHOLDER_MARKERS = ['待确认', '待检索', '检索中']
const LATIN_PLACEHOLDER_RE = /\bpending\b/i

/** The placeholder marker text carries, or undefined when it carries none. */
function placeholderMarker(text) {
  for (const marker of PLACEHOLDER_MARKERS) if (text.includes(marker)) return marker
  return LATIN_PLACEHOLDER_RE.exec(text)?.[0]
}

/** Whether text still carries a placeholder marker. */
function hasPlaceholder(text) {
  return placeholderMarker(text) !== undefined
}

/**
 * What makes a line of a work-state body a PENDING ITEM (F61, #106) — the
 * close-out sweep's first gate. Two sources, both literal:
 *
 *  - the placeholder vocabulary above (a stub's "检索中"/"待确认" is exactly the
 *    open-item marker when it sits in a ledger line — 430003's `ledger-b` items
 *    7–8 read "2030年4月KORVAL演示许可分类：检索中" 13 steps after `result-a` stored
 *    the answer), plus the empty-return forms replay v3 actually produced:
 *    420002's `ledger-a` marked three items "结果未返回";
 *  - the state shape the section prescribes for work-state nodes — pending /
 *    blocked-on / next-step / owed — so a ledger written the way the prompt
 *    asks is scannable by the words the prompt asked for.
 *
 * Plus the markdown unchecked box, which says "open" with no vocabulary at all.
 *
 * A marker is STRIPPED before the line is scored: "Fern会 结果未返回" is a
 * status glued to an item, and only the item identifies what a later write
 * might have resolved. Leaving the status in would also let two unrelated
 * pending lines score on their shared "未返回". Longest form first — the whole
 * observed phrase "结果未返回" goes, not just its "未返回" tail, or the generic
 * "结果" would stay behind and dilute a two-character item to a quarter of
 * itself.
 */
const PENDING_MARKERS = ['结果未返回', ...PLACEHOLDER_MARKERS, '未返回', '未回复', '未完成', '待回复', '待返回', '待办', '进行中']
// Both separators on the two-word forms: the section writes them hyphenated
// ("blocked-on", "next-step") and a ledger line writes them out.
const LATIN_PENDING_RE = /\b(pending|awaiting|unanswered|outstanding|blocked[ -]on|in[ -]progress|next[ -]steps?|todos?|owed)\b/gi
// Ordered lists count as lists: a ledger numbers its items as often as it
// bullets them (430003's `ledger-b` numbered them).
const UNCHECKED_BOX = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s*)?\[\s\]\s*/
// Its opposite, and the one unambiguous "this one is done" a ledger writes: a
// checked box closes the line whatever words trail it ("- [x] pending: Fern
// notes" is a delivered item that still carries the word). Nothing else is
// read as done — "结果未返回,已催办" is still waiting, and a done-vocabulary
// guess would silence exactly the lines this sweep exists for.
const CHECKED_BOX = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s*)?\[[xX✓✔]\]/

/**
 * The words a ledger uses to STRUCTURE itself rather than to name an item.
 * "Pending items:" survives marker-stripping as `items`, a one-unit "item"
 * that any later write mentioning items would appear to resolve. Dropped from
 * the pending item's identity only — nowhere else in the plugin, where these
 * are ordinary topic words — and a real item keeps its own vocabulary beside
 * them ("task runner upgrade" still carries `runner` and `upgrade`).
 */
const PENDING_SCAFFOLD = new Set(['item', 'items', 'list', 'lists', 'task', 'tasks', 'work', 'other', 'others', 'open', 'status', 'update', 'updates'])

/**
 * A ledger writes its open items two ways, and both have to read as pending:
 * marker per line ("- Fern会 结果未返回"), or one marked HEADER over a plain
 * list ("Pending items:" / "其他待办:" then "- vendor SOC2 report"). A header
 * is a marked line ENDING in a colon — measured on the raw line, so a marked
 * item whose own marker trails a colon ("…牌照分类:检索中") is never mistaken
 * for one — and the list under it inherits its state until a non-list line
 * ends the block. Blank lines do not end it; a heading and its list are
 * routinely separated by one.
 */
const PENDING_HEADER = /[:：]\s*$/
const LIST_LINE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s/

/**
 * The item text of a pending line, markers removed — or undefined when the
 * line claims nothing pending at all (which is most lines, and the reason this
 * gate runs before any scoring).
 */
function pendingItem(line) {
  if (CHECKED_BOX.test(line)) return undefined
  let marked = UNCHECKED_BOX.test(line)
  let rest = line.replace(UNCHECKED_BOX, '')
  for (const marker of PENDING_MARKERS) {
    if (!rest.includes(marker)) continue
    marked = true
    rest = rest.split(marker).join(' ')
  }
  const stripped = rest.replace(LATIN_PENDING_RE, ' ')
  if (stripped !== rest) marked = true
  return marked ? stripped : undefined
}

/**
 * The evidence gate on assistant-behaviour assertions (F71, #157).
 *
 * At turn granularity the writer invents whole EPISODES about the assistant —
 * always the same shape, "the assistant searched, found nothing, and honestly
 * told the user" — on read-then-update of an open deliverable node whose turn
 * resolved nothing (a synthetic replay repeats this shape on the same
 * handoff). The invented event hardens into permanent status and
 * corrupts neighbouring nodes.
 *
 * What this gate can and cannot see, honestly: the plugin NEVER sees the
 * turn's transcript, so no check here can compare an asserted event against
 * what actually happened — there is no evidence oracle, and pretending to one
 * would be the plugin fabricating verification the way F50 forbids fabricating
 * memory. What it CAN see is the assertion's shape and its cited evidence: a
 * line claiming a concrete assistant event (助手…检索/告知/未生成/捏造/
 * 被…纠正, and the English equivalents) either carries a quoted span —
 * 「…」/『…』/“…”/"…" — or cites nothing at all. The section's rule makes the
 * quote the writer's obligation ("quote the turn or cite nothing"), so the
 * gate flags the quoteless lines. A quote is provenance CLAIMED, never
 * verified — but an invented episode has nothing to quote, and all three
 * observed fabrications were quoteless narrative lines.
 *
 * Narrow by the same cost logic as every sibling advisory:
 *  - subject AND event verb must share one line — a rule carrying 捏造 without
 *    助手 (turn 6's gotcha node) or an event about someone else never fires;
 *  - a NORMATIVE line (必须/严禁/never/must…) states a rule, not an event, and
 *    is skipped — rules about assistant behaviour are exactly what preference
 *    and gotcha nodes exist to hold. A rule written as a CONTINGENCY rather
 *    than a command (若…应…) is NOT skipped: it draws the advisory, an
 *    accepted false positive argued at the vocabulary note below;
 *  - on update, a line the prior body already carried trimmed-verbatim was not
 *    minted by this write — the gate presses on NEW assertions, never on
 *    faithfully carried history.
 * The verb list is the observed vocabulary from #157 plus literal English
 * equivalents, not a taxonomy — extending it waits for evidence, like
 * PLACEHOLDER_MARKERS did. Advisory only, F61's posture: the write lands.
 */
const ASSISTANT_SUBJECT_RE = /助手|\bassistant\b/i
/**
 * The artifact as subject (F71.1, #167): the round-12 replay's fabrication
 * carried no actor at all. Turn 6 stored `报告已生成并念给用户` and
 * `已更新并写回文档` from a two-line turn that contains neither event, and
 * the gate never saw them because ASSISTANT_SUBJECT_RE wants 助手 in the
 * clause. A delivered artifact is an assistant-behaviour claim with the actor
 * elided, so the deliverable itself stands in as the subject.
 *
 * ORDER carries the meaning, and it is what keeps this branch quiet on the
 * corpus: 「报告已交付」 asserts an event, while 「已交付：…报告」 is the
 * ledger label this corpus writes on every delivered node — same words, and
 * only the first is a claim. The artifact has to come BEFORE the completion,
 * inside one clause. `已` is required for the same reason: 「报告未实际生成
 * 或交付」 (v3 turn 86, the correct line) states a NON-event and must stay
 * silent.
 */
const ARTIFACT_SUBJECT_RE = /报告|文档|周报|纪要|附件|\.md\b|\b(?:report|document|deck|summary|write-?up)\b/i
/** The same list, global, for finding the artifact NEAREST a completion rather
 * than the leftmost one in the clause (sonnet review of #167). `matchAll`
 * requires the flag and iterates a clone, so `lastIndex` never leaks. */
const ARTIFACT_SUBJECT_G = new RegExp(ARTIFACT_SUBJECT_RE.source, 'gi')
const ARTIFACT_DONE_RE = /已(?:经)?(?:生成|交付|完成|发送|发出|发给|写回|更新|出具|念给)|\b(?:has been|have been|was|were)\s+(?:generated|produced|delivered|sent|written|updated)\b/i
/**
 * The other half of the same claim (F71.1, #167): a completion verb that
 * GOVERNS the artifact rather than following it — `已更新并写回文档`, the
 * second fabricated line of round 12's turn 6. Order cannot separate this one
 * from the ledger label, so adjacency does: the verb takes the artifact as its
 * direct object with nothing between them, while `已交付：…报告` puts a colon
 * there. The clause still has to carry 已 for the claim to be a completed one,
 * which is what keeps `下一步：整理周报并交付` silent.
 */
const ARTIFACT_DONE_GOVERNS_RE = /(?:生成|交付|完成|发送|发出|发给|写回|更新|出具|念给)(?:了)?\s*(?:报告|文档|周报|纪要|附件)|\b(?:generated|produced|delivered|sent|wrote|updated)\s+the\s+(?:report|document|deck|summary)\b/i
const DONE_MARKER_RE = /已(?:经)?|\b(?:has|have|was|were)\b/i
/**
 * An OPEN QUESTION about a deliverable is not a claim that it landed (F71.1,
 * #167). `不知道…报告是否已完成` is the corpus's own way of recording that the
 * state is unknown — the honest line this gate wants more of, and the single
 * false positive the artifact branch drew across 2,301 replay lines. Scoped to
 * that branch on purpose: #166 deleted a silencer that reached the whole gate
 * and swallowed completed claims with it.
 */
const ARTIFACT_UNKNOWN_RE = /是否|不知道|不确定|待确认|尚未确认|\bwhether\b|\bunclear\b|\bunknown\b/i
/**
 * Someone else is named as the actor (F71.1, #167), so this is a report about
 * them and not an unattributed assistant claim: 「文档已由用户更新」, "the
 * summary has been updated by the user". The assistant-subject branch is
 * unaffected — a clause naming 助手 as actor is its business either way.
 */
const OTHER_ACTOR_RE = /由(?:用户|客户|对方|他|她|同事)|\bby\s+(?:the\s+)?(?:user|client|customer|team|author)\b/i
/**
 * How far the completion may sit from the artifact it completes (F71.1,
 * #167). Chinese has no word boundary, so 报告 matches inside 上报告警 and 文档
 * inside 文档案 — and a wide window turns 「周报告警规则已更新」 into a
 * delivery claim. The four true positives measured over the replay corpus sit
 * at gaps of 0, 0, 0 and 2 (an em-dash pair), so the window is 3: tight enough
 * that an unrelated noun phrase between them breaks the match, wide enough for
 * the punctuation this corpus actually writes. The accepted miss is the loose
 * form 「报告的第一版已交付」, which no corpus line has yet taken.
 */
const ARTIFACT_DONE_GAP = 3
/** The completion list, global, so every occurrence in a clause is considered
 * and not only the leftmost (sonnet review of #167). */
const ARTIFACT_DONE_G = new RegExp(ARTIFACT_DONE_RE.source, 'gi')
// 念给/念出 join the observed vocabulary on round 13's evidence (F71.2, #167),
// not on a taxonomy — the rule this list states is that an extension waits for
// a line that was actually written. Turn 6 wrote both 并念给用户听 and
// 助手念出了《…纪要》全文, and reading a deliverable aloud IS the delivery event
// in this corpus. The artifact branch has always known that (念给 sits in
// ARTIFACT_DONE_RE and ARTIFACT_DONE_GOVERNS_RE); the actor branch was the only
// one that could watch 助手念出了… go past.
//
// The lookbehind is the substring discipline ARTIFACT_DONE_GAP states for 报告
// inside 上报告警, one axis over: Chinese has no word boundary, so 念 is the
// tail of 概念/理念/纪念/悼念/想念/观念/悬念/挂念/惦念/执念/杂念 and both
// 「助手指出概念出现偏差」 and 「助手指出这种观念给用户带来了误解」 would read as
// a delivery the moment 助手 shares the clause. The class is the closed set of
// characters that take 念 as a noun tail, and it is exhaustive on purpose: a
// class that only half covers its own examples is the worse failure here,
// because this branch's mistakes are false FIRES — the expensive direction for
// an advisory — where the turn-side misses below are silence. 念完 is
// deliberately absent: 概念完整 carries the same trap through a different tail
// and no corpus line has ever written 念完.
//
// The English arm takes an OBJECT between the verb and the particle (codex
// review of #189): `read out`/`read it aloud` matched while `read the report
// aloud` — the ordinary way to write it — did not, so the CJK half of this
// vocabulary caught a delivery its English twin let past. The particle is still
// REQUIRED and the object run is bounded to five words: bare `read` must never
// start matching, or 「the assistant read the docs before answering」 becomes a
// delivery claim, which is the fail-toward-silence contract this list keeps.
const ASSISTANT_EVENT_RE = /检索|搜索|告知|(?:未|没有|未能|无法)(?:生成|找到)|捏造|纠正|(?<![概理纪悼思怀信想观悬挂惦执杂念])念(?:给|出)|\bsearched\b|\bretrieved\b|\btold\b|\binformed\b|\bfabricated\b|\binvented\b|\bcorrected\b|\bread\s+(?:it\s+)?(?:out|aloud)\b|\bread\b(?:\s+[\w'’-]+){1,5}\s+(?:aloud|out\s+loud)\b|\bfound\s+no(?:thing|ne)?\b|(?:did not|didn't|could not|couldn't|failed to) (?:generate|produce|find)/i
// Deontic vocabulary only. `never`/`always` are deliberately NOT here (codex
// review of this change): they describe history as often as they state rules
// ("the assistant never found the recording" is exactly the assertion shape
// this gate exists for), and a rule line almost always carries a true modal
// beside them. The accepted miss runs the other way — a single line mixing a
// rule with a fresh event claim ("助手告知用户必须重新提交") is skipped whole;
// silence is the cheaper failure for an advisory, and the section rule still
// owns the intent side.
const NORMATIVE_RE = /必须|应当|应该|严禁|禁止|不得|不要|\bmust\b|\bshould\b|\bdo not\b|\bdon't\b/i
// Rule lines written as a CONTINGENCY are an accepted miss — argued rather
// than chased (#164, and five rounds of codex pre-merge review on #166).
// 「用户若再次提起，应如实告知助手无法设置系统提醒」 prescribes what to say on a
// later turn and reports nothing about this one, so it draws an advisory it
// should not; two of round 11's three false fires are exactly this shape. It
// escapes NORMATIVE_RE because that list carries 应当/应该 and not bare 应,
// and widening the deontic list is measurably worse: on the round-11 graph 应
// sits on 25 of 759 lines, 需 on 52, 须 on 15 — bare modals would silence
// roughly a tenth of every body, the way 未定 gutted its arm before #162.
//
// A conditional-plus-modal silencer was built for this and then removed. Five
// successive definitions of "conditional" each broke on an ordinary reading of
// their own vocabulary: 再次 is a frequency adverb, not a condition (「助手再次
// 检索录音库并告知用户」 is the most ordinary accurate status line there is); 将
// is the disposal preposition at least as often as "will"; 需要的 is a noun
// modifier; 应 sits inside 相应/响应/对应; 若 is a personal name as readily as
// "if". The pattern IS the finding: in Chinese the modality rides a function
// word, and no vocabulary test separates the two without the parse this
// plugin does not have. Every one of those misreadings silenced a real
// report — and recall is the whole point of this gate, since an invented
// episode never announces itself. So the trade is two known false positives
// on rule lines, over a silencer that hid genuine assertions five different
// ways. Restore it only with a parser, never with another word list.
const QUOTED_SPAN_RE = /「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"/g
// A quoted span whose content is identifier-shaped — "W42",
// "recording-17.mp3" — is a NAME, not an utterance (codex review of this
// change): quotes are how prose marks artifacts as often as speech, and an
// incidental quoted filename must not vouch for the sentence around it. ASCII
// word/path characters only, so a quote carrying CJK or a space reads as a
// citation UNLESS the filename shape below catches it.
//
// Shape, not merely charset (codex pre-merge review of #161 round 2): a plain
// word carries no identifier shape, so "Done" and "No" are utterances — the
// quote the rule asks for. An id announces itself with a digit or a path
// character, or by being written in caps (MAP, DCR).
// Separate whole-token validation from the distinguishing character check:
// overlapping wildcard groups otherwise backtrack quadratically on long input.
const IDENTIFIER_CHARS_RE = /^[\w./\\-]+$/
const IDENTIFIER_MARK_RE = /[\d./\\-]/
const UPPER_IDENTIFIER_RE = /^[A-Z][A-Z0-9_-]+$/
// A quoted FILENAME is an artifact name in any script (codex pre-merge
// review of #161): “会议纪要.pdf” and "recording 17.mp3" both fail the ASCII
// identifier shape above and were counted as utterances. No spoken quote ends
// in a file extension, so the trailing `.ext` IS the shape — anchored at the
// end, 1-5 alphanumerics, which a quoted sentence's bare full stop never
// matches.
const FILENAME_QUOTE_RE = /\.[A-Za-z0-9]{1,5}$/
/** How many unsourced assertion lines one write result names (F71, #157). */
const UNSOURCED_ASSERTIONS_CAP = 3

/** Whether a line carries a quoted span that reads as an utterance, not a
 * quoted identifier (F71, #157). */
function carriesCitation(line) {
  for (const match of line.matchAll(QUOTED_SPAN_RE)) {
    const content = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim()
    if (((IDENTIFIER_CHARS_RE.test(content) && IDENTIFIER_MARK_RE.test(content)) || UPPER_IDENTIFIER_RE.test(content)) || FILENAME_QUOTE_RE.test(content)) continue
    return true
  }
  return false
}

/**
 * Whether the quote a line carries VOUCHES for the claim it is offered as
 * evidence for (F71.2, #167). Round 13 found the gate quote-SATISFIABLE: turn 6
 * drew `unsourced_assertions`, and the writer's very next call did exactly what
 * the advisory asked — put the turn's words into the line verbatim in 「」 —
 * while keeping the fabrication:
 *
 *   用户说「先念给我听听你写的内容」，助手念出了《物流×仓储业务对接会议纪要》全文…
 *
 * The quote is real and covers 先念给我听听你写的内容. The event it is offered
 * for — 念出了…全文, and the whole invented content list behind it — is not in
 * that turn or any turn before it. So the advisory converted a bare fabrication
 * into a CITED one, which is strictly worse for a later reader, and the line
 * survived to turn 120. A quote has to cover the claimed EVENT, not merely sit
 * beside it.
 *
 * The operand that was missing is the turn itself: every fidelity gate before
 * this one was a shape heuristic on the write arguments, which is exactly why
 * a quote could only be confirmed to EXIST. #174 established the turn is
 * readable at execute time and F79 already reads it (`promptingTurn`), so the
 * gate can now ask the second half — the claim must name an artifact the TURN
 * also names. 「先念给我听听你写的内容」 names none: no 纪要, no 报告, no 文档,
 * no file. The quote of the request stops standing in for the delivery.
 *
 * Scope is fenced three ways, each so this cannot reach further than its
 * evidence:
 *  - NO TURN, NO CHANGE. Callers without `exec` — the offline gate harness,
 *    direct callers, other runtimes — keep F71's behavior exactly, because a
 *    coverage test with nothing to cover against can only guess. That is why
 *    the vendored corpus fire counts are identical across this change, and why
 *    its acceptance is a replay round and not this file.
 *  - a claim naming NO artifact has no anchor to check and its quote vouches as
 *    before. The actor branch's LINE-scoped reading is otherwise untouched.
 *  - ONE named artifact present in the turn is enough. Requiring all of them
 *    made 「助手已生成周报并写入 report.md」 fire against a turn that says 周报
 *    and no filename — the writer naming the file it wrote is evidence of
 *    nothing invented.
 *
 * Accepted cost, stated rather than hidden: only THIS turn is in hand, so a
 * line quoting an EARLIER turn — 用户说「把W41周报发我」，周报已交付 written
 * two turns later — loses its vouching quote and draws the advisory. Two things
 * bound it. A line the prior body already carried is history and never reaches
 * here at all (`carried`, below), which is the shape a carry-forward normally
 * takes; and what is left is a claim minted fresh this turn about an event no
 * turn in front of the writer states, which is the class this gate exists for
 * even when the particular instance is true. The reworded carry-forward shapes
 * round 13 found (#172, turns 72 and 87) are untouched either way: neither
 * carries a quote, and a line with no citation never enters this function.
 *
 * The other half of #174's design — checking the QUOTED SPAN itself appears in
 * the turn, which catches an invented quote — is deliberately not here. Turn 6
 * PASSES that half (its quote is verbatim), so it discriminates nothing on the
 * evidence in hand, while an exact-substring test on a quote the writer trimmed
 * or ellipsized is a false-positive source with no measured upside.
 */
function quoteVouches(scope, claim, turn) {
  if (!carriesCitation(scope)) return false
  if (!turn) return true
  const named = artifactAnchors(claim)
  if (named.length === 0) return true
  const said = artifactAnchors(turn)
  return named.some((artifact) => said.some((heard) => anchorsMatch(artifact, heard)))
}

/**
 * The artifact terms a text names, lowercased, as anchors the claim side and
 * the turn side can be compared BY THE SAME RULE (F71.2, review). Reading the
 * claim with the noun list and the turn with a bare `includes` was not
 * symmetric, and each asymmetry silenced a claim the turn had nothing to do
 * with — the cited-fabrication shape this change exists to catch:
 *  - `\breport\b` on the claim side matched anywhere inside the turn, so a turn
 *    saying `the reporter called me` vouched for a delivered report;
 *  - the noun list matches a bare extension, so a claim about `summary.md` and
 *    a turn about `todo.md` shared the anchor `.md` and every attachment
 *    vouched for every other. An extension match is widened left over filename
 *    characters, which makes those two different anchors.
 *
 * The head class is Unicode (codex review of #189): `\w` is ASCII, so 总结.md
 * and 计划.md both collapsed to the bare `.md` the widening exists to prevent,
 * and a turn naming one vouched for a claim about the other — the ASCII fix
 * above with the CJK half of the corpus left out of it.
 *
 * Accepted miss, stated: 报告 still matches inside 上报告警 on the TURN side, so
 * a turn about alerting can vouch for a claim about a report. It is the same
 * no-word-boundary trap ARTIFACT_DONE_GAP accepts on the claim side, it needs
 * the segmentation this plugin does not have, and the file's standing verdict
 * on word lists for this problem is to restore one only with a parser. The
 * direction matters: this failure is SILENCE, the cheaper one for an advisory,
 * where a bad lookbehind above would be a false fire.
 */
const FILENAME_HEAD_RE = /[\p{L}\p{N}_/\\-]+$/u
function artifactAnchors(text) {
  return [...text.matchAll(ARTIFACT_SUBJECT_G)].map((hit) => {
    if (!hit[0].startsWith('.')) return hit[0].toLowerCase()
    const head = text.slice(0, hit.index).match(FILENAME_HEAD_RE)
    return `${head?.[0] ?? ''}${hit[0]}`.toLowerCase()
  })
}

/** A filename anchor's extension, and the stem in front of it. */
const ANCHOR_EXT_RE = /\.[a-z0-9]{1,5}$/
/** Whether a stem is ASCII throughout, so the head capture can be trusted to
 * have found its own left edge. */
const ASCII_STEM_RE = /^[\w/\\-]*$/
/** How much of a CJK stem has to agree. Two characters is the length of the
 * words this corpus names files after — 总结, 计划, 周报, 纪要 — and it is what
 * a capture that cannot find its left edge can still compare on. */
const CJK_STEM_MATCH = 2

/**
 * Whether two anchors name the same artifact (codex review of #189). Equality
 * is right for every anchor the noun list produces whole, and for a filename
 * whose stem is ASCII, because `FILENAME_HEAD_RE` stops at the space or
 * punctuation that bounds it.
 *
 * A CJK stem has no such edge — 「助手已生成总结.md」 has nothing between the
 * verb and the filename, so the head capture takes 助手已生成总结 and the same
 * file named in a turn as 发我总结.md captures 发我总结. Under equality those are
 * different files and the advisory fires on a turn that named the artifact,
 * which is a false FIRE — the expensive direction. So two filename anchors with
 * the same extension also match when their stems agree on their last
 * CJK_STEM_MATCH characters, which is exactly the part the capture bounded
 * correctly.
 *
 * Accepted miss, stated: 月度报告.md and 年度报告.md agree on their last two and
 * so vouch for each other. That is SILENCE, the cheaper failure, and the
 * alternative — deciding where a Chinese filename begins — is the segmentation
 * this plugin does not have. ASCII stems keep exact equality precisely so this
 * loosening reaches no further than the capture that needed it.
 */
function anchorsMatch(claimed, heard) {
  if (claimed === heard) return true
  const claimedExt = claimed.match(ANCHOR_EXT_RE)
  const heardExt = heard.match(ANCHOR_EXT_RE)
  if (claimedExt === null || heardExt === null || claimedExt[0] !== heardExt[0]) return false
  const claimedStem = claimed.slice(0, -claimedExt[0].length)
  const heardStem = heard.slice(0, -heardExt[0].length)
  // A bare extension names no file, so it can vouch for nothing but itself —
  // which equality above already settled.
  if (claimedStem.length === 0 || heardStem.length === 0) return false
  if (ASCII_STEM_RE.test(claimedStem) && ASCII_STEM_RE.test(heardStem)) return false
  const shared = Math.min(CJK_STEM_MATCH, claimedStem.length, heardStem.length)
  return claimedStem.slice(-shared) === heardStem.slice(-shared)
}

/** The logical-line split the graph layer recognizes — CR, LF, U+2028,
 * U+2029 — so a normative or quoted clause on one logical line can never
 * vouch for an assertion on the next (F71, #157; graph.js treats all four as
 * line ends). */
const LINE_SPLIT_RE = /\r\n|[\n\r\u2028\u2029]/

/** Clause boundaries inside one logical line (F71, #157): the actor relation
 * survives a clause, never a sentence chain. CJK clause and sentence marks
 * split unconditionally; a latin `.`/`!`/`?` only at a real sentence break
 * (whitespace or end follows), so `报告.pdf` and `1.5x` stay whole. */
const CLAUSE_SPLIT_RE = /[；;，、。！？]+|(?<![.!?])[.!?]+(?=\s|$)/
/** The same split, global, for reading clause BOUNDARIES off a length-matched
 * copy of the line (sonnet review of #167). */
const CLAUSE_SPLIT_G = new RegExp(CLAUSE_SPLIT_RE.source, 'g')
/** What a quote's interior is filled with while boundaries are computed: not a
 * clause mark, not a word character, one code unit wide so the copy stays the
 * same length as the line it came from. */
const QUOTE_FILL = '·'

/**
 * The assistant as grammatical OBJECT (codex pre-merge review of #161):
 * "用户要求助手检索 W42" is a request and "The user told the assistant that
 * the search failed" is a report — legitimate content, not claims about what
 * the assistant did, and flagging them is exactly the nuisance advisory this
 * plugin treats as the worse failure. Mentions directed AT the assistant
 * (a requesting/reporting verb immediately before it) are stripped before the
 * subject test, so the gate requires the assistant as ACTOR. 纠正/corrected
 * are deliberately not directing verbs here: "用户纠正了助手" asserts the
 * was-corrected episode itself, one of #157's target shapes (turn 6).
 */
// The aspect particle and the indefinite article are part of the same shape
// (codex pre-merge review of #161 round 2): 用户告诉了助手… and "The user told
// an assistant…" direct exactly as much as their bare forms.
const ASSISTANT_OBJECT_RE = /(?:要求|请求|命令|指示|告诉|通知|提醒|询问|[请让叫问向对给把])(?:了|过)?\s*助手|\b(?:told|tells?|asked|asks?|informed|informs?|instructed|instructs?|requested|requests?|reminded|reminds?|notified|notifies)\s+(?:the\s+|an?\s+)?assistant\b/gi

/**
 * The new, quoteless assistant-behaviour assertion lines of a body (F71,
 * #157), each rendered through the journal digest so the advisory stays
 * bounded however long the line. Empty for the common body that asserts
 * nothing about the assistant at all.
 *
 * Accepted miss (codex review): a body minting more than the cap's worth of
 * assertion lines names only the first three, and a later repair write that
 * carries the unnamed ones forward verbatim skips them as history. The shape
 * the evidence shows is one narrative line per write, and a cap that stops
 * being read is worse than a tail that waits for the maintain pass.
 *
 * `turn` is the prompting user turn when the caller has one (F71.2, #167) —
 * the second operand every gate before it lacked. It only ever WIDENS the fire
 * set, by refusing a quote that covers nothing the claim asserts; omitted, the
 * function behaves exactly as F71.1 shipped it. See {@link quoteVouches}.
 *
 * Exported only so the offline gate-regression harness can run it over the
 * vendored corpus lines (`fixtures/gate-lines.json`, #164); the plugin itself
 * reaches it through the write path.
 */
export function unsourcedAssertionLines(body, priorBody = '', turn = '') {
  // Doubles as the seen set (codex pre-merge review of #162): a create
  // scans description and body together, so a description restating its
  // own body line would otherwise spend two of the three slots on one
  // finding and hide a later distinct one.
  const carried = new Set(priorBody.split(LINE_SPLIT_RE).map((line) => line.trim()))
  const flagged = []
  for (const raw of body.split(LINE_SPLIT_RE)) {
    const line = raw.trim()
    if (line.length === 0 || carried.has(line)) continue
    // Quoted spans are masked BEFORE the clause split (sonnet review of #167).
    // CLAUSE_SPLIT_RE is quote-blind, so 「报告已交付，已归档」 was cut at its
    // own comma: neither fragment held a complete quote, the citation test saw
    // none, and a directly quoted utterance drew an advisory.
    //
    // The mask decides BOUNDARIES ONLY, and it is length-preserving so the
    // offsets it produces still index the original line (second review round:
    // a placeholder that replaced the content drove the checks themselves, and
    // every shape test downstream reads content — `carriesCitation` excludes a
    // quoted FILENAME from counting as provenance, and the actor branch needs
    // the claim's own words. Both broke on a placeholder). So the interior of
    // each quote is filled with a character that is not a clause mark, the
    // split points come from the filled copy, and every regex below runs on
    // the ORIGINAL substring.
    const masked = line.replace(QUOTED_SPAN_RE, (span) => span[0] + QUOTE_FILL.repeat(span.length - 2) + span[span.length - 1])
    const clauses = []
    let cut = 0
    for (const mark of masked.matchAll(CLAUSE_SPLIT_G)) {
      clauses.push(line.slice(cut, mark.index))
      cut = mark.index + mark[0].length
    }
    clauses.push(line.slice(cut))
    // Actor and event have to share a CLAUSE (codex pre-merge review of #161
    // round 3): line-wide co-occurrence flagged `助手配置未变；用户搜索了日志。`,
    // where the searcher is the user. Clauses carry the actor relation;
    // sentences chain unrelated ones. The quote and rule tests stay
    // LINE-scoped on purpose — a citation anywhere on the line is provenance
    // claimed for it, and silence is the cheaper failure for an advisory.
    // Which branch flagged decides how far a quote can vouch (F71.1, #167).
    // The actor branch keeps LINE scope, as it always has. The artifact branch
    // takes CLAUSE scope, because round 12's fabricated line carried
    // 「"预计完成时间"」 — a quoted FIELD NAME — three clauses away from
    // 「报告已生成并念给用户」, and under line scope that stray quote vouched
    // for a claim it has nothing to do with. A quote earns provenance for the
    // clause it sits in; the actor branch's wider reading stays untouched
    // because narrowing it was never measured.
    let artifactOnly = false
    // The clause that carries the claim, kept so the coverage test reads the
    // CLAIM and not the whole line (F71.2, #167): under line scope the anchors
    // of 用户说「先念给我听听你写的内容」，助手念出了《…纪要》全文 would include
    // whatever the quoted request happens to name, which is the confusion this
    // change exists to end.
    let claimClause = ''
    const asserts = clauses.some((clause) => {
      // Subject means ACTOR: a mention the clause only directs something at
      // is stripped before the test (see ASSISTANT_OBJECT_RE above).
      const actor = clause.replace(ASSISTANT_OBJECT_RE, ' ')
      if (ASSISTANT_SUBJECT_RE.test(actor) && ASSISTANT_EVENT_RE.test(clause)) {
        claimClause = clause
        return true
      }
      // The actor-less sibling (F71.1, #167): the artifact stands in as the
      // subject, and only when the completion FOLLOWS it — see the constants.
      const artifact = clause.search(ARTIFACT_SUBJECT_RE)
      if (artifact < 0 || ARTIFACT_UNKNOWN_RE.test(clause) || OTHER_ACTOR_RE.test(clause)) return false
      // An identifier IS provenance here (F55's stance, reused rather than
      // restated): `W41 周报已交付,artifact_id=300417582904613376` names the
      // artifact it claims to have delivered, and that is checkable outside
      // this turn in a way the bare claim never is. Scoped to this branch —
      // the assistant-subject branch keeps demanding a quoted span, because
      // an id vouches for a THING and not for an episode.
      if (idTokens(clause).length > 0) return false
      if (ARTIFACT_DONE_GOVERNS_RE.test(clause) && DONE_MARKER_RE.test(clause)) {
        if (quoteVouches(clause, clause, turn)) return false
        artifactOnly = true
        claimClause = clause
        return true
      }
      // The NEAREST artifact before the completion, not the first one in the
      // clause (sonnet review of #167). `search()` returns the leftmost hit, so
      // 「附件中的报告已交付」 measured the gap from 附件 and lost a claim sitting
      // flush against its verb — and both distractors that do this (附件, 周报)
      // are themselves entries in the noun list.
      // EVERY completion in the clause, not just the leftmost (second review
      // round): 「无关内容已完成占位后附件已发送」 opens with an unrelated
      // 已完成 and the real pair sits behind it, so anchoring on the first
      // occurrence lost the claim exactly as the leftmost-artifact bug did.
      const ends = [...clause.matchAll(ARTIFACT_SUBJECT_G)].map((hit) => hit.index + hit[0].length)
      if (ends.length === 0) return false
      const claims = [...clause.matchAll(ARTIFACT_DONE_G)].some((done) => {
        const nearest = Math.max(...ends.filter((end) => end <= done.index), -Infinity)
        return done.index - nearest <= ARTIFACT_DONE_GAP
      })
      if (!claims || quoteVouches(clause, clause, turn)) return false
      artifactOnly = true
      claimClause = clause
      return true
    })
    if (!asserts) continue
    if (NORMATIVE_RE.test(line) || (!artifactOnly && quoteVouches(line, claimClause, turn))) continue
    carried.add(line)
    flagged.push(advisoryDigest(line))
    if (flagged.length === UNSOURCED_ASSERTIONS_CAP) break
  }
  return flagged
}

/**
 * The minted-precision gate (F72, #152) — F71's sibling at qualifier
 * granularity. The writer anchors vague user phrasing to specifics the user
 * never gave: 「下周」 stored as 「**2026-09-02 起那周**（下周）」, 「暂不投
 * 广告」 stored as 「暂时不投，无时间表」 (run 20260826-113709, nodes
 * …AH5Z54 / …F0BMTR). The week inference happened to be right; the graph
 * still asserts precision as the user's own fact, and #157 showed the severe
 * end of the same mechanism.
 *
 * Same blindness as F71, stated honestly: the plugin never sees the turn, so
 * it cannot know what the user actually said — a genuinely precise source
 * draws this advisory too, and the render offers that writer the quote as
 * the out. What IS checkable is the tell the evidence shows: the vague
 * phrase SURVIVES in the line beside the precision that resolved it. Two
 * arms, both from the observed shapes and nothing wider:
 *
 *  - a vague relative-week phrase (下周/上周/本周/那周, next/last/this/that
 *    week) sharing a CLAUSE with a resolved ISO date — a resolution fuses
 *    with its phrase (「2026-09-02 起那周」), while a date and a vague phrase
 *    in different clauses are usually different facts (「会议定于
 *    2026-09-01；下周再讨论」), which clause scope keeps silent; colons bound
 *    this arm too, so a dated entry stamp (「更新于 2026-08-27：下周复盘」)
 *    stays silent;
 *  - a deferral (暂不/暂时不/暂缓, "for now") sharing a LINE with a hard
 *    no-schedule qualifier (无时间表/未定/no timeline/TBD) — line scope, not
 *    clause, because the observed minted qualifier is APPENDED as its own
 *    clause (「暂时不投，无时间表」) and clause scope would blind the arm to
 *    its own evidence. The cost: a source that genuinely said both halves in
 *    one line ("预算未定，暂不投放") draws the advisory and keeps its out.
 *
 * NOT flagged, deliberately: a bare absolute date — the repo's convention
 *  REQUIRES resolved ISO dates, and a gate nagging every dated line is a
 *  regression, not a feature; a vague phrase alone (the date-absolute bullet
 *  owns it); a line carrying an inference marker (推测/推断/推算, inferred/
 *  assumed, or the calendar rule's own sanctioned anchor form 「…以<date>
 *  为基准」) — that IS the fix; a line carrying an utterance quote
 *  ({@link carriesCitation}) — provenance claimed, F71's contract. Accepted
 *  misses, silence-cheaper: a writer who drops the vague phrase and keeps
 *  only the minted date defeats the gate (nothing transcript-blind can
 *  catch that), and a resolved date written in a non-ISO form (2026年9月2日)
 *  is not recognized — the vocabulary is the observed evidence, and widening
 *  waits for more, like PLACEHOLDER_MARKERS did. Advisory only: the write
 *  always lands.
 */
// (?!期|年): 下周期/上周期 is "next cycle" and 周年 is an anniversary, not a
// week (下周报告 still counts). The cost runs the silence-cheaper way: a
// genuine 下周年会 ("next week's annual meeting") is an accepted miss.
//
// (?<![\d日号]): the ANCHORED form is not a vague phrase (round 11, #164).
// 「<date>那周」 — 2025-08-11那周, 2025年9月22日那周, 9月22那周 — is ordinary
// Chinese for "the week of <date>", where 那周 is the tail of the date's own
// noun phrase and the date came from the user; nothing was resolved, so there
// is no minted half to flag. All 7 of the gate's round-11 fires were this
// shape and all 7 were false. The arm keeps its target because a real
// resolution is not date-adjacent: 「**2026-09-02 起那周**（下周）」 pairs the
// date with 起 and parks the vague half in parentheses, and a bare 下周/本周
// resolved elsewhere on the clause never had a date in front of it.
// Accepted misses, both narrow and silence-cheaper: an identifier ending in a
// digit that abuts a week word with no punctuation (`PRD2本周讲` — real, in
// the round-11 graph, but carrying no date it never fired) and a 日 that ends
// some other word (`节假日下周恢复`) read as date tails too; and the
// space-separated form (`约 2025-10-13 那周`) is NOT excluded — the corpus's
// only instance is an explicit 推断 line the inference marker already
// silences, and widening the lookbehind over whitespace would start eating
// the resolutions this arm exists for.
// Emphasis between the date and the week word is still adjacency
// (`**2025-09-22**那周`), so the lookbehind steps over it. The line itself is
// NOT stripped of `*`/`_` first: a blanket strip rewrites literal text before
// every gate reads it — `T_B_D` became the qualifier `TBD` and minted a false
// fire (codex pre-merge review of #166, final round).
const VAGUE_TIME_RE = /(?<![\d日号][*_]*)[下上本那]周(?!期|年)|\b(?:next|last|this|that)\s+week\b/i
const ABSOLUTE_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/
// 未定 counts only as a standalone qualifier (codex pre-merge review of
// #162): any Han character after it makes a different word — 未定义
// ("undefined"), 未定稿 ("not finalized"), 未定案 — and `方案尚未定稿，暂不
// 发布` fired on the compound. A schedule left open ends the clause: 未定。/
// 未定，/ 未定 followed by anything but Han.
const HARD_QUALIFIER_RE = /无时间表|未定(?![\u4e00-\u9fff])|\bno timeline\b|\bTBD\b/i
const DEFERRAL_RE = /暂不|暂时不|暂缓|\bfor\s+now\b/i
const INFERENCE_MARK_RE = /推测|推断|推算|为基准|\binferr?ed\b|\bassum(?:ed|ing)\b/i

/**
 * The new lines of a body that pair vague source phrasing with minted
 * precision (F72, #152), digest-rendered and capped like the sibling gate.
 * `priorBody` works exactly as in {@link unsourcedAssertionLines}: carried
 * history is never re-flagged, and the export exists for the same fixture
 * harness (#164).
 */
export function mintedPrecisionLines(body, priorBody = '') {
  // Doubles as the seen set (codex pre-merge review of #162): a create
  // scans description and body together, so a description restating its
  // own body line would otherwise spend two of the three slots on one
  // finding and hide a later distinct one.
  const carried = new Set(priorBody.split(LINE_SPLIT_RE).map((line) => line.trim()))
  const flagged = []
  for (const raw of body.split(LINE_SPLIT_RE)) {
    const line = raw.trim()
    if (line.length === 0 || carried.has(line)) continue
    // The date arm additionally splits on colons — a boundary CLAUSE_SPLIT_RE
    // deliberately lacks — because the ledger convention writes dated entry
    // stamps as `更新于 2026-08-27：下周复盘` / `规则（2026-08-26确立）：…`,
    // where the date stamps the ENTRY and resolves nothing. A resolution
    // fuses with its phrase on the same side of any colon (the evidence:
    // `…：银行方将于**2026-09-02 起那周**（下周）给出方案`).
    const minted = line.split(CLAUSE_SPLIT_RE).flatMap((clause) => clause.split(/[:：]/))
      .some((clause) => VAGUE_TIME_RE.test(clause) && ABSOLUTE_DATE_RE.test(clause))
      || (DEFERRAL_RE.test(line) && HARD_QUALIFIER_RE.test(line))
    if (!minted) continue
    if (INFERENCE_MARK_RE.test(line) || carriesCitation(line)) continue
    carried.add(line)
    flagged.push(advisoryDigest(line))
    if (flagged.length === UNSOURCED_ASSERTIONS_CAP) break
  }
  return flagged
}

/**
 * The labeled-figure contradiction gate (F76, #173) — the write path's first
 * REJECTION, where every sibling above is an advisory. Round 13's turn 87 is
 * why: a node carried a synthetic 「前10大持仓占 37.42%」, a later write
 * attached a fabricated report saying 「前十大持仓约62%」 and rewrote the
 * body to match, and at turn 120 the real figure was GONE from the graph —
 * the one measured case of fiction not just added beside a fact but
 * DISPLACING it, which nothing downstream can detect. Advisories are proven
 * not to stop this class (#163: ignored 29/29 in round 11; #167: satisfied
 * in letter in round 12), and unlike every other fidelity check, both
 * operands are local to the write: the prior body the F62 machinery already
 * loads, and the text this call carries. So it rejects at the tool boundary,
 * with both values named — the same shape of check as F55's dropped_ids,
 * over a different token class.
 *
 * A rejection's false positive blocks a legitimate write, which is far worse
 * than a noisy advisory, and this corpus revises labeled figures constantly
 * (300kW→160kW, TPS 6/峰值8, ~860万美元 re-estimates, headcount 124).
 * Everything below is therefore biased toward under-firing, and measured
 * over all four replay runs (480 turns) before shipping, per the standing
 * no-gate-change-on-unit-tests-alone rule:
 *
 *  - a figure is a number with a UNIT from the small observed set (%, pp,
 *    bp, 万/亿 scales, kW, an x-multiple). A bare count (headcount 124,
 *    TPS 6) never extracts — unitless digits are dates, versions, ids and
 *    list ordinals, where the noise lives;
 *  - its label is the contiguous run of Han/latin/digit characters
 *    immediately before the value, after stripping junction qualifiers
 *    (约/占/为/是/的, colons, markdown emphasis, table pipes). Labels match
 *    EXACTLY, never by proximity or token overlap — 「半年涨幅」 does not
 *    match 「近半年涨幅」, so SAMPLE's own 50% never collides with the fund's
 *    line. The one normalization applied is Chinese↔Arabic numerals
 *    (前十大 ↔ 前10大, the exact bridge turn 87 needs), and only where the
 *    numeral parses confidently; anything wider — 百/千 forms, mixed runs —
 *    is left as written, so a label that cannot be confidently normalized
 *    can only match its verbatim twin and never mints a fire;
 *  - label AND unit must both match before values are compared, and equality
 *    is rounding-tolerant at the coarser side's precision (37.42% restated
 *    as 37% is the same figure; 37.42% vs 62% is not);
 *  - a prior label carrying two distinct values is ambiguous and never
 *    fires; a figure the new text merely DROPS never fires (that is
 *    dropped_body's beat, and a dropped line is recoverable from history
 *    where an overwritten one is not).
 *
 * The escape is explicit rather than a phrasing trick, and it is the form an
 * honest correction takes anyway (F51/#51's outcome back-reference): NAME
 * THE OLD VALUE. Any write whose new text mentions the stored number —
 * 「37.42% → 62%」, 「原37.42%，更正为62%」 — passes, because a writer who
 * names the figure it is replacing demonstrably looked at it, which is
 * exactly what turn 87's writer never did.
 *
 * The pre-merge review round (opus, #173) found the four ways the first cut
 * could still reject an honest write, and each is closed by a narrower
 * firing condition rather than a smarter parse:
 *  - the arrow form the rejection itself prescribes (「37.42% → 62%」) used
 *    to leave the OLD value as the label's only extracted figure, so the
 *    node's own correction became a baseline that rejected the next honest
 *    restatement of 62%. An arrow now chains: a value whose only left
 *    context is an arrow inherits the previous figure's label, the
 *    corrected label carries two values, and two values is ambiguity — no
 *    baseline, no fire;
 *  - a label is a truncated suffix (「DCQ：月租约 12万」 and 「DCR：月租约
 *    8万」 both walk back to 月租), so label equality alone matches across
 *    subjects. A fire now also requires the CLAUSE-PREFIX context of both
 *    values to match (junction chars removed, same numeral normalization) —
 *    「dcq月租」 vs 「dcr月租」 differ where the synthetic 「前10大持仓」 sides
 *    still meet — and the name floor is three chars, which retires the bare
 *    two-char predicates (月租/投入/均值) entirely. Accepted residual, on
 *    record: a 3+-char predicate whose subject sits across a clause comma
 *    (「一期，年化成本12万」 vs 「二期，年化成本8万」) can still collide,
 *    and the arrow escape is the writer's recourse;
 *  - a range's lower bound glued into the label (「规模300-」 out of
 *    「规模300-400万」) made an upper-bound revision fire with a garbage
 *    label; a label ending in a digit, dot or dash is now no name at all;
 *  - the ambiguity rule ran on the stored side only, so a write breaking one
 *    stale figure into a per-period pair (毛利率 40%（去年）/45%（今年）)
 *    fired on an arbitrary member. The claim side now requires exactly one
 *    distinct value under the key before anything fires.
 *
 * The second review round (sonnet, #173) executed the function directly and
 * found three more, each fixed here:
 *  - the one-line comparative 「40%（去年）/45%（今年）」 extracted only its
 *    first value (a close-bracket is neither junction nor label char), so
 *    the pair read as a single-value baseline and the ambiguity rule never
 *    engaged — the slash now chains like the arrow does, with an optional
 *    bracketed annotation between;
 *  - the correction escape tested the bare digits against the WHOLE write,
 *    so a stray 「净利润37.42万元」 — different metric, different unit —
 *    laundered a real 前10大持仓 contradiction, and a small stored value
 *    (5%) was escapable by almost any text. The escape is now scoped: the
 *    stored number, with its own unit, on a line that also carries the
 *    label;
 *  - full-width digits (４４．９２％) extracted nothing, and an empty stored
 *    side turned the gate off wholesale for that write; both scans now fold
 *    full-width digit forms to ASCII first.
 * Kept loose, deliberately: claim-side ambiguity still forgives even when
 * neither value equals the stored one. Tightening it would close a gaming
 * route (naming the label twice at two wrong values) but reintroduce the
 * per-period-split rejection the first round fixed — and a blocked honest
 * write is the failure that gets a rejecting gate reverted. The gaming
 * route's own error message teaches the arrow form, which names the true
 * old value, so an evader following instructions lands on the honest shape.
 */
const CONTRADICTED_FIGURES_CAP = 3
// The unit set is the observed corpus vocabulary, nothing wider: percent
// (both widths), percentage points, basis points, the 万/亿 money scales, kW,
// and the PE-style x-multiple. Letter units require a non-alphanumeric
// successor so `0x1F`, `4x4` and ordinary words never match; the leading
// guard keeps a decimal's tail and a range's second half (`300-400万`, whose
// dash would otherwise read as a minus sign) from matching on their own.
const FIGURE_VALUE_RE = /(?<![\d.])([+-]?\d+(?:\.\d+)?)\s?(%|％|万亿|万|亿|(?:[pP]{2}|[bB][pP][sS]?|[kK][wW]|[xX])(?![0-9A-Za-z]))/g
// What may sit between a label and its value: qualifiers (约/占/为/是/的),
// comparison and range marks, colons, markdown emphasis, table pipes, and
// opening quotes/brackets. Clause punctuation (，、；) is deliberately NOT
// here — stripping it would hand a value the PREVIOUS clause's tail as its
// label — and no directional verb (升/降/涨/跌) is either, because collapsing
// 「成本升」 and 「成本降」 into one label would compare two opposite facts.
const FIGURE_JUNCTION = ' \t\u3000\u00a0约占为是的:：（(［[【「"\'“”*_`|~～≈<>＜＞='
// A label character: Han, latin, digit, or a connector that appears inside
// real labels (S&P, Q1, 前10大). Anything else ends the run, so a value whose
// left neighbour is an arrow or another figure gets no label of its own.
const FIGURE_LABEL_CHAR_RE = /[\u4e00-\u9fffA-Za-z0-9&._/-]/
// An arrow between two figures chains them under one label (opus pre-merge
// review of #173): 「37.42% → 62%」 is the correction form the rejection
// message itself prescribes, and without chaining the old value would be the
// label's ONLY extracted figure — the node's own correction would become a
// baseline that rejects the next honest restatement of the new value.
// A slash chains too, with one optional bracketed annotation before it
// (round 2, sonnet review of #173): the comparative pair 「毛利率 40%
// （去年）/45%（今年）」 lost its second value — a close-bracket is neither
// junction nor label char — so the pair read as a single-value baseline and
// the ambiguity rule never engaged. Anything else in the gap (another word,
// another subject) still breaks the chain.
const FIGURE_CHAIN_RE = /^[ \t\u3000*_`]*(?:→|⇒|->|=>|(?:（[^（）]*）|\([^()]*\))?[/／])[ \t\u3000*_`]*$/
// Where a clause's context begins, for the wide-context guard: clause
// punctuation, table pipes and brackets. The colon is deliberately NOT a
// break — 「DCQ：月租」 keeps its subject, which is the point of the guard.
const FIGURE_CLAUSE_BREAKS = '，、。；！？,;|｜()（）[]［］【】{}「」『』'
const HAN_FIGURE_DIGITS = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }

/** One run of Chinese numerals rendered as Arabic digits, or undefined when
 * the run is not confidently parseable (F76, #173): a single 十-form up to
 * 99, or one lone numeral (前三大 → 前3大). 百/千-forms bail, and so does any
 * positional multi-digit run (opus pre-merge review of #173: 三四/一两/两三
 * are vague quantifiers — "three or four" — and expanding 三四 to 34 minted
 * labels the writer never wrote). Bailing leaves the run as written, so an
 * unconfident label can still match its verbatim twin but never a minted one. */
function hanFigureRun(run) {
  const tens = run.indexOf('十')
  if (tens !== run.lastIndexOf('十')) return undefined
  if (tens < 0) return run.length === 1 ? String(HAN_FIGURE_DIGITS[run]) : undefined
  const head = run.slice(0, tens)
  const tail = run.slice(tens + 1)
  if (head.length > 1 || tail.length > 1) return undefined
  return String((head === '' ? 1 : HAN_FIGURE_DIGITS[head]) * 10 + (tail === '' ? 0 : HAN_FIGURE_DIGITS[tail]))
}

/** Whether two figures are the same number restated (F76, #173): equal, or
 * within half a step at the coarser side's precision — 37.42% revised to 37%
 * is a rounding, 37.42% vs 62% is not. Stated as a distance rather than a
 * pair of Math.round calls (opus pre-merge review of #173): 8.165 * 100 is
 * 816.4999… in floats, so round-and-compare rejected 8.17%, the CORRECT
 * 2-dp rounding of a stored 8.165%. The epsilon absorbs exactly that. */
function figureEqual(a, b) {
  if (a.value === b.value) return true
  const scale = 10 ** Math.min((a.digits.split('.')[1] ?? '').length, (b.digits.split('.')[1] ?? '').length)
  return Math.abs(a.value - b.value) * scale <= 0.5 + 1e-9
}

/** Lowercasing plus the one numeral normalization, shared by the narrow
 * label and the wide clause context (F76, #173). */
const normalizeFigureName = (text) => text.toLowerCase()
  .replace(/[〇零一二两三四五六七八九十]+/g, (run) => hanFigureRun(run) ?? run)

// Full-width digits are figures too (round 2, sonnet review of #173): a
// prior body written 「４４．９２％」 extracted NOTHING, and an empty stored
// side turns the whole gate off for that write. Everything both scans read
// is folded to ASCII first; the fold touches only the full-width forms of
// what the value regex reads — digits, the decimal point, a sign — never
// prose, so offsets shift for no other character class.
const FULLWIDTH_FIGURE_RE = /[０-９．＋－]/g
const asciiFigureDigits = (text) => text.replace(FULLWIDTH_FIGURE_RE,
  (char) => char === '．' ? '.' : char === '＋' ? '+' : char === '－' ? '-' : String.fromCharCode(char.charCodeAt(0) - 0xfee0))

/** The (label, figure) pairs of a text (F76, #173), keyed by normalized
 * label + unit. Values under one key are deduped through {@link figureEqual},
 * so a key holding two entries holds two genuinely different numbers. Each
 * figure also carries its `wide` clause context for the cross-subject guard
 * in {@link contradictedFigures}. */
function labeledFigures(text) {
  const figures = new Map()
  for (const line of asciiFigureDigits(text).split(LINE_SPLIT_RE)) {
    // The previous figure on this line, for arrow chaining.
    let prev
    for (const match of line.matchAll(FIGURE_VALUE_RE)) {
      const pre = line.slice(0, match.index)
      let end = pre.length
      while (end > 0 && FIGURE_JUNCTION.includes(pre[end - 1])) end -= 1
      let start = end
      while (start > 0 && FIGURE_LABEL_CHAR_RE.test(pre[start - 1])) start -= 1
      let label = normalizeFigureName(pre.slice(start, end))
      let wide
      // A label must still be a NAME once normalized: three chars long with
      // at least one Han char or two adjacent latin letters, and not ending
      // in a digit, dot or dash. The floor retires the bare two-char
      // predicates whose subject routinely truncates away (月租/投入/均值);
      // the suffix guard keeps a range's lower bound (「规模300-」 out of
      // 「规模300-400万」) from posing as a name (both opus pre-merge review
      // of #173). No label means no fire — silence is the cheap failure on a
      // write path.
      if (label.length >= 3 && (/[\u4e00-\u9fff]/.test(label) || /[a-z]{2}/.test(label)) && !/[\d.-]$/.test(label)) {
        // The wide context: everything from the last clause break to the
        // value, junction chars dropped, bullets trimmed, same
        // normalization. Never empty when a label exists — clause breaks are
        // not label chars, so the wide always contains the narrow run.
        let clause = 0
        for (let i = pre.length - 1; i >= 0; i -= 1) {
          if (FIGURE_CLAUSE_BREAKS.includes(pre[i])) { clause = i + 1; break }
        }
        wide = normalizeFigureName([...pre.slice(clause)]
          .filter((char) => !FIGURE_JUNCTION.includes(char)).join('')
          .replace(/^[-#>+·]+/, ''))
      } else if (prev !== undefined && FIGURE_CHAIN_RE.test(line.slice(prev.end, match.index))) {
        // A labelless value whose whole left context is an arrow belongs to
        // the previous figure's label: 「前十大持仓 37.42% → 62%」 stores BOTH
        // under 前十大持仓, and two values is ambiguity — the corrected node
        // never becomes a baseline for its own superseded figure.
        ({ label, wide } = prev)
      } else {
        prev = undefined
        continue
      }
      const unit = (match[2] === '％' ? '%' : match[2]).toLowerCase().replace(/^bps$/, 'bp')
      const figure = { value: Number(match[1]), digits: match[1].replace(/^[+-]/, ''), display: match[1] + unit, wide }
      const key = `${label} ${unit}`
      const known = figures.get(key)
      if (known === undefined) figures.set(key, [figure])
      else if (!known.some((seen) => figureEqual(seen, figure))) known.push(figure)
      prev = { end: match.index + match[0].length, label, wide }
    }
  }
  return figures
}

/**
 * The contradictions between the figures a prior body carries and what a
 * write's new text claims (F76, #173): pairs whose label and unit match
 * exactly and whose values differ past rounding, minus every escape the
 * block comment above names. Exported for the offline gate-regression
 * harness (#164) beside the two advisory gates; the plugin itself reaches it
 * through the update path, where it REJECTS instead of advising.
 */
export function contradictedFigures(priorBody, newText) {
  const stored = labeledFigures(priorBody)
  if (stored.size === 0) return []
  const claimed = labeledFigures(newText)
  const fires = []
  const claims = asciiFigureDigits(newText).split(LINE_SPLIT_RE)
  for (const [key, priorFigures] of stored) {
    // Two distinct stored values under one label is ambiguity, not a baseline.
    if (priorFigures.length !== 1) continue
    const [label, unit] = key.split(' ')
    const [was] = priorFigures
    const now = claimed.get(key)
    if (now === undefined || now.some((figure) => figureEqual(figure, was))) continue
    // Ambiguity forgives the claim side exactly as it forgives the stored
    // side (opus pre-merge review of #173): a write breaking one stale figure
    // into a per-period pair (毛利率 40%（去年）/45%（今年）) asserts no
    // single replacement, so there is nothing to name against the baseline.
    // Kept even for a pair where NEITHER value matches the stored one (round
    // 2 decision): tightening would close a gaming route — the label named
    // twice at two wrong values — but reject the honest per-period breakdown
    // of a stale figure, and a blocked honest write is the failure that gets
    // a rejecting gate reverted.
    // And the clause contexts must meet: a label is a truncated suffix, so
    // 「DCQ：月租」 and 「DCR：月租」 share a key while their wide contexts
    // tell them apart — label equality alone matched across subjects.
    if (now.length !== 1 || now[0].wide !== was.wide) continue
    // The explicit-correction escape, scoped to the figure it forgives
    // (round 2, sonnet review of #173): the stored number WITH ITS OWN UNIT,
    // on a line that also carries the label. The first cut tested the bare
    // digits against the whole write, so a stray 「净利润37.42万元」 —
    // different metric, different unit — laundered a real 前10大持仓
    // contradiction, and a small stored value (5%) was escapable by almost
    // any text at all.
    const named = new RegExp(`(?<![\\d.])${was.digits.replace('.', '\\.')}\\s?${unit === '%' ? '[%％]' : unit}`, 'i')
    if (claims.some((line) => {
      const canon = normalizeFigureName(line)
      return canon.includes(label) && named.test(canon)
    })) continue
    fires.push({ label, prior: was.display, next: now[0].display })
    if (fires.length === CONTRADICTED_FIGURES_CAP) break
  }
  return fires
}

/**
 * The least payload size measured for traceability (F88, #157), in UTF-8
 * BYTES — the unit the rest of the attachment path already speaks
 * ({@link ATTACH_MAX_BYTES}, every reported `bytes`) and the one that does not
 * hand a dense script a free pass: 200 CHARACTERS of Chinese is ~570 bytes, a
 * complete invented minutes card (opus pre-merge review). Below this a payload
 * is left alone, because one shared phrase swings the ratio by tens of points;
 * the corpus's fabricated payloads run 681-3,992 chars, well clear of it.
 */
const ATTACH_TRACE_MIN_BYTES = 600

/**
 * And the least number of distinct tokens (F88, #157). A payload whose tokens
 * are a handful of column headers - an invoice table, a numeric report, a date
 * roster - has a denominator too small to mean anything: the same review
 * measured both halves of that, a legitimate CSV refused at 0.0% and an
 * invented numeric table vouched for at 1.0 because it tokenized to nothing at
 * all. Under this floor the payload is exempt, which turns the "no tokens"
 * cliff into a rule with one shape.
 */
const ATTACH_TRACE_MIN_TOKENS = 8

/**
 * After a refusal, the most a write may ADD to that node for the rest of the
 * turn (F88.1, #157), in characters. The section text already names the
 * correct no-change write-back — one appended `状态未变（turn N 无新信息）` line —
 * and that is ~25 characters; a narrative restating the refused payload is
 * not. A synthetic retry can grow the body by restating the refused payload,
 * which is the laundering this bound exists to stop.
 *
 * A bound on the DELTA, never on the total (F88.4, #219 Finding 6). As
 * shipped, F88.1 tested `body.trim().length` — and `body` replaces the whole
 * body, so on any node past 200 chars the one write that could pass was one
 * that deleted the body down to the line. The "~25 characters" above was only
 * ever true of the appended line, never of the body it was appended to.
 * A synthetic handoff demonstrates the inversion: a long body is refused,
 * while a short replacement holding only the 状态未变 line is accepted.
 * Repeated replacements then destroy the history, and a legitimate long
 * correction is refused. The guard rewarded destruction and refused appending.
 */
const REFUSAL_FOLLOWUP_MAX_CHARS = 200

/**
 * The node types an `append` may extend without this Session having read the
 * node or holding its current hash (F89, #219; ADR-0014). Both gates protect
 * a REPLACE — the read so the writer knows what it would destroy, the hash so
 * a concurrent write is not clobbered — and an append destroys nothing and
 * clobbers nothing, so the hash check actively fails an operation that cannot
 * conflict. Scoped to work-state and journal updates; every other type keeps
 * both gates, so a synthetic `decision` append takes the full route —
 * right, since a decision changing is exactly the supersede case. Its own
 * list rather than a wider WORK_STATE_TYPES: that one drives the open-work
 * surfaces and the F61 sweep, where `journal` does not belong.
 */
const APPEND_EXEMPT_TYPES = ['handoff', 'thread', 'journal']

/**
 * The share of an appended text the body already carries past which the
 * write result says so (F89, #219). Shared dates and topic vocabulary are
 * normal overlap; a synthetic repeated tail demonstrates near-total overlap.
 * Advisory, never a refusal: the plugin holds the body, so the check runs
 * where the data is (F88's precedent), without requiring another read.
 */
const APPEND_RESTATED_COVERAGE = 0.70

/**
 * The sanctioned no-change line, exempt from that check: the section text
 * mandates it on every turn that resolves nothing, so a ledger's second one
 * scores 1.0 against its first by construction.
 */
const NO_CHANGE_LINE_RE = /^状态未变（[^）]*）$/

/**
 * How many recent messages the traceability window reads (F88, #157). Twelve
 * covers the shape the review named — a long assistant answer, a short "save
 * that", and the couple of exchanges that set it up — without reaching back so
 * far that an unrelated earlier topic vouches for a payload. A replay turn is
 * a whole session, so there the window is the turn itself and the corpus
 * numbers carry over unchanged.
 */
const TRACE_WINDOW_MESSAGES = 12

/**
 * A word a coverage comparison counts (F88, #157): a letter run of three or
 * more, in any script. Unicode-wide on purpose - an ASCII-only class made the
 * check a silent no-op for Cyrillic, Arabic, Hebrew, Greek and Thai payloads,
 * and truncated accented Latin (`café` -> `caf`) on both sides.
 */
const TRACE_WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}']{2,}/gu

/**
 * The lead character of a traceability bigram (F88, #157): the scripts written
 * without spaces between words, where the character pair is the smallest unit
 * that carries meaning. Han - via the script property, so the extensions and
 * the compatibility block a hand-written `\u4e00-\u9fff` range misses are
 * included - plus kana, Hangul and Thai. Hangul is spaced in modern Korean and
 * so is also read by {@link TRACE_WORD_RE}; the bigram costs nothing and holds
 * for the unspaced older style.
 */
const TRACE_BIGRAM_LEAD_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

/**
 * The scripts a WORD token must not start in (F88, #157): the four with no
 * spaces at all, where {@link TRACE_WORD_RE} would otherwise take a whole
 * unbroken run as one token — a token no paraphrase can ever match, which
 * docks a Chinese payload's score for restating its source exactly. Hangul is
 * absent on purpose: modern Korean is spaced, so its words are real words.
 */
const TRACE_WORDLESS_LEAD_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

/**
 * How much of an attachment's content the writer's recent conversation
 * actually carries (F88, #157): the share of the content's own tokens - words
 * of three or more letters, plus character bigrams for the scripts written
 * without word boundaries - that also appear in `turnText`. In [0,1], and 1
 * for content with no tokens at all, so an empty or symbol-only payload is
 * never read as untraceable.
 *
 * Synthetic replay fixtures contrast invented meeting minutes and reports
 * written on turns whose whole input is a two-line stall with grounded
 * attachments and paraphrased summaries. A fabrication has nothing to borrow from the
 * conversation, and that is what separates it - not its length, its shape, or
 * the claims it makes about the assistant, which is where every earlier gate
 * for this class ran out (F71/F71.1/F71.2).
 *
 * Deliberately word-and-bigram overlap, not a similarity score: a threshold on
 * this has one meaning ("this fraction of the payload is in the
 * conversation"), and both sides are cheap sets. Non-string arguments score 1,
 * the same fail-toward-silence posture the call site takes for a missing turn -
 * a corpus harness with an empty field must not manufacture a refusal.
 * Exported so the threshold can be re-measured over a replay corpus without a
 * graph.
 *
 * Known residual (opus pre-merge review, accepted): coverage is recall over a
 * union, so a payload that quotes the conversation verbatim and then continues
 * into invented material lifts itself over the floor - measured at 60% for a
 * fabrication padded with its own turn. Block-scoring the content would close
 * that and is deliberately not in this change: the floor is a precondition
 * against whole-cloth invention, not a proof of every line.
 */
export function turnCoverage(content, turnText) {
  if (typeof content !== 'string' || typeof turnText !== 'string') return 1
  const wanted = traceTokens(content)
  if (wanted.size < ATTACH_TRACE_MIN_TOKENS) return 1
  const carried = traceTokens(turnText)
  let found = 0
  for (const token of wanted) if (carried.has(token)) found += 1
  return found / wanted.size
}

/**
 * The token set {@link turnCoverage} scores over. Its own function so the
 * F89 restatement check (#219) can read the COUNT: turnCoverage vouches 1.0
 * for a text under ATTACH_TRACE_MIN_TOKENS, which is the right answer for a
 * gate and the wrong one for an advisory that would call a three-word append
 * a total restatement.
 */
function traceTokens(text) {
  const set = new Set()
  for (const word of text.toLowerCase().match(TRACE_WORD_RE) ?? []) {
    if (!TRACE_WORDLESS_LEAD_RE.test(word)) set.add(word)
  }
  // Whitespace is stripped for the bigrams and only for them: Chinese has no
  // word boundary, so the pair is the smallest unit that carries meaning -
  // while stripping it BEFORE taking words would glue a whole English turn
  // into one token and score every English payload at zero. Iterated by code
  // POINT, so an astral character is one unit rather than two halves.
  const chars = [...text.replace(/\s+/g, '')]
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (TRACE_BIGRAM_LEAD_RE.test(chars[i])) set.add(chars[i] + chars[i + 1])
  }
  return set
}

/**
 * The merge-append synthesis check (F72, #152): the lines of the absorbed
 * block that the kept body already states. memory_merge appends A's whole
 * body under the "Merged from" divider, so a rule two duplicate nodes each
 * carried ends up stated twice in one body — dup2's survivor …X2RJ5X holds
 * the 法务审核 rule as two near-identical paragraphs. Near-identical, not
 * byte-identical (任何对外报价… vs **所有对外报价…**), so this is scored with
 * the F51/F52 unit machinery ({@link descriptionUnits}/{@link coveredUnits})
 * rather than exact-line matching, which would be silent on the very
 * evidence: an absorbed line at least {@link LOSSY_MIN_UNITS} units big whose
 * units the kept body covers past MERGE_RESTATED_COVERAGE is a restatement.
 *
 * The threshold is high on purpose — this feeds a rewrite nudge, and merged
 * nodes share their topic's vocabulary by definition, so at F51's 0.5 every
 * merge would nag. 0.8 is where the evidence line sits comfortably (≈0.87)
 * while a line that adds its own fact in shared vocabulary stays under.
 * Accepted miss: a restatement paraphrased past the coverage bar — silence
 * is the cheaper failure, and the divider plus the archive remain the
 * recovery path either way. Advisory only: merge mechanics are untouched,
 * the append-plus-divider IS the recovery path and stays.
 */
const MERGE_RESTATED_COVERAGE = 0.8

/** Dates and filenames beside the ids {@link idTokens} already finds — the
 * exact-value tokens whose difference makes two similar lines two facts
 * (F72, #152). */
const PRECISION_TOKEN_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|[\w\u4e00-\u9fff-]+\.[A-Za-z0-9]{1,5}\b/g

function precisionTokens(text) {
  return [...idTokens(text), ...(text.match(PRECISION_TOKEN_RE) ?? [])]
}

function restatedLines(absorbedBody, keepBody) {
  // One kept LINE has to state the fact, not the keeper's vocabulary as a
  // whole (codex pre-merge review of #162, round 5): a token union covers
  // "Alpha uses Redis" out of one line saying Alpha uses Postgres and another
  // saying Beta uses Redis — a contradiction scored as a duplicate. Merges are
  // rare and bodies are short, so the per-line pass costs nothing that matters.
  const keptLines = keepBody.split(LINE_SPLIT_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BOOKKEEPING_LINE_RE.test(line))
    .map((line) => ({ units: new Set(hanBigrams(tokenize(line))), precision: new Set(precisionTokens(line)) }))
  if (keptLines.length === 0) return []
  const flagged = []
  for (const raw of absorbedBody.split(LINE_SPLIT_RE)) {
    const line = raw.trim()
    if (line.length === 0 || BOOKKEEPING_LINE_RE.test(line)) continue
    const units = descriptionUnits(line)
    if (units.size < LOSSY_MIN_UNITS) continue
    // A high-precision token the matched line does not carry makes this a
    // DIFFERENT fact however alike the prose reads (codex rounds 4 and 5):
    // two report lines differing only in artifact id, ISO date or attached
    // filename both clear the coverage bar, and collapsing them drops a
    // retrieval key or fuses two schedules — habits 10 and the dates rule,
    // exactly inverted. Bigram coverage cannot see it: each is one opaque
    // token.
    const mine = precisionTokens(line)
    const restated = keptLines.some((kept) => coveredUnits(units, kept.units) >= units.size * MERGE_RESTATED_COVERAGE
      && mine.every((token) => kept.precision.has(token)))
    if (!restated) continue
    flagged.push(advisoryDigest(line))
    if (flagged.length === UNSOURCED_ASSERTIONS_CAP) break
  }
  return flagged
}

/**
 * Words that say nothing about what a memory is about. The link-candidate
 * advisory (F9, #18) fires on the top of a token-overlap scan, and search
 * matches SUBSTRINGS — so "is" inside "This" and "cost" inside "costs" scored
 * as evidence of relatedness. Three housekeeping notes in the round-4 trace
 * each drew a candidate about ClickHouse-vs-Postgres that way (F26, #46).
 * English function words only: a domain word is never a stopword here, because
 * the graph's vocabulary is the user's, not ours. This set feeds the DUPLICATE
 * verdict as well as the link floor, and a duplicate verdict invites a
 * destructive update — so nothing gets added here to quiet link noise. That is
 * what `linkTopics` below is for.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'to', 'was', 'were', 'with', 'would', 'you', 'your',
])
// Deliberately NOT here, though a general English stopword list would carry
// them: `any`, `can`, `this`, `use`, `do`, `must`, `should`, `no`, `not`, `all`,
// `one`, `over`, `under`. Every one is a plausible topic in a developer's
// memory — CAN bus, TypeScript `any`, JS `this`, SQL `USE`, RFC 2119 keywords.
// Suppressing a real candidate is the worse failure: whole-token matching
// against the candidate's own description already removes the junk this
// advisory was producing, and the stopword list is only a second guard.

/** A single Han/Kana/Hangul character is a word; a single latin letter is not. */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Drop the tokens that carry no topic: stopwords and single latin characters. */
function topicTokens(tokens) {
  return new Set(tokens.filter((token) => (token.length > 1 || CJK_RE.test(token)) && !STOPWORDS.has(token)))
}

/** A token with no letter at all — `2026`, `08`, `4417`. */
const LETTERLESS = (token) => !/[a-z]/.test(token) && !CJK_RE.test(token)

/**
 * The framing verbs of the description convention. The section below asks for
 * a decision's why in the description and illustrates it with "Chose Postgres
 * over DynamoDB because …"; the agent copies the illustration, so `chose`
 * opens most decision nodes and says nothing about which decision it is. Two
 * unrelated decisions cleared the relevance floor on that one shared token in
 * QA pass 4 (F44, #72).
 *
 * Kept out on purpose: `note`, `noted`. They are the same kind of framing
 * word, but `note` is also a product name and half of "release notes" — and
 * suppressing a real candidate is the worse failure. Only the three verbs
 * whose noise was actually observed are here.
 */
const FRAMING_VERBS = new Set(['chose', 'picked', 'decided'])

/**
 * Topic tokens for the LINK floor only, stricter than `topicTokens` (F44, #72):
 * also drops letterless tokens and the framing verbs. tokenize() splits an ISO
 * date on the hyphen, and F11 (#20) makes the agent write dated facts as ISO
 * dates — so every dated note carried the current year as a whole token and
 * drew every other note of the same year as "related". Requiring one letter
 * kills `2026`, `08` and `4417` in one predicate while keeping `s3`, `p95`,
 * `x86`.
 *
 * Not shared with the duplicate verdict, deliberately: that rule asks whether a
 * candidate carries HALF the new description's tokens, so every token removed
 * shrinks its denominator and makes a destructive "update this instead" easier
 * to trigger — "Chose Redis because latency" would reduce to {redis, latency}
 * and match a mere "Redis deployment guide" on one word.
 *
 * The accepted cost: two notes about the SAME date no longer relate on the date
 * alone either. Keeping that would mean treating a date-shaped run as one
 * opaque token inside tokenize(), which search shares — and pass 4 produced
 * same-YEAR noise while never needing same-date relatedness.
 */
function linkTopics(tokens) {
  return new Set([...topicTokens(tokens)].filter((token) => !LETTERLESS(token) && !FRAMING_VERBS.has(token)))
}

/**
 * A Han run inside a token, in exactly the range tokenize() keeps (\u4e00-\u9fff =
 * U+4E00–U+9FFF) — kana and Hangul never reach here because tokenize drops
 * them at the split.
 */
const HAN_RUN = /[\u4e00-\u9fff]+/g

/**
 * Expand each token's Han runs into character bigrams for the write-time
 * advisories (F51, #87). tokenize() splits only on characters OUTSIDE
 * [a-z0-9\u4e00-\u9fff], so an unpunctuated Chinese clause — even one glued to latin,
 * like "kyc分为l1" — is a single opaque token. Two paraphrases of the same
 * Chinese fact then share almost no whole tokens, and the duplicate verdict
 * (candidate description carries half the new description's tokens) could
 * never fire: in the dossier replay v2, every observed Chinese duplicate pair
 * (410001's synthetic NOVA/KYC twins, 420002's 2030-04-17 demo meeting pair) was
 * written through a silent guard. Bigrams over Han runs give Chinese text the
 * word-sized units English gets from whitespace, and free the latin/digit
 * anchors (KYC, NOVA, L1) trapped inside mixed tokens; a lone Han character
 * stays itself (CJK_RE already treats one as a word). Non-Han tokens pass
 * through untouched, so English behavior is byte-identical. Local to the
 * advisory path on purpose — tokenize() itself is shared with search, whose
 * substring matching and `unmatched` reporting have their own contracts.
 */
function hanBigrams(tokens) {
  const out = []
  for (const token of tokens) {
    const runs = token.match(HAN_RUN)
    if (runs === null) {
      out.push(token)
      continue
    }
    // Latin/digit remnants survive as their own tokens: "kyc分层" → kyc + 分层.
    for (const rest of token.split(HAN_RUN)) if (rest.length > 0) out.push(rest)
    for (const run of runs) {
      if (run.length === 1) {
        out.push(run)
        continue
      }
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    }
  }
  return out
}

/**
 * A new description's identity, in the units the duplicate verdict counts
 * (F51, #87): distinct latin/digit topic tokens, plus every Han CHARACTER
 * position. Characters, not bigrams, on the counted side — a bigram set
 * double-counts word interiors, so one shared three-character word out of
 * three words (数据库 in "数据库 备份 策略" vs "数据库 迁移 计划") would score
 * 2 of 4 bigrams and flip a mere link candidate into a duplicate verdict.
 * Per-character units keep that at 3 of 7. Latin tokens keep the F26/F44
 * filters (stopwords, single letters dropped; bare numbers deliberately kept
 * in the denominator). A pure-English description reduces exactly to the
 * pre-F51 rule: its distinct topic tokens, half of which must be carried.
 */
function descriptionUnits(description) {
  const tokens = new Set()
  const chars = []
  for (const token of tokenize(description)) {
    const runs = token.match(HAN_RUN)
    for (const rest of runs === null ? [token] : token.split(HAN_RUN)) {
      if (rest.length > 1 && !STOPWORDS.has(rest)) tokens.add(rest)
    }
    for (const run of runs ?? []) for (let i = 0; i < run.length; i++) chars.push([run, i])
  }
  return { tokens, chars, size: tokens.size + chars.length }
}

/**
 * How many of a description's identity units a candidate carries. The
 * candidate arrives as its own `hanBigrams` token set: a latin unit must
 * appear as a whole token (so "kyc" never leaks out of "pikakyc"), and a Han
 * character is covered when the candidate carries either bigram containing it
 * — shared vocabulary counts wherever the paraphrase put it, without
 * requiring the same clause segmentation.
 *
 * Minimum evidence for the Han side (codex review of #98): one shared bigram
 * covers BOTH characters of a two-character word, so a four-character
 * description sharing one generic word — 会议安排 written after 会议纪要 —
 * scored 2 of 4 and cleared the half threshold, and the advisory's "revise
 * THAT node" imperative would invite a destructive rewrite of a genuinely
 * distinct fact. Character coverage therefore counts only when the candidate
 * shares at least TWO distinct pieces of evidence — matched latin tokens plus
 * distinct shared bigrams — so no single word can fire the verdict by itself.
 * Cross-kind on purpose: "TPV定价" vs "TPV定价方案" is real overlap carried
 * half in latin, half in Han. English behavior is untouched (no Han chars to
 * gate). Accepted tradeoff: a description that IS one two-character word
 * (定价 vs 定价) can never trip the guard — that short a description carries
 * almost no identity, and the advisory's cost asymmetry favors silence over
 * inviting a wrong rewrite.
 *
 * `evidence` seeds that gate from outside (F61, #106). The close-out sweep
 * strips letterless units — dates, times, bare numbers — from a pending item
 * before scoring it, because F44 (#72) established they identify nothing; but
 * a date the new content SHARES is still a second independent signal that the
 * two texts are about the same event, which is all this gate asks for. It can
 * never add a covered unit; it can only let real vocabulary through. Zero for
 * every other caller, so the duplicate verdict is untouched.
 */
function coveredUnits({ tokens, chars }, candidate, evidence = 0) {
  let covered = 0
  let latinEvidence = evidence
  for (const token of tokens) {
    if (!candidate.has(token)) continue
    covered++
    latinEvidence++
  }
  const sharedBigrams = new Set()
  let charHits = 0
  for (const [run, i] of chars) {
    let hit = false
    if (run.length === 1) {
      if (candidate.has(run)) {
        hit = true
        sharedBigrams.add(run)
      }
    } else {
      const left = i > 0 ? run.slice(i - 1, i + 1) : undefined
      const right = i < run.length - 1 ? run.slice(i, i + 2) : undefined
      if (left !== undefined && candidate.has(left)) {
        hit = true
        sharedBigrams.add(left)
      }
      if (right !== undefined && candidate.has(right)) {
        hit = true
        sharedBigrams.add(right)
      }
    }
    if (hit) charHits++
  }
  if (latinEvidence + sharedBigrams.size >= 2) covered += charHits
  return covered
}

/**
 * The close-out sweep's bounds (F61, #106).
 *
 * STALE_PENDING_MATCHES: how many work-state nodes one write may name. Two —
 * a resolution that closes items in three separate open ledgers at once is not
 * a shape the replays produced, and an advisory that can grow without bound
 * stops being read.
 *
 * STALE_PENDING_NODES: how many open work-state nodes are scanned — handoffs
 * first, then threads, each newest first. The handoff discipline is one open
 * handoff per thread (QA peak: 4), but `thread` nodes accumulate — they close
 * by retype, which nothing forces — so the sweep needs a ceiling that does not
 * depend on writer hygiene, and handoffs take the budget first so a crowd of
 * recent threads cannot hide one. A ledger worth sweeping is a recent one.
 *
 * STALE_PENDING_LINES: how many lines of one body are examined. A work-state
 * body is a gist by construction (bulk goes to an attachment, F21), so this
 * only stops a pathological body from making the per-write cost unbounded.
 *
 * The matched line is quoted through {@link advisoryDigest} — the same
 * bounded, one-line, surrogate-safe rendering the journal uses. The line is a
 * pointer into a node the advisory is telling the writer to open, not a
 * substitute for reading it.
 *
 * STALE_PENDING_COVERAGE: how much of a pending item's identity the new
 * content must carry. A THIRD, not the half the duplicate verdict asks for:
 * that verdict compares two descriptions of the same shape, while a ledger
 * line carries the item AND its next step ("4/17周报 结果未返回,需重新派发"),
 * so the write that delivers the item names a third of the line and no more.
 * The floor under it is `coveredUnits`' own min-evidence gate, which is what
 * keeps a single shared two-character word from carrying a match by itself.
 *
 * STALE_PENDING_UNIT_FLOOR / STALE_PENDING_MIN_COVERED: a third of a SHORT
 * item is one unit, and one shared word out of three ("- vendor SOC2 report"
 * against a note about a vendor call) is topical adjacency, not delivery. So
 * from three units up, two units must be covered. Below that the item is too
 * small to ask for more — "- Fern会 结果未返回" is `fern` + 会, and the whole
 * latin token is the evidence.
 */
const STALE_PENDING_MATCHES = 2
const STALE_PENDING_NODES = 20
const STALE_PENDING_LINES = 200
const STALE_PENDING_COVERAGE = 3
const STALE_PENDING_UNIT_FLOOR = 3
const STALE_PENDING_MIN_COVERED = 2

/**
 * The pending line of one work-state body that this write's content best
 * looks like the resolution of, with how completely it covers that line's
 * item (F61, #106) — or undefined when the body has no such line.
 *
 * Scoring is the F51 (#87) duplicate machinery unchanged: the line's item is
 * reduced to identity units (latin/digit topic tokens + Han character
 * positions) by `descriptionUnits`, and `coveredUnits` counts how many of them
 * the new content carries, with its min-evidence gate intact — a single shared
 * two-character word can never carry the Han side by itself. Only the
 * threshold differs (STALE_PENDING_COVERAGE), because a ledger line is not a
 * description. The 420002 shape: "- Fern会 结果未返回" minus its status marker
 * is `fern` + 会 — 2 units — and the new node "Fern 内容已存储" carries the
 * whole latin token `fern`, 1 of 2, evidence enough on its own.
 *
 * BEST match, not first: a ledger's items share their project's vocabulary, so
 * "pending: Acme API pagination" and "pending: Acme API auth rollout" both
 * clear the floor on a write about either — and naming the earlier line would
 * send the writer to close the wrong item. Every line is scored (the cap
 * bounds that at STALE_PENDING_LINES) and the highest coverage wins; ties keep
 * the earlier line, which is the older item.
 *
 * A line is a pending item when it carries a marker of its own, or when it is
 * a list line under a marked header (see PENDING_HEADER) — "Pending items:"
 * over three bullets is the same ledger as three marked bullets.
 */
function resolvedPendingLine(body, contentUnits) {
  // Split under the cap, not after it: the bound is on the work this does, and
  // splitting a pathological body first would allocate the array the cap
  // exists to avoid.
  const lines = body.split('\n', STALE_PENDING_LINES)
  // Whether the lines being read sit under a pending HEADER, and so are open
  // items without needing a marker of their own.
  let underHeader = false
  let best
  for (const raw of lines) {
    // A ticked box is a closed item — under a header as much as on its own,
    // where the list shape alone would otherwise vouch for it.
    if (CHECKED_BOX.test(raw)) continue
    const marked = pendingItem(raw)
    if (marked !== undefined && PENDING_HEADER.test(raw)) {
      underHeader = true
      continue
    }
    let item = marked
    if (item === undefined) {
      if (!(underHeader && LIST_LINE.test(raw))) {
        if (raw.trim().length > 0 && !LIST_LINE.test(raw)) underHeader = false
        continue
      }
      item = raw
    }
    const units = descriptionUnits(item)
    // Two kinds of unit are struck from the item before it is scored, and both
    // are struck from the TOTAL as well as from coverage, so a line made
    // mostly of them does not become unmatchable:
    //
    //  - scaffolding ("Pending items:", "Open tasks:") — structure, not an
    //    item, so a bare header reduces to nothing and nothing can resolve it;
    //  - letterless units — dates, times, bare numbers. F44 (#72) established
    //    that they identify nothing: an ISO date splits into three tokens, so
    //    "pending: send payroll report 2026-08-25" and an unrelated note dated
    //    the same day would share three "units" and close the wrong item.
    //
    // Both are dropped from the pending ITEM only; they are ordinary topic
    // words everywhere else in the plugin, and a real item keeps its own
    // vocabulary beside them ("task runner upgrade" still carries runner and
    // upgrade). A shared letterless token survives as EVIDENCE for
    // `coveredUnits`' min-evidence gate — a shared date corroborates without
    // identifying — which is what keeps "- 4/17周报 结果未返回" matchable on
    // 周报 once "4/17" is no longer a unit.
    let size = units.size
    let evidence = 0
    for (const token of [...units.tokens]) {
      const letterless = LETTERLESS(token)
      if (!PENDING_SCAFFOLD.has(token) && !letterless) continue
      if (letterless && contentUnits.has(token)) evidence++
      units.tokens.delete(token)
      size--
    }
    // A line that is nothing but its marker, scaffolding and dates ("- [ ] ok",
    // "其他待办:", "- 2026-08-25 待确认") names no item, so nothing resolves it.
    if (size === 0) continue
    const covered = coveredUnits(units, contentUnits, evidence)
    if (covered === 0 || STALE_PENDING_COVERAGE * covered < size) continue
    if (size >= STALE_PENDING_UNIT_FLOOR && covered < STALE_PENDING_MIN_COVERED) continue
    const score = covered / size
    if (best !== undefined && score <= best.score) continue
    // `advisoryDigest` is exactly the bounded, surrogate-safe, one-line
    // rendering this quote needs (F64 built it for the journal): a body
    // written outside the plugin can carry U+2028 inside a "line", and a
    // quote that breaks the render's own layout is worse than a folded one.
    best = { line: advisoryDigest(raw), score }
    // A line the write covers entirely cannot be beaten, and a ledger's list
    // is not worth scanning past that.
    if (score === 1) break
  }
  return best
}

/**
 * How many dropped identifiers the `dropped_ids` advisory names (F55, #91).
 * The advisory exists to make the loss concrete enough to undo from context;
 * five ids is already more than a body normally carries, and the render is a
 * nudge, not a manifest.
 */
const DROPPED_IDS_CAP = 5

/**
 * The longest run that can still be an identifier (F55, #91).
 *
 * Two jobs. It bounds what the advisory can render — the payload is quoted
 * VERBATIM, and a body carrying an externally written blob (a base64 asset, a
 * hex dump) would otherwise push an unbounded string into the tool result,
 * where DROPPED_IDS_CAP bounds only the count. And it is a correctness filter
 * in its own right: real ids here run to ~40 chars (hex worker ids 8-24,
 * artifact ids 18-19 digits, a ULID exactly 26), so a run past 64 is a payload,
 * not a retrieval key, and F21's move-the-bulk-out nudge is what owns it.
 *
 * Enforced inside the scan pattern rather than by filtering after: an over-long
 * run must not match at all, and the boundary lookarounds make that automatic —
 * no end position inside the run sits at a boundary, and no interior start
 * clears the lookbehind, so the whole run is skipped instead of a 64-char
 * prefix or suffix being harvested out of it.
 */
const ID_TOKEN_MAX_CHARS = 64
const ID_TOKEN_RE = new RegExp(`(?<![0-9A-Za-z])[0-9A-Za-z]{8,${ID_TOKEN_MAX_CHARS}}(?![0-9A-Za-z])`, 'g')

/**
 * A hyphenated UUID, scanned before the plain runs above (F55, #91).
 *
 * The plain scan treats `-` as a boundary, which is right for everything else
 * and wrong for exactly this: a UUID would come apart into its groups, the two
 * 4-char middles would fall under the 8-char floor, and the advisory would
 * render `550e8400, 446655440000` — an instruction the writer cannot act on,
 * which defeats the point of quoting ids verbatim. UUID-shaped recording and
 * file ids are squarely in the domain this feature exists for, so they get
 * their own shape, matched first and masked out so their groups are never
 * re-reported as fragments. A labelled `recording-<uuid>.wav` still resolves,
 * since `-` is a boundary here as everywhere else.
 *
 * The pattern carries no boundary assertions of its own: it masks every
 * UUID-shaped core and the caller decides from the surrounding characters
 * whether to REPORT it (codex review of #118). Masking unconditionally is the
 * point — a core glued to a word (`recording550e8400-…`) is not an id worth
 * naming, but leaving it unmasked would let the plain scan harvest
 * `446655440000` out of its tail and report that fragment instead.
 */
const UUID_RE = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g

/**
 * Lines the framework itself writes into a body — supersede banners (ADR-0009)
 * and the merge divider (F17) — which carry a ULID that is bookkeeping, not
 * provenance (review of #118).
 *
 * They must come out before either side is tokenized, and the reason cuts both
 * ways. A faithful revision KEEPS its banner, so the banner's ULID would always
 * count as a carried-and-kept id and "all dropped" could never be true — the
 * advisory would be permanently disabled on superseded and merged nodes, which
 * are precisely the long-history nodes most likely to hold artifact ids. And a
 * node whose body is only a banner plus prose would fire the advisory naming
 * the plugin's own bookkeeping ULID as the identifier the writer dropped.
 *
 * Matched anywhere in the body rather than only at the top, and that is safe
 * even though a writer could author the same line: this exact format IS the
 * supersede convention (AGENTS.md step 5 has the agent prepend it by hand when
 * driving the graph through `bin/`), so a line wearing it is a supersede
 * pointer whoever typed it — bookkeeping, not the provenance of the fact.
 */
const BOOKKEEPING_LINE_RE = /^(?:Superseded by|Merged into|Merged from) [0-9A-HJKMNP-TV-Z]{26} on \d{4}-\d{2}-\d{2}[.:]$/
/**
 * The third framework-written line: F88.3's unwritten-attachment correction
 * (#157), appended to a body that names a file the traceability gate refused.
 * It is bookkeeping for the same reason the banners are, and it matters most
 * to the F88.4 freeze (#219): the correction lands on the frozen node AFTER
 * the writer's read, so a prior side that kept it would make every honest
 * write-back on that node read as one that dropped stored content.
 */
const UNWRITTEN_ATTACHMENT_LINE_RE = /^（\d{4}-\d{2}-\d{2}：上文提到的附件 .+ 未写入——其内容无法追溯到本轮对话，该次尝试被拒绝。）$/
const withoutBookkeeping = (text) => text.split('\n').filter((line) => !BOOKKEEPING_LINE_RE.test(line.trim()) && !UNWRITTEN_ATTACHMENT_LINE_RE.test(line.trim())).join('\n')

/**
 * Identifier-shaped tokens in a body, in the order they appear (F55, #91).
 *
 * Ids are the highest-precision retrieval keys the graph holds — exact-match
 * tokens that survive paraphrase — and they are exactly what a lossy rewrite
 * drops, because a model rewriting from the gist has no reason to carry an
 * opaque string forward. Replay v3: a pending-retrieval ledger named zero of
 * the six worker ids its source segments carried, and the graph kept 2 of 5+
 * artifact ids the competing dossier kept.
 *
 * Deliberately narrow — this feeds an advisory, so a false positive costs the
 * writer a paragraph of nagging, and the "all dropped" fire condition makes a
 * single spurious token in an id-free body enough to fire it. A UUID (above),
 * then three plain shapes, each delimited by a non-alphanumeric boundary so a
 * hex id glued to a word is not a match:
 *   - a run of 12+ digits — the artifact ids (`300442018876145664`, 18-19
 *     digits). The floor is 12 rather than 9 because the corpus is Chinese
 *     meeting notes: `1200000000` (a budget figure) and `13812345678` (a mobile
 *     number) are prose, and either alone would fire the advisory on a body
 *     holding no real id at all;
 *   - a hex run of 8+ chars mixing digits and hex letters — recording/file ids
 *     (`d5b204fa`, `c7a910eb`). Requiring BOTH is what keeps an 8-digit date
 *     (`20250824`, which is also valid hex) and English that happens to be
 *     spellable in hex (`defaced`, `beefcafe`) out. Accepted false positive: an
 *     8-digit CSS colour with alpha (`#a3b2c1ff`), indistinguishable in shape
 *     from a real file id and vanishingly rare in a memory body;
 *   - the graph's own ULID shape (`ULID_RE`, Crockford base32) — cited when a
 *     body points at another node.
 * All are additionally bounded above by ID_TOKEN_MAX_CHARS.
 *
 * What is deliberately NOT matched: filenames, `PROJ-1234`-style ticket keys,
 * bare `#91` issue references, and short opaque handles like `T29GPY`. None has
 * a shape that separates it from ordinary prose — `#91` alone would fire on
 * every issue mention — and under "all dropped" one false positive in an
 * id-free body emits the whole advisory. The prompt side owns those, as it owns
 * filenames; this scan stays the narrow, high-confidence half of the feature.
 *
 * Callers pass text already stripped of framework bookkeeping lines and already
 * unescaped — see {@link withoutBookkeeping} and `normalizeBody`.
 */
function idTokens(text) {
  const hits = []
  const glued = (char) => char !== undefined && /[0-9A-Za-z]/.test(char)
  // UUIDs first, blanked to spaces rather than removed so every offset below
  // still refers to the same position in the original text. Every core is
  // masked; only a free-standing one is reported.
  const masked = text.replace(UUID_RE, (match, offset) => {
    if (!glued(text[offset - 1]) && !glued(text[offset + match.length])) hits.push([offset, match])
    return ' '.repeat(match.length)
  })
  for (const match of masked.matchAll(ID_TOKEN_RE)) {
    const token = match[0]
    const isId = /^\d{12,}$/.test(token)
      || (/^[0-9a-fA-F]+$/.test(token) && /\d/.test(token) && /[a-fA-F]/.test(token))
      // The graph's own id shape, reused rather than approximated: Crockford
      // base32 excludes I/L/O/U, so a hand-rolled [0-9A-Z]{26} both accepts
      // ids that cannot exist and needs a digit guard the real pattern makes
      // unnecessary (codex review of #118).
      || ULID_RE.test(token)
    if (isId) hits.push([match.index, token])
  }
  // Two passes, one reading order: the advisory quotes ids back in the order
  // the body carried them, so the writer can find them where they were.
  hits.sort((a, b) => a[0] - b[0])
  const found = []
  const seen = new Set()
  for (const [, token] of hits) {
    if (seen.has(token)) continue
    seen.add(token)
    found.push(token)
  }
  return found
}

/**
 * Recover `{filename, content}` from a serialized `attach` that JSON.parse
 * rejected (F78.1, #157/#171).
 *
 * The observed break is a payload whose own `"` characters were never escaped
 * — valid JSON up to the first quoted phrase inside `content`, garbage after.
 * The keys are fixed and `content` always runs to the end, so the two values
 * can be read positionally and the content re-escaped before parsing. Returns
 * `undefined` for anything that is not exactly this shape; the caller then
 * leaves the string alone and the boundary rejects it as before.
 */
function salvageSerializedAttach(raw) {
  const head = /^\s*\{\s*"filename"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"content"\s*:\s*"/.exec(raw)
  if (head === null) return undefined
  const tail = raw.trimEnd()
  if (!tail.endsWith('}')) return undefined
  const close = tail.lastIndexOf('"')
  // Whitespace between the closing quote and the brace is ordinary JSON
  // formatting, not a different shape (terra round 2).
  if (close === -1 || !/^\s*\}$/.test(tail.slice(close + 1))) return undefined
  const body = tail.slice(head[0].length, close)
  // Fail closed on BOTH ambiguities, because a silently wrong attachment is
  // the one outcome this whole gate exists to prevent (terra rounds 1-2):
  //   - a `", "<key>":` sequence may be a third property this recovery would
  //     fold into the payload — `additionalProperties: false` would have
  //     rejected that object had it parsed. The key may be any JSON string,
  //     not just an identifier, so the test is the shape, not the spelling.
  //   - a `\"` may be an escape the serializer got RIGHT, or a literal
  //     backslash before a quote it got wrong; re-parsing decides one way and
  //     is wrong the other, dropping a backslash from embedded JSON or code.
  // Both refusals cost only the one-call path: the string stays a string, the
  // boundary rejects it, and the writer reroutes to write-then-attach, where
  // F88.3 now marks any promise the gate then refuses.
  if (/",\s*"(?:[^"\\]|\\.)*"\s*:/.test(body)) return undefined
  if (body.includes('\\"')) return undefined
  let filename
  try {
    filename = JSON.parse(head[1])
  } catch {
    return undefined
  }
  // Only the quotes the serializer missed are escaped; every other escape the
  // payload carries (\n, \t, \uXXXX) is already correct and must survive.
  const escaped = body.replace(/\\.|"/g, (match) => (match === '"' ? '\\"' : match))
  try {
    const content = JSON.parse(`"${escaped}"`)
    return typeof content === 'string' ? { filename, content } : undefined
  } catch {
    return undefined
  }
}

/**
 * The attachment-filename rule, as a PURE predicate (#253).
 *
 * `graph.js`'s `assertAttachmentName` is the authority and is already
 * string-only — reserved names, dotfiles, path separators, `..`, the empty
 * name — with no graph, filesystem or config read, so it may run inside the
 * trusted preparation. Returning the message instead of throwing lets one rule
 * serve both write routes and both refusal paths.
 *
 * Deliberately ONE small function: the agent-facing filename rule (#255:
 * refusing `observation.txt` and a 200 UTF-8-byte cap) is chained here, so
 * both write routes and both spellings of a `from_path` name get it at once.
 */
function filenameViolation(filename) {
  try {
    assertAttachmentName(filename)
  } catch (error) {
    return error.message
  }
  // #255's stricter WRITE-side rule over the same argument: `observation.txt`
  // (and its case/Unicode aliases), reserved-name aliases, and the 200-byte cap.
  // Reads never pass through here, so legacy names stay openable.
  return agentAttachmentNameViolation(filename)
}

/**
 * Fixed stand-in for `os.homedir()` when deriving a `from_path` attachment name.
 * Only the SHAPE of the expanded path matters for its basename, so the value
 * never has to be real — which is what keeps the derivation pure and lets the
 * trusted preparation run it (no home, clock, config or filesystem read).
 */
const FROM_PATH_NAME_HOME = '/home/agent'

/**
 * The filename a `from_path` attach will actually STORE, derived exactly the
 * way the handler resolves it — PURE (review 2 of #253; #255's helper of the
 * same name).
 *
 * `attachFromPath` names the file `path.basename(srcPath)`, and the handler
 * expands a leading `~` BEFORE that. Deriving the name from the raw argument
 * therefore disagrees with what lands whenever the last segment is `.` or `..`:
 * `~/node.md/.` basenames to `.` raw, but the handler's expanded path basenames
 * to `node.md` (a reserved name), and `~/x/.` lands as `x` rather than `.`.
 * A name rule that judges the wrong string is both a false refusal and a hole.
 *
 * This applies the handler's own SYNTACTIC normalization — the same `~` rules
 * as {@link expandHome} — against a fixed stand-in home, then `basename`. Shared
 * by the preparation and the handler, which passes the result to
 * `attachFromPath`, so the name judged is the name that lands.
 *
 * The stand-in's VALUE shows through in exactly one shape: a source whose last
 * segment resolves to a directory (`~`, `~/x/..`), where the name is the home
 * directory's basename. Preview and handler agree there too, because both read
 * it from this function — and such a source cannot be attached as a file either
 * way (`EISDIR`).
 *
 * @param source - the raw `from_path` argument.
 * @returns the name `attachFromPath` would store, or `source` unchanged when it
 *   is not a usable string (the caller's own non-empty rule owns that).
 */
export function fromPathAttachmentName(source) {
  if (typeof source !== 'string' || source.length === 0) return source
  return path.basename(expandHomePath(source, FROM_PATH_NAME_HOME))
}

/**
 * The message for an id argument that cannot name a node — `""` included, the
 * value that quarantined a live graph on 2026-10-26. Names the field, the
 * value and the field's own remedy, so the retry is not a guess.
 */
function idViolation(field, value, remedy) {
  return `\`${field}\` must be a 26-character node id: ${JSON.stringify(value)} — nothing was written. ${remedy}`
}

/**
 * One violation naming the ids of a list argument that cannot name a node.
 * Capped: a long array of junk ids must not mint a wall of error text, and the
 * retry needs the shape, not every offender.
 */
const MALFORMED_ID_SAMPLE = 3
function idListViolation(field, values) {
  const bad = values.filter((value) => !ULID_RE.test(value))
  if (bad.length === 0) return undefined
  const shown = bad.slice(0, MALFORMED_ID_SAMPLE).map((value) => JSON.stringify(value)).join(', ')
  const more = bad.length > MALFORMED_ID_SAMPLE ? ` and ${bad.length - MALFORMED_ID_SAMPLE} more` : ''
  return `\`${field}\` must contain only 26-character node ids: ${shown}${more} — nothing was written.`
}

/**
 * The `memory_write` argument contradictions and argument SHAPES that are
 * decidable from the arguments ALONE (26102311, #253). Returns violation
 * strings in `validate()`'s shape — empty means the call is coherent.
 *
 * These rules used to live in the handler and threw there. That made a pure
 * shape error indistinguishable, to every receipt, from a handler that had
 * already started and then failed: `executionStarted` could only stay unset.
 * They are pure predicates over the JSON arguments — no graph, filesystem,
 * session, clock or config read, no mutation — so they belong in the trusted
 * preparation (`defineTool`'s `semantic` hook), which runs BEFORE the handler
 * and whose violation list is the wrapper's proof of non-execution.
 *
 * The handler deliberately does not repeat them: the preparation is the one
 * authority, so there is no second copy to drift and no difference in timing
 * between the precheck and `execute` (both run the same pipeline). Rules that
 * need state stay in the handler and stay uncertain when they throw — an
 * unread `supersedes` target, a stale version, an untraceable attachment, a
 * disk failure may all have mutated something before they reject.
 *
 * Rules are checked in the order the handler used to reach them, so the first
 * violation a caller sees is the one it always got:
 *   1. `supersedes` on an update (create-only affordance);
 *   2. `append` contradicting `body`, missing `id`, or carrying a field an
 *      append cannot express (F89, #219);
 *   3. a create with no `description`;
 *   4. the argument SHAPES the storage layer used to police (#253): ids that
 *      cannot name a node, a description that cannot be stored, an attachment
 *      name/content the graph layer would reject. Each of these used to throw
 *      from `assertId`/`createNode`/`updateNode`/`attach` INSIDE the handler,
 *      where no receipt can tell "rejected having written nothing" from
 *      "failed after a write" — which latches the manage fence and quarantines
 *      the graph. Live cost: `id: ""` on 2026-10-26 (task e5136436).
 *
 * `append` is only declared on compositions that opted in, and the schema pass
 * rejects it as an undeclared property elsewhere, so a call that reaches these
 * rules with `append` is always a composition where the route exists.
 *
 * @param args - coerced, schema-valid `memory_write` arguments.
 * @returns violation strings; empty when the shape is admitted.
 */
function writeArgumentViolations(args) {
  const violations = []
  // `supersedes` records a *new* node as an old one's successor, so it is a
  // create-only affordance. Combined with `id` it is a contradiction (you
  // cannot both revise a node and mint its replacement).
  //
  // Name both remedies (#247's secondary issue): task a4dcb8bd sent four
  // identical rejected writes before dropping the field, roughly doubling the
  // cost of a trivial append. A hard rejection is right — the two intents
  // contradict — but one that names only the contradiction makes the retry a
  // guess, and the guess was to resend the same call.
  //
  // Deliberately NO mention of the `typed_links` spelling (#247 review 2). It
  // reads like the third way to do this, and on a deployment without the audited
  // refusal codes an id-update carrying a typed supersede meets the plain "has
  // not been read this session" rejection — which on the zy_a2a line latches the
  // manage fence and quarantines the graph. The message must not steer a model
  // into that path; the two remedies it does name are each a single safe call.
  if (args.supersedes !== undefined && args.id !== undefined) {
    violations.push(`\`supersedes\` cannot be combined with \`id\` — nothing was written. To edit ${args.id} in place, resend without \`supersedes\`. To replace it, drop \`id\` and pass description + body + supersedes. Do not resend unchanged.`)
  }
  // `append` is body-only (F89, #219; ADR-0014), and the restriction IS the
  // route's safety property: a fact CHANGE needs a refreshed description or a
  // supersede (ADR-0009), so an append that can carry neither is structurally
  // incapable of being one.
  if (args.append !== undefined) {
    if (args.body !== undefined) {
      violations.push('`append` and `body` cannot be combined — `append` adds below the stored body, `body` replaces it. Pass one or the other.')
    }
    if (args.id === undefined) {
      violations.push('`append` needs `id` — it extends a node that already exists. To create a node, pass `description` and `body`.')
    }
    const carried = ['description', 'type', 'links', 'typed_links', 'supersedes', 'attach'].filter((field) => args[field] !== undefined)
    if (carried.length > 0) {
      violations.push(`\`append\` cannot carry \`${carried.join('`, `')}\` — an append only adds text below the body. To change what the node says (refresh its description or type, link it, supersede it, attach a file), memory_read it and write the full \`body\` with \`id\`.`)
    }
  }
  // A create needs a description; an append is a different route and is
  // excluded, so a valid append-with-id is never rejected here, and an update
  // (`id` present) needs no description at all.
  if (args.id === undefined && args.append === undefined && args.description === undefined) {
    violations.push('requires `description` when creating a node — pass `description` (one findable line, at most 500 chars; detail goes in `body`) to create, or pass `id` to update an existing one.')
  }
  // ---- Argument SHAPES the storage layer used to police (#253) ------------
  // Nothing below needs disk, session or clock state: a ULID is a string
  // shape, a filename rule is string reasoning, a byte count is the argument's
  // own length, and `descriptionProblem` is pure (graph.js). Each used to
  // throw from `assertId`/`createNode`/`updateNode`/`attach` INSIDE the
  // handler — indistinguishable from a failure that had already written, so
  // the manage fence latched and the graph quarantined. Rejecting here makes
  // the same refusal provable non-execution.
  if (args.description !== undefined) {
    const problem = descriptionProblem(args.description)
    if (problem !== undefined) violations.push(problem)
  }
  if (args.id !== undefined && !ULID_RE.test(args.id)) {
    violations.push(idViolation('id', args.id, 'Omit `id` to create a node, or pass an id copied from memory_read/memory_search.'))
  }
  if (args.supersedes !== undefined && !ULID_RE.test(args.supersedes)) {
    violations.push(idViolation('supersedes', args.supersedes, 'Pass the target id copied from memory_read/memory_search, or omit `supersedes` to create without superseding.'))
  }
  if (args.links !== undefined) {
    const violation = idListViolation('links', args.links)
    if (violation !== undefined) violations.push(violation)
  }
  if (args.typed_links !== undefined) {
    // `typed_links[].type` is a schema enum, so only the target id is left.
    const violation = idListViolation('typed_links[].id', args.typed_links.map((link) => link.id))
    if (violation !== undefined) violations.push(violation)
  }
  // ---- One relationship, one spelling (2026-11-09 incident) ---------------
  // The same target may not be spelled twice: `supersedes` + a link, or a
  // plain link + a typed link, are contradictions the writer used to admit and
  // then half-fulfil. Live incident (history import, 2026-11-09): a create with
  // `supersedes: X`, `links: [X, …]` and `typed_links: [{id: X,
  // type:'follows-from'}]` wrote the node, the banner and the attachment, then
  // reported `Unlinked: X` for the typed edge — a KNOWN PARTIAL effect, which
  // latches the manage fence for the rest of the delegation and made the
  // importer roll the whole batch back four times.
  //
  // Every rule here is decidable from the arguments alone, so it belongs in the
  // trusted preparation: the refusal proves the handler never ran
  // (`executionStarted: false`), latches nothing, writes nothing, and can name
  // both remedies at once.
  if (args.supersedes !== undefined) {
    const alsoNamed = [
      (args.links ?? []).includes(args.supersedes) ? '`links`' : undefined,
      (args.typed_links ?? []).some((link) => link.id === args.supersedes) ? '`typed_links`' : undefined,
    ].filter((field) => field !== undefined)
    if (alsoNamed.length > 0) {
      const subject = alsoNamed.length === 2
        ? '`supersedes`, `links` and `typed_links` all name'
        : `\`supersedes\` and ${alsoNamed[0]} both name`
      violations.push(`${subject} ${args.supersedes} — a node is either replaced by this one or related to it, not both. Nothing was written. Keep \`supersedes\` alone (the supersede already records the relation), or drop it and keep the link — unless this new node states that the old one is wrong or outdated; only then drop the link instead. Do not resend unchanged.`)
    }
  }
  const typesByTarget = new Map()
  for (const { id, type } of args.typed_links ?? []) {
    const previous = typesByTarget.get(id)
    if (previous !== undefined && previous !== type) {
      violations.push(`\`typed_links\` gives ${id} both \`${previous}\` and \`${type}\` — one relationship takes one type. Nothing was written. Keep only the entry that describes the intended relationship; identical duplicate entries are allowed.`)
    } else {
      typesByTarget.set(id, type)
    }
  }
  for (const link of args.typed_links ?? []) {
    // Already reported by the `supersedes` rule above.
    if (link.id === args.supersedes) continue
    if (!(args.links ?? []).includes(link.id)) continue
    if (link.type === 'supersedes') {
      violations.push(`\`typed_links\` supersedes ${link.id} and \`links\` also names it — a node is either replaced by this one or related to it, not both. Nothing was written. Drop the supersede and keep the link — unless this new node states that the old one is wrong or outdated.`)
      continue
    }
    // `relates-to` only labels the same symmetric pair. A directed spelling
    // instead changes its meaning, so require one unambiguous relationship.
    if (link.type === 'relates-to') continue
    violations.push(`\`links\` and \`typed_links\` both name ${link.id} — one edge takes one spelling. A symmetric plain link and a directed \`${link.type}\` entry give this relationship different meanings. Nothing was written. Keep the typed entry and drop it from \`links\`, or keep the plain link and drop the typed entry; do not resend unchanged.`)
  }
  // An update cannot link to itself: `addEdge` refuses a self-edge, and the
  // refusal used to arrive after the update landed (the same latched-fence
  // partial as above). Pure: `id` is in the arguments.
  if (args.id !== undefined) {
    const selfLinks = [
      ...(args.links ?? []).map((to) => ['`links`', to]),
      ...(args.typed_links ?? []).map((link) => ['`typed_links`', link.id]),
    ].filter(([, to]) => to === args.id)
    if (selfLinks.length > 0) {
      violations.push(`${selfLinks[0][0]} names ${args.id}, the node this call updates — an edge from a node to itself carries no information. Nothing was written. Drop it from the link list; do not resend unchanged.`)
    }
  }
  if (args.attach !== undefined) {
    // `attach.filename`/`attach.content` are schema-required strings, so no type
    // rule repeats here — only the two shape rules a string can still break.
    const problem = filenameViolation(args.attach.filename)
    if (problem !== undefined) violations.push(`\`attach.filename\` — ${problem}`)
    const bytes = Buffer.byteLength(args.attach.content, 'utf8')
    if (bytes > ATTACH_MAX_BYTES) {
      violations.push(`\`attach.content\` too large (${bytes} bytes, max ${ATTACH_MAX_BYTES}) — attachments are capped; split or trim`)
    }
  }
  return violations
}

/**
 * Placeholder fills (2a, 2026-11-05). Live task 57f24b9a (2026-11-04): a short
 * manage delegation filled every optional field with a stand-in — no body,
 * `attach: {filename:'x', content:'x'}`, and `supersedes` set to the same id it
 * also passed in `links` — and every one of them landed. All of it is decidable
 * from the arguments alone, so it belongs in the trusted preparation, where the
 * refusal is provable non-execution (no fence latch, no quarantine) and the
 * model gets a remedy.
 *
 * Opt-in (`placeholderGuards`, default off): the plain library and its tests
 * keep body-less creates and short attachments. The A2A service arms it per
 * deployment with `runtime.loop.placeholderGuards`, at manage authority only.
 *
 * The body is judged as storage will write it: `normalizeBody` first, so a
 * body of literal escapes (`"\\n"`, `"\\n\\t"`) that unescapes to whitespace
 * is empty here too (review of #287).
 *
 * A create with an empty body is refused only when it carries no attachment: a
 * gist-less node whose detail is all in the attached file is a pattern the
 * synthetic archive includes (node 01J00000000000000000000006), so it
 * stays admitted.
 *
 * @param args - coerced, schema-valid `memory_write` arguments.
 * @returns violation strings; empty when admitted.
 */
function placeholderWriteViolations(args) {
  const violations = []
  if (args.id === undefined && args.append === undefined && args.attach === undefined && (args.body === undefined || normalizeBody(args.body).trim().length === 0)) {
    violations.push('a new node needs a `body` — the fact itself, in full; the description is only its one-line handle. Nothing was written. Resend with `body`.')
  }
  // The two supersede/link contradictions that used to live here moved to
  // `writeArgumentViolations`: they are correctness rules, not
  // placeholder heuristics, so they hold with the guards off too — the live
  // 2026-11-09 incident was exactly that shape, and the fence it latched cost a
  // whole import batch. What remains here is the placeholder fill itself.
  if (args.attach !== undefined) violations.push(...placeholderAttachmentViolations('attach.', args.attach.filename, args.attach.content))
  return violations
}

/** Below this many bytes an attachment holds no detail worth a file (2a). */
const ATTACH_MIN_BYTES = 64

/**
 * Placeholder-attachment rules shared by `memory_write.attach` and
 * `memory_attach` (2a): content too short to be a detail tier, and an agent-
 * chosen name that does not read as a file name (no extension, or a stem under
 * three characters, e.g. `x`). Pure, so it runs in the trusted preparation.
 *
 * Both rules judge only what the arguments carry. A `memory_attach`
 * `from_path` copy is exempt from both: its name is the source's own, and its
 * size is on disk, which a pure preparation cannot read. The A2A wrapper — the
 * only deployment that arms these guards — already refuses `from_path`, so
 * there every attachment is inline and judged; a plain-plugin deployment that
 * arms the guards with `from_path` enabled accepts short copied files.
 *
 * Synthetic fixtures cover attachments under 64 bytes, missing extensions,
 * and stems under 3 characters without exposing private archive statistics.
 */
function placeholderAttachmentViolations(prefix, filename, content) {
  const violations = []
  if (typeof content === 'string') {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes < ATTACH_MIN_BYTES) {
      violations.push(`\`${prefix}content\` is only ${bytes} bytes — an attachment holds detail too long for the body (a full list, table, transcript). Nothing was written. Put a short fact in the node's \`body\` instead of attaching it.`)
    }
  }
  if (typeof filename === 'string') {
    const ext = path.extname(filename)
    const stem = ext === '' ? filename : filename.slice(0, -ext.length)
    // `extname('notes.')` is '.', so an extension must have a character after
    // the dot; the stem is counted in code points, so `😀a.md` is two, not three.
    if (ext.length < 2 || [...stem].length < 3) {
      violations.push(`\`${prefix}filename\` ${JSON.stringify(filename)} does not name what the file holds — use a descriptive name with an extension, e.g. \`standup-schedule.md\`. Nothing was written.`)
    }
  }
  return violations
}

/**
 * `memory_attach`'s argument-shape rules, in the same trusted preparation and
 * for the same reason as `writeArgumentViolations` (#253): "exactly one of
 * `content`/`from_path`", "`filename` is required with `content`", a name the
 * graph layer rejects, an id that cannot name a node and an over-cap payload
 * are all decidable from the arguments alone. Each was a handler throw before,
 * which left the refusal indistinguishable from a failed write.
 *
 * Deliberately NOT here: whether `from_path` is enabled at all (a deployment
 * setting, not an argument) and whether the path is inside the allowed roots
 * (a filesystem fact). Those stay in the handler and stay uncertain.
 *
 * Order matches the handler it replaces, so the first violation a caller sees
 * is the one it always got.
 *
 * @param args - coerced, schema-valid `memory_attach` arguments.
 * @returns violation strings; empty when the shape is admitted.
 */
function attachArgumentViolations(args) {
  const violations = []
  const hasContent = args.content !== undefined
  const hasPath = args.from_path !== undefined
  if (hasContent === hasPath) {
    violations.push('pass exactly one of `content` and `from_path` — to read an attachment back, use memory_read_file')
  }
  if (hasContent && args.filename === undefined) {
    violations.push('`filename` is required with `content`')
  }
  if (hasPath && args.from_path.trim().length === 0) {
    violations.push('`from_path` must be a non-empty path — pass the file to copy in, or `content` for the text itself')
  }
  // The name this call will actually STORE — an explicit `filename`, or with
  // `from_path` the source's basename as the handler resolves it
  // (`fromPathAttachmentName` applies the same `~` expansion). Judging only the
  // explicit argument (review 1 of #253) let `from_path: '/tmp/node.md'` and
  // `from_path: ''` through preparation to be refused later in the handler,
  // i.e. uncertifiably — and judging the RAW basename (review 2) mis-read
  // `~/node.md/.` and `~/x/.`. ONE helper call site, so a stricter name rule
  // (#255's observation.txt / byte cap) applies to both spellings at once.
  const storedName = args.filename ?? (hasPath && args.from_path.trim().length > 0 ? fromPathAttachmentName(args.from_path) : undefined)
  if (storedName !== undefined) {
    const problem = filenameViolation(storedName)
    if (problem !== undefined) {
      violations.push(`\`${args.filename === undefined ? 'from_path (default filename)' : 'filename'}\` — ${problem}`)
    }
  }
  if (!ULID_RE.test(args.id)) {
    violations.push(idViolation('id', args.id, 'Pass the node id copied from memory_search or memory_read.'))
  }
  if (typeof args.content === 'string') {
    const bytes = Buffer.byteLength(args.content, 'utf8')
    if (bytes > ATTACH_MAX_BYTES) {
      violations.push(`\`content\` too large (${bytes} bytes, max ${ATTACH_MAX_BYTES}) — attachments are capped; split or trim`)
    }
  }
  return violations
}

/** The durable-fact write rule — a write-only surface (#263 W2.1). */
const WRITE_LEARN_BULLET = `- When you learn something durable — a decision and why it was made, a preference, a system fact, a gotcha that cost time — call \`memory_write\`, and pass \`links\` so the new node joins the nodes it relates to. An unconnected node is nearly unfindable later.`

/** The write workflow — a write-only surface (#263 W2.1): the update-turn-always-writes rule, the end-of-turn report, `similar` and `link_candidates` follow-ups, one topic per node, why-in-description, session write-back, read-before-replace, description refresh, handoff and in-flight work state, and the status-line write-back. Its sibling `WRITE_UNKNOWN_BULLET` sits in its own slot just above, because that rule has a read form the others do not. */
/** The unknown-result rule, in its write form (#263 W2.1): an unread result is stored as an open question, never reconstructed. The read profile renders {@link READ_UNKNOWN_BULLET} here instead, because the reporting half is read guidance too. */
const WRITE_UNKNOWN_BULLET = `- A tool result you cannot see — archived, truncated, elided, or still pending — is an UNKNOWN, not something you learned. Store the open question ("searched merchant pricing on <date>; result not seen"), never a reconstruction of what the payload plausibly said: if you cannot quote it from the source in front of you, you do not know it. Carry gaps forward as gaps — a plausible reconstruction stored as fact contradicts nothing and poisons every later retrieval, where an open question stays answerable.`

const WRITE_WORKFLOW_BULLETS = `- A memory-update turn ALWAYS ends in a write when the segment carries anything durable — and almost every segment does; when in doubt, it does. Found content but nothing certain? Still write ONE node naming what the conversation covered and which questions it left open — uncertainty is not emptiness, and the user is not present to be asked instead. A segment mixing visible prose with elided tool results is not unusable: store the visible facts, store the elided parts as open questions. Everything the segment carries already stored? The acknowledgement is still a write: revise or link the covering node (\`memory_write\` + its \`id\`), recording what this segment adds — even when that is only the re-confirmation itself (that the user restated the fact, and when, is state: note it in the body, refresh the description if it sharpened). Never a fresh node restating it, never a bare no-op write that changes nothing, and never a silent exit, which is indistinguishable from content lost. The one segment that correctly ends without a write carries nothing durable at all — pure pleasantries, a one-off task that leaves nothing behind: write no node then, and never mint a node whose only content is that there was nothing to store.
- End the turn by reporting what you actually wrote, taken from the tool results: which nodes you stored, updated, or linked, by id. Never claim a write happened, or that none was needed, when the results in front of you say otherwise.
- When a create returns \`similar\`, one existing node may already cover this fact. If it does, revise THAT node (\`memory_write\` + its \`id\`) instead of leaving two — duplicates split ranking and drift into contradiction. Only keep both when they are genuinely distinct facts.
- When a create returns \`link_candidates\`, connect the genuinely related ones with a follow-up \`memory_write\` passing just the new node's \`id\` and \`links\` — the relatedness is real even when you did not think to link at write time.
- One node, one topic. The FIRST fact about a new topic may land on an existing related node when no better home exists; when a SECOND fact about that topic arrives, extract both into a new node — \`memory_write\` with \`links\` naming the old node, so the new node is born connected — and trim them from the old body in the same turn. A node that accretes topic after topic hides its facts from search and becomes every session's write bottleneck.
- For a decision, put the why in the \`description\` itself — "<choice> because <compressed why>", e.g. "Chose Postgres over DynamoDB for transcripts because diarization needs relational joins". Future sessions see descriptions first; a description that only names the choice hides the part they will ask about.
- Write dates absolute. "yesterday"/"today"/"next week" in a body rots the moment the session ends — resolve them against the conversation's date — the rule below says which date that is — and save that ISO date instead. Never copy a date out of an example or a stored note. And resolving is not minting: a date or qualifier the source never STATED — a 「下周」 you anchored to a specific week, a 「无时间表」/「未定」 nobody said — is your inference, and is written as one, marked on its line (推断, or the anchor form 「下周三, 以<anchor date>为基准」); precision written bare reads back as the source's own fact. A precise value the source itself stated needs no mark — quote its words when you keep your resolution beside them.
- Before finishing a session that advanced a thread whose node you read earlier, write the progress back: update that node's body and open questions with \`memory_write\` + \`id\`. Anything decided this session but not written is lost by design.
- Before you replace a node's body, \`memory_read\` it in this same turn. A body rewritten from what you remember of its description line silently drops every fact you did not remember, and nothing in your next answer will show the gap. If you only mean to ADD, write a new linked node instead of rewriting the old one.
- When you revise a body, check whether the node's \`description\` and \`type\` still fit and refresh them in the SAME \`memory_write\` — both are revisable on update (an empty-string \`type\` clears it). The index and search rows are built from descriptions, so a node whose body now holds the answer while its description still says "检索中"/"pending" makes the graph lie about what it knows — and a resolved placeholder usually deserves a retype too (\`thread\` → \`decision\` or \`journal\`).
- Ending a session with work unfinished? Write ONE \`type: handoff\` node — what is pending, blocked on what, the exact next step, what the user is still owed, links to the thread's nodes — or update the one already open. It is pinned above this index for the next session until closed, so never leave a second handoff for the same thread: revise the existing one. When the work concludes, close it — supersede it with the outcome, or retype it (\`type: journal\` or \`thread\`) if it should stay as plain history.
- Unfinished work is not only YOUR session's leftovers — in-flight work you merely learned about is a durable fact too: a task or report the user is still waiting on, a worker return that came back empty or truncated and needs re-delivery, a re-dispatched query, a question left unanswered, a task cancelled midway. Record it with the same state shape a handoff carries (pending / blocked-on / next-step / owed) as a \`type: thread\` node — a thread holds ongoing work state; reserve \`handoff\` for what the next session must pick up. Every pending item carries its identifiers verbatim (the rule below) — a worker id is what makes the item RESUMABLE, and an item stored without one can be neither re-polled nor fetched, only described. An empty or truncated worker return on an open request IS work state, never "nothing to record". And when a later conversation shows the item delivered or dropped, write that back — revise the node, refreshing its description and type as above — so the graph never asserts stale open work. Storing the result as a NEW node does not close the old item: in the same turn, sweep the open handoff/thread nodes that track it and mark that item delivered or drop it — a pending list that survives its own resolution is a lie.
- A status line about what YOU, the assistant, did — searched, found nothing, told the user, could not generate, was corrected — must quote the turn's own words in the line (「…」), or not be written at all. Such an event is never remembered or inferred: either the turn in front of you states it, or it did not happen. When a turn reads an open handoff/thread and resolves nothing, the correct write-back is exactly one {{memory_append_line}} — 状态未变（turn N 无新信息）, with the turn's number or today's date for N — never a narrative of what must have happened.`

/** The identifier rule in its write form (#263 W2.1): copy an identifier into the stored body and description, never reconstruct it. */
const WRITE_IDENTIFIER_BULLET = `- Identifiers are content, not bookkeeping. When a fact you are storing names one — an artifact id for a delivered report, a file or recording id, a task or ticket number, the deliverable's own filename — copy it into the \`body\` exactly as it appeared, and into the \`description\` when it is the natural handle for the thing. They are the highest-precision retrieval keys the graph will ever hold: exact-match tokens that survive paraphrase, which is precisely where word-matching search is weakest. So an id is never the "too much detail" you trim — it is already the shortest possible form of the fact it names — and never something to reconstruct from memory: copy it, or record that it is unknown. Store the user's own name for a thing beside the canonical one ("用户说的'Common工序拆分'即指此场会议"), or the words they will search with are nowhere in the node.`

/** Linking and supersession write rules, the node detail-tier/attachment rule, the do-not-store-what-is-already-answered exemption, and the retraction rule — a write-only surface (#263 W2.1). */
const WRITE_LINK_BULLETS = `- To connect two existing nodes directly, call \`memory_write\` with just \`id\` and \`links\` — one call connects both directions; never write the same link again from the other side.
- To name a relationship, pass \`typed_links: [{id, type}]\` with type one of supersedes/relates-to/follows-from. \`supersedes\` and \`follows-from\` are directional (from this node); \`relates-to\` is symmetric like a plain link, just named. Plain \`links\` stay untyped. A \`supersedes\` typed link is a real supersession, not a mere label: the target gets the "Superseded by …" banner exactly as with the \`supersedes\` argument, so \`memory_read\` the target this session first.
- Do not store what the repository, the shell, or this conversation already answers. Store what you would otherwise have to rediscover. That exemption is for content only — never for rules, and never for work state: a durable preference, output-format rule, correction, or standing reminder is ALWAYS stored, in its own \`type: preference\` node, not as a bullet inside an unrelated thread node — the index surfaces preference nodes to future sessions; a buried bullet never generalizes. "Deliverables as .md, never PDF" lives in how the user talks, not in any record you could retrieve later. In-flight work state is likewise ALWAYS stored: the conversation SAYING a report is pending or a worker came back empty is not the conversation "answering" it — unfinished is not answered.
- A retraction ("ignore what I said about X" / "not X — actually Y") is itself a preference-class write: store the corrected version as a NEW node with \`supersedes: <old-id>\` — never re-merge the withdrawn version, and never rewrite the old node in place (the withdrawal itself is history worth keeping).
- A node has two tiers and one \`memory_write\` stores both. \`node.md\` is the most succinct version — the gist plus the facts, decisions and reasons that must RANK, because search reads \`description\` and \`body\` at full weight and attachments only at a fraction of it. The attachment is the curated DETAIL TIER: when the turn carries detail beyond the gist — a complete list, a table, a full enumeration of an interface's options, an exact click or step sequence, a verbatim passage, a transcript, a code or data dump, extended reasoning — the FULL detail goes in a \`.md\` attachment passed as \`attach: {filename, content}\` on that same write (ONE call, no second tool to remember), never in a loose file elsewhere on the machine, which breaks the moment the node moves or is archived. The split between the tiers is by KIND, not by degree: the BODY keeps the retrieval keys at full weight — the identifiers and ids, the dates, the names, the attachment's filename and the conclusions — while the FILE keeps the bulk just named. When a fact is BOTH — a table of dates, a list of ids, a roster of names — the complete set is bulk and stays in the file; the body keeps only what identifies it: the range, the count, the one or two load-bearing or exceptional members, the conclusion. Restating the file's rows in the body buys nothing: a search hit inside an attachment quotes the row back with the offset to read on from. What must never shrink is the FILE: never trim the detail file down to what the body left out. A verbatim deliverable is the sharpest case of this tier, not a separate trigger: a contiguous payload presented as an artifact's contents (a delivered report's body, a multi-row table, a recited transcript or quoted document), however short the piece in front of you, is attached whole while the body stays the gist card, because a deliverable compressed into body prose cannot be re-served when the user asks for it back. An attachment is CAPTURED from this exchange, never INVENTED beyond it — and the line runs through where the FACTS come from, not through who phrased them. Organising, merging, reformatting or summarising what this exchange carries IS capture: when the material is in the exchange in front of you — what the user pasted or dictated, what an earlier message in this conversation said, what you were shown and have now read — storing it as a file is exactly right, in whatever shape serves it, however you reorder or condense it. The test is the TEXT, never the claim: a turn that SAYS a report was written, read out, or delivered, but does not contain it, carries nothing to attach — and saying so in the body does not make it carried. What is barred is supplying content the exchange does not carry. When the turn only NAMES an artifact — a report still being fetched, a document promised, a file the assistant says it produced — its contents are not yours to write, and drafting a plausible one so the node has something to store is fabrication, not memory: store the gist and what is still owed, and attach the real text in the later turn that carries it. Both attach routes REJECT a payload whose content does not trace back to this conversation, so an invented one costs the turn as well as the tokens — do not draft it. The FILENAME says what the file contains — \`magento-orders-grid-columns.md\`, \`周报-2025W32.md\`, never \`attachment.md\`/\`notes.md\`/\`details.md\` — it is the handle the user asks by and all a later session sees before deciding to open it. (\`memory_attach\` stays the tool when there is no write to ride along with: \`content\` when the detail exists only in the conversation, \`from_path\` when it is already a file on disk — copying it in beats retyping, and the source is left untouched.) Ordinary dialogue has no detail tier: a passing remark needs no file.`

/** The write-time `type` tagging rule — a write-only surface (#263 W2.1). */
const WRITE_TYPE_BULLET = `- When a write clearly fits one kind, tag it with \`type\` — one of identity, preference, decision, gotcha, journal, thread, trivia, handoff — so later sessions can tell an identity fact from a fleeting bit of trivia. Leave it off when none fits cleanly.`

/** The supersede-instead-of-rewrite rules, including retiring a fact — a write-only surface (#263 W2.1). */
const WRITE_SUPERSEDE_BULLETS = `- When new information contradicts or replaces a stored decision, do not rewrite the old node: write a NEW node with \`supersedes: <old-id>\` so the old rationale stays on record (it links the two and banners the old node as superseded). Reserve in-place \`id\` updates for correcting typos or details — not for changing a decision.
- The same rule covers REMOVING a fact: never blank or rewrite a node to delete something the user asked to store — an in-place write keeps no history and the value is gone for good. To retire a fact (secrets included), record the retirement as a new node with \`supersedes\`; whether to truly discard a stored value is the user's call, not yours.`

/** The event-clock rule (#263 W2.1): which date an event is dated from, and how weekday names resolve against the calendar strip. Write-time only, so the read profile drops it with the strip. */
const DATE_RULES_SENTENCE = `Your clock is not the events' clock: date events from the date the conversation states for itself; failing that, from one supplied for it above; failing both, from today. Resolve weekday names ("上周四", "next Wednesday") by LOOKING THEM UP in this calendar — find the anchor date's row, then read the target date off it; never compute a weekday in your head, including for a date the conversation states. When the anchor or target falls OFF this calendar, do not guess: store the phrase with its anchor verbatim ("上周三, 以<the stated date>为基准") instead of a computed date.`

/** Read-profile form of the unknown rule (#263 W2.1): a gap is reported as a gap, never reconstructed. */
const READ_UNKNOWN_BULLET = `- A tool result you cannot see — archived, truncated, elided, or still pending — is an UNKNOWN, not something you learned. Never report one as fact, and never reconstruct what the payload plausibly said: if you cannot quote it from the source in front of you, you do not know it. An open question the user can act on beats a plausible reconstruction, which contradicts nothing and is wrong exactly where the user was relying on you.`

/** Read-profile form of the identifier rule (#263 W2.1): quote identifiers verbatim in answers, never reconstruct one. */
const READ_IDENTIFIER_BULLET = `- Identifiers are content, not bookkeeping. When you answer, quote an identifier exactly as the node records it — an artifact id for a delivered report, a file or recording id, a task or ticket number, the deliverable's own filename, the user's own name for a thing — never reconstructed from memory and never paraphrased away. When it is not in front of you, say it is unknown rather than supply a plausible one: exact-match tokens are what the user will search or paste elsewhere.`

/**
 * The hands-off rule, added by `handsOffRule: true`: the graph is written
 * through these tools and nothing else. A main agent that also holds shell and
 * file tools, asked for something the memory tools do not offer (an import, a
 * bulk edit), otherwise improvises: in a 2026-11 DSH session one wrote its own
 * script that made nodes and made every edge a DIRECTORY instead of a symlink,
 * bypassing the write checks, and the panel showed no edges at all. Opt-in
 * like `batchWrites`, so the default full prompt stays byte-identical (the
 * W2.1 parity goldens) and memory agents without shell tools never pay for it;
 * the DSH direct row turns it on. The AGENTS.md form of the same rule: "never
 * mkdir/ln/echo into the graph by hand".
 */
const HANDS_OFF_BULLET = `- Only the memory tools write the memory graph: never create, change or delete anything inside its directory with shell, file or script tools, and never write your own import script. A hand-made node or edge skips every write check, and an edge that is not a symlink is not an edge.`

const SECTION_TEXT = `## Persistent memory

You have a memory graph on this machine that outlives this session. Each node is one durable fact; edges connect facts that belong together. Three tools reach it.

- Before answering anything that depends on earlier work, a past decision, or a fact about this user or this machine, call \`memory_search\` first. Searching costs one call; guessing costs the user a wrong answer.
- Search matches words, not meaning. When a search misses, retry once or twice with different words — the terms a note would have been WRITTEN with (tool names, hostnames, nouns), not the words of the question. "where does code ship" misses a note written as "deploy target"; "deploy server" finds it.\n- A search result names which terms no node carried at all ("No rows for: …"). Reword the terms it names; keep the ones that worked. That is one targeted retry instead of a blind reword.
- Zero searches is never an answer, and ONE search is never a miss. That retry is REQUIRED before you tell the user nothing is stored, and before you answer a memory question from your own guess: pivot the wording — a synonym, the entity's own name, the page or tool the note would have been written about ("sort dropdown" → "Hot New Top"; the site's name → the page's name). Two searches that both come back empty is a miss; one is a shrug.
- A search that comes back with nothing on point after those retries IS the answer: say memory does not record it — but only once the promising rows have been followed through, the node read and any file the row names opened with \`memory_read_file\`, because a snippet that does not show the answer is not a node that lacks it; a row followed through and still not carrying the thing asked about is a miss like any other. Never bridge the miss with what you generally know about the system the memory covers — a plausible menu item, field, or setting supplied from world knowledge reads back as something you remembered, and is wrong exactly where the user was relying on you. Questions presuming an element exists ("what is between X and Y", "which option does Z offer") are the sharp case: when memory covers the surrounding ground and shows no such element, "there is no such element" beats inventing one, and retrieved negative evidence (a node recording that the filter returned 0 rows) outranks generic knowledge outright. This is calibration, not reflex refusal — when search DID return what the question asks about, answer from it plainly, and when the repository, the shell, or this conversation authoritatively answers, the miss never bars reading it. What it bars is the guess.
- That follow-through gates a POSITIVE answer too, not only a miss: open the node — and the files its row names — before you answer FROM a row, because the row you are reading is a description line and a clipped snippet. And weigh rows by what they say, not by where they rank: when the question's words differ from the note's, the row carrying the answer is often not the first one.
{{memory_hands_off}}{{memory_learn_bullet}}{{memory_batch_writes}}{{memory_unknown_rule}}{{memory_write_guidance}}{{memory_identifiers}}- \`memory_read\` opens one node and lists its connected nodes. Edges are symmetric: linking either node to the other connects both, so the edge list is also who points here. When you reached a node from another one — via an edge, or because that node's content pointed you here — pass \`from\`: traversals rank the graph over time, and a traversal between unconnected nodes wires them. Do not pass \`from\` while merely sifting search results.
{{memory_link_bullets}}- A node listing files carries detail its body does not. When the answer could be in one, open it with \`memory_read_file\` — never answer from the one-line summary, and never guess at what a file contains.
{{memory_type_bullet}}- A node marked \`[superseded by <id>]\` in a search row or in the index below is history: a later decision replaced it. Read the successor for what is true now, and only open the marked node when you need the rationale that was replaced.
{{memory_supersede_bullets}}Today is {{memory_today}} — your own clock, and the date for \`created:\`/\`updated:\` bookkeeping.
{{memory_context_date}}{{memory_date_rules}}{{memory_calendar}}{{memory_dates_separator}}{{memory_handoffs}}Memory index (id — description, most-used first):
{{memory_index}}`

/**
 * `target` with a leading `~` replaced by `home` (#255 review 2).
 *
 * `path.join` IS the normalization that matters: it collapses a trailing `/.`,
 * `..` segments, repeated separators and trailing slashes. That is exactly why a
 * `from_path` of `~/observation.txt/.` opened `~/observation.txt` while a naive
 * `path.basename` of the RAW string said `.` — so the path that is opened and
 * the filename it lands under must be derived from this one function.
 */
function expandHomePath(target, home) {
  if (target === '~') return home
  if (target.startsWith('~/')) return path.join(home, target.slice(2))
  return target
}

/** Expand a leading `~` so a home-relative graph root resolves. */
function expandHome(target) {
  return expandHomePath(target, os.homedir())
}

/** Read the deployment's configuration, applying defaults and failing loud on a bad value. */
function resolveConfig(config) {
  const raw = config ?? {}
  if (typeof raw.graphRoot !== 'string' || raw.graphRoot.length === 0) {
    throw new Error('memory-graph: `graphRoot` is required — the deployment must choose where memory lives')
  }
  const resolved = { root: path.resolve(expandHome(raw.graphRoot)) }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`memory-graph: \`${key}\` must be a non-negative integer, got ${JSON.stringify(raw[key])}`)
    }
    resolved[key] = value
  }
  if (resolved.searchLimit === 0) throw new Error('memory-graph: `searchLimit` must be at least 1')
  // F46 (#75): a memory-update turn that writes nothing is silent data loss —
  // the segment is gone at the next compaction. Only the CALLER knows a turn
  // exists to write memory (most turns legitimately write nothing, and the
  // section itself orders "do not store what the conversation already
  // answers"), so detection is opt-in: compaction/replay overlays set
  // `expectWrite: true`; a chat composition never does.
  const expectWrite = raw.expectWrite ?? false
  if (typeof expectWrite !== 'boolean') {
    throw new Error(`memory-graph: \`expectWrite\` must be a boolean, got ${JSON.stringify(raw.expectWrite)}`)
  }
  resolved.expectWrite = expectWrite
  // P7-C: opt-in write batching in the section — see BATCH_WRITES_BULLET.
  // A boolean like `expectWrite`: the section text is the tested surface, so
  // the deployment states the choice and a typo cannot half-enable it.
  const batchWrites = raw.batchWrites ?? false
  if (typeof batchWrites !== 'boolean') {
    throw new Error(`memory-graph: \`batchWrites\` must be a boolean, got ${JSON.stringify(raw.batchWrites)}`)
  }
  resolved.batchWrites = batchWrites
  // The hands-off rule (HANDS_OFF_BULLET): for a main agent that also holds
  // shell and file tools. A boolean like `batchWrites`, for the same reason.
  const handsOffRule = raw.handsOffRule ?? false
  if (typeof handsOffRule !== 'boolean') {
    throw new Error(`memory-graph: \`handsOffRule\` must be a boolean, got ${JSON.stringify(raw.handsOffRule)}`)
  }
  resolved.handsOffRule = handsOffRule
  // F89 (#219; ADR-0014): opt-in `append` field on memory_write, gated the
  // same way as `batchWrites` and for the same reason — the schema and the
  // section text are the tested surface, and the route ships on the replay's
  // destructive-write gate, never on its token number. Off, the field is
  // absent from the schema and the prompt names the old shape.
  const appendWrites = raw.appendWrites ?? false
  if (typeof appendWrites !== 'boolean') {
    throw new Error(`memory-graph: \`appendWrites\` must be a boolean, got ${JSON.stringify(raw.appendWrites)}`)
  }
  resolved.appendWrites = appendWrites
  // 2a (2026-11-05): refuse placeholder fills in the trusted preparation —
  // a body-less create with no attachment, a tiny or unnamed attachment, a
  // supersede target also passed as a plain link. Off by default so the
  // library keeps its old admission rules; the A2A wrapper arms it at manage
  // when the run config carries `placeholderGuards: true`.
  // Only an absent key defaults: `null` is refused like the wrapper and the
  // service config refuse it, never read as off.
  const placeholderGuards = raw.placeholderGuards === undefined ? false : raw.placeholderGuards
  if (typeof placeholderGuards !== 'boolean') {
    throw new Error(`memory-graph: \`placeholderGuards\` must be a boolean, got ${JSON.stringify(raw.placeholderGuards)}`)
  }
  resolved.placeholderGuards = placeholderGuards
  // #263 W2.1: which prompt surface this composition gets. `full` is the
  // write-time section every deployment has always received — the default, so
  // an unchanged config renders a byte-identical prompt. `read` and `manage`
  // are the A2A profiles: the restricted wrapper registers only a subset of
  // tools, and a read run was paying ~19.6k characters of write-time guidance
  // per call for tools it cannot call. `manage` is `full` minus the two
  // surfaces that name tools A2A strips (memory_merge, memory_restore).
  // Validated like every other key: a typo fails at load instead of silently
  // picking a profile.
  const promptProfile = raw.promptProfile === undefined ? 'full' : raw.promptProfile
  if (promptProfile !== 'full' && promptProfile !== 'read' && promptProfile !== 'manage') {
    throw new Error(`memory-graph: \`promptProfile\` must be 'full', 'read' or 'manage', got ${JSON.stringify(raw.promptProfile)}`)
  }
  resolved.promptProfile = promptProfile
  // F88 (#157): the least share of an attachment's content that must appear in
  // the turn that prompted the write, or the attachment is refused. A FRACTION,
  // so it cannot live in DEFAULTS with the integer knobs. 0.15 sits an order of
  // magnitude above the fabrication cluster (0.0–1.1% across the five known
  // invented attachments) and just under the lowest legitimate attachment
  // measured anywhere (16.5% of 667 on reference replay, p05 73.1%). `0` disables the
  // check — the escape hatch for a deployment whose writers legitimately
  // compose attachments the turn does not contain.
  const attachTraceMin = raw.attachTraceMin ?? 0.15
  if (typeof attachTraceMin !== 'number' || !Number.isFinite(attachTraceMin) || attachTraceMin < 0 || attachTraceMin > 1) {
    throw new Error(`memory-graph: \`attachTraceMin\` must be a number in [0,1], got ${JSON.stringify(raw.attachTraceMin)}`)
  }
  resolved.attachTraceMin = attachTraceMin
  // memory_attach `from_path` confinement (security review, 2026-10-19). The
  // path is model-chosen, so the deployment states where sources may come
  // from. `attachFromPath: false` refuses every `from_path` call.
  // `attachFromPathRoots` lists the directories a source may live under;
  // the default is where the documented use lives — a loose notes file in
  // the user's home (`~/recon-gonogo-notes.md` in the F30 QA) or in the
  // project the agent works in (the working directory). The filesystem root
  // is never a usable root: a default working directory of `/` (a service
  // unit's default) is dropped, and an explicit `/` fails loud.
  const attachFromPathEnabled = raw.attachFromPath ?? true
  if (typeof attachFromPathEnabled !== 'boolean') {
    throw new Error(`memory-graph: \`attachFromPath\` must be a boolean, got ${JSON.stringify(raw.attachFromPath)}`)
  }
  resolved.attachFromPath = attachFromPathEnabled
  let fromPathRoots
  if (raw.attachFromPathRoots === undefined) {
    fromPathRoots = [process.cwd(), os.homedir()].map((entry) => path.resolve(entry)).filter((entry) => entry !== path.parse(entry).root)
  } else {
    if (!Array.isArray(raw.attachFromPathRoots) || raw.attachFromPathRoots.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new Error(`memory-graph: \`attachFromPathRoots\` must be an array of directory paths, got ${JSON.stringify(raw.attachFromPathRoots)}`)
    }
    fromPathRoots = raw.attachFromPathRoots.map((entry) => path.resolve(expandHome(entry)))
    const whole = fromPathRoots.find((entry) => entry === path.parse(entry).root)
    if (whole !== undefined) {
      throw new Error(`memory-graph: \`attachFromPathRoots\` must not include the filesystem root (${whole}) — list the directories sources may come from`)
    }
  }
  resolved.attachFromPathRoots = [...new Set(fromPathRoots)]
  // F48 (#84): the F46 marker recorded only pid + timestamp, so offline
  // forensics could not tell WHICH segment died. The caller is the only party
  // that knows — a compaction/replay overlay sets `turnId` per invocation (a
  // trace/step id) and the marker line and stderr warning carry it. Optional:
  // absent means the marker keeps its F46 shape. The marker file is
  // line-oriented, so an id that could span lines fails loud instead of
  // forging entries.
  const turnId = raw.turnId
  if (turnId !== undefined) {
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error(`memory-graph: \`turnId\` must be a non-empty string, got ${JSON.stringify(turnId)}`)
    }
    if (/[\r\n\u2028\u2029]/.test(turnId)) {
      throw new Error('memory-graph: `turnId` must be a single line — the zero-write marker is line-oriented')
    }
    resolved.turnId = turnId
  }
  // F53 (#89): the writer stamps its own wall-clock onto events that happened
  // at conversation time — three consecutive replays each dated the same gym
  // reminder to their own run date over an explicit in-segment anchor. Only
  // the CALLER knows when the conversation happened (replay: the timestamp of
  // the segment being replayed; compaction: the session's own clock — a trace
  // spanning midnight wants each invocation's own date, not the trace's
  // start), so the event clock is opt-in and per invocation:
  // absent means the event clock is today and the section supplies no date at
  // all — an ordinary live turn behaves exactly as it always has, and only the
  // conversation itself can move the anchor. Validated to the ISO date shape
  // because it is rendered verbatim into the prompt: the pattern is anchored
  // and non-multiline, so anything carrying a line terminator (or any other
  // stray character) fails, and a well-shaped impossibility — `2026-02-30`,
  // which Date silently rolls into March — is caught by round-tripping it.
  const contextDate = raw.contextDate
  if (contextDate !== undefined) {
    if (typeof contextDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(contextDate)) {
      throw new Error(`memory-graph: \`contextDate\` must be a YYYY-MM-DD date, got ${JSON.stringify(contextDate)}`)
    }
    const parsed = Date.parse(`${contextDate}T00:00:00Z`)
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== contextDate) {
      throw new Error(`memory-graph: \`contextDate\` must be a real calendar date, got ${JSON.stringify(contextDate)}`)
    }
    resolved.contextDate = contextDate
  }
  // F69 (#137): dsh forwards an execution context to every tool call, but
  // this repository documents no canonical field carrying its Session id.
  // Deployments that know their harness's shape may therefore supply the
  // resolver explicitly; a non-function would defer the failure until the
  // first tool call and silently leave the concurrency gate mis-scoped.
  const sessionKey = raw.sessionKey
  if (sessionKey !== undefined) {
    if (typeof sessionKey !== 'function') {
      throw new Error(`memory-graph: \`sessionKey\` must be a function, got ${JSON.stringify(sessionKey)}`)
    }
    resolved.sessionKey = sessionKey
  }
  // Write-session provenance (#317). An optional resolver beside `sessionKey`,
  // validated the same way: a host that knows its harness's root-session shape
  // answers here, and a typo fails at load instead of leaving every write
  // silently unattributed. Absent means every line says `no-resolver`.
  const provenance = raw.provenance
  if (provenance !== undefined) {
    if (typeof provenance !== 'function') {
      throw new Error(`memory-graph: \`provenance\` must be a function, got ${JSON.stringify(provenance)}`)
    }
    resolved.provenance = provenance
  }
  // Blended-index ranking weights (F20, #29). Each field is optional and falls
  // back to the traversal-dominant default; a present value must be a
  // non-negative finite number, so a typo or a bad type fails loud at load.
  const weights = { ...DEFAULT_RANK_WEIGHTS }
  const rankWeights = raw.rankWeights
  if (rankWeights !== undefined) {
    if (typeof rankWeights !== 'object' || rankWeights === null || Array.isArray(rankWeights)) {
      throw new Error('memory-graph: `rankWeights` must be an object')
    }
    for (const key of Object.keys(DEFAULT_RANK_WEIGHTS)) {
      const value = rankWeights[key]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`memory-graph: \`rankWeights.${key}\` must be a non-negative finite number, got ${JSON.stringify(value)}`)
      }
      weights[key] = value
    }
  }
  resolved.rankWeights = weights
  // #263 W3-lite: opt-in run-stable rendering of the two graph-derived prompt
  // variables. `undefined` (default) keeps today's behavior exactly. `'run'`
  // renders `memory_index` and `memory_handoffs` ONCE per plugin instance and
  // serves those same bytes on every later assembly. The trigger is that even a
  // read-authority run perturbs the graph: `memory_read` appends access lines
  // (and a traversal read can wire a missing edge), both of which re-rank the
  // index — so a re-render mid-run rewrites the system prompt at a step
  // boundary and breaks the provider's prefix cache. `'off'` is refused rather
  // than accepted as a synonym for undefined: absence is the legacy shape, so a
  // typo cannot look like a deliberate choice in a deployment's config.
  const indexSnapshot = raw.indexSnapshot
  if (indexSnapshot !== undefined) {
    if (indexSnapshot !== 'run') {
      throw new Error(`memory-graph: \`indexSnapshot\` must be 'run' when present, got ${JSON.stringify(indexSnapshot)}`)
    }
    resolved.indexSnapshot = indexSnapshot
  }
  // #263 (wave 3, lever 1): `promptSnapshot: 'run'` widens the freeze from the
  // two graph-derived variables to EVERY prompt variable that can change
  // mid-run, and — unlike `indexSnapshot: 'run'` — it does not drop on a
  // successful write. It is a manage-authority lever (the wrapper arms it only
  // there): a manage run rewrites the graph it is looking at, so under the
  // W3-lite rule the prompt would re-splice at almost every step and pay a full
  // re-prefill each time. Measured on 152 manage runs: every one of 337
  // mid-run re-splices changed the system prompt, 337/337 with the first
  // divergence inside the index block, and a step whose prompt changed kept
  // ~30% cache share against ~200-350% on a step whose prompt held. Validated
  // like `indexSnapshot`: a typo fails at load, absence is the legacy shape.
  const promptSnapshot = raw.promptSnapshot
  if (promptSnapshot !== undefined) {
    if (promptSnapshot !== 'run') {
      throw new Error(`memory-graph: \`promptSnapshot\` must be 'run' when present, got ${JSON.stringify(promptSnapshot)}`)
    }
    resolved.promptSnapshot = promptSnapshot
  }
  // #263 W2.2: the index growth policy. Absent (the default) keeps the untiered
  // index byte-identical — every deployment that does not opt in sees exactly
  // the prompt it always has. `true` selects INDEX_BUDGET; an object may override
  // any of its three constants. See graph.js for why the policy bounds the index
  // rather than the node count, and what it does to open work state.
  //
  // `false` is accepted and means "off", like every other boolean knob here, so
  // a direct caller can disable it in the same idiom it enables the rest. The
  // A2A wrapper strips the key unless its run config armed it, so this path only
  // ever serves direct compositions.
  const indexBudget = raw.indexBudget
  if (indexBudget !== undefined && indexBudget !== false) {
    if (indexBudget !== true) {
      if (typeof indexBudget !== 'object' || indexBudget === null || Array.isArray(indexBudget)) {
        throw new Error(`memory-graph: \`indexBudget\` must be true or an object of overrides, got ${JSON.stringify(indexBudget)}`)
      }
      for (const [key, value] of Object.entries(indexBudget)) {
        // `Object.hasOwn`, not `key in`: an inherited name (`toString`,
        // `constructor`) is not a policy constant, and `in` would let a typo
        // shaped like one through and then render the default policy silently.
        if (!Object.hasOwn(INDEX_BUDGET, key)) {
          throw new Error(`memory-graph: \`indexBudget.${key}\` is not a policy constant — expected one of ${Object.keys(INDEX_BUDGET).join(', ')}`)
        }
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`memory-graph: \`indexBudget.${key}\` must be a non-negative integer, got ${JSON.stringify(value)}`)
        }
      }
    }
    resolved.indexBudget = indexBudget
  }
  return resolved
}

/**
 * One line per match, in the order the model should consider them.
 * @param value - the search result.
 * @param promptProfile - `read` omits the read-before-update reminder, which
 *   exists only to avoid a wasted roundtrip on a WRITE the read authority
 *   cannot make (#263 W2.1).
 */
function renderMatches(value, promptProfile = 'full') {
  // A term that matched nothing is the one thing worth knowing before
  // rewording, so it is reported even when nothing matched at all (F36, #56).
  const missing = value.unmatched && value.unmatched.length > 0 ? `\nNo rows for: ${value.unmatched.join(', ')} — reword these, not the terms that worked.` : ''
  // The reword floor (F80, #184), set by the search tool on the turn's first
  // probe when it came back with nothing. It rides the result rather than the
  // prompt because this is the moment the model decides the graph is empty on
  // the subject — the same placement reason as the update marker below.
  const floor = value.first_probe ? '\nThis was your first search and it found nothing — not yet a memory miss. Search again with different words (a synonym, the entity\'s own name, the page or tool a note would have named) before answering or reporting nothing stored.' : ''
  if (value.matches.length === 0) return `No memory matched.${missing}${floor}`
  const head = (value.tokens === 0
    ? `${value.matches.length} of ${value.total} nodes (whole graph, most-used first):`
    : `${value.matches.length} shown — ${value.full} match every term, ${value.total} match at least one:`) + missing
  const rows = value.matches.map((m, i) => {
    const files = m.files && m.files.length > 0 ? ` [${m.files.length} file${m.files.length === 1 ? '' : 's'}]` : ''
    // F86 (#201): search rows are 64% of tool-result bytes, so the attachment
    // excerpt block — the heaviest part of a row — rides only the top 5, the
    // rows a model actually opens. Rows 6+ keep the `[N files]` marker above so
    // memory_read_file stays discoverable, but drop the quote/offset block and
    // the "matched in …" line. "Top 5" = the first 5 of value.matches, already
    // rank-ordered by search().
    const topFive = i < 5
    // An attachment hit is the one case where the snippet below may not contain
    // the matched term at all, so say which file to open (F29, #49) — and QUOTE
    // it (F81, #182). Naming the file asked for a second tool call that the
    // measured failure never made: 89 of 104 failed reference retrieval answers issued one
    // search and answered from the body snippet, which is precisely the gist
    // that dropped the fact. The quote carries the offset to resume at, so
    // opening the file is a targeted read and not a walk from byte zero.
    const inFiles = topFive && m.matched_in && m.matched_in.length > 0 ? `\n    matched in ${m.matched_in.join(', ')} — the snippet below is the body gist and may not carry the fact; open the file with memory_read_file` : ''
    // The filename is JSON-quoted in the call it spells out: an attachment name
    // may legally contain a quote or a newline (assertAttachmentName bars path
    // separators and dotfiles, not those), and a raw interpolation would hand
    // back an unusable call and break the row's layout (codex review of #182).
    const quotes = topFive ? (m.file_matches ?? []).map((f) => `\n    ${JSON.stringify(f.file)} @ byte ${f.offset}: ${f.excerpt}\n      …more with memory_read_file(id: "${m.id}", file: ${JSON.stringify(f.file)}, offset: ${f.offset})`).join('') : ''
    // The banner naming the successor lives in the body, which this row never
    // shows — without the marker a replaced node reads as current (F24, #44).
    const replaced = m.superseded_by ? ` [superseded by ${m.superseded_by}]` : ''
    // F86 (#201): the per-row `(matched: …)` echo is dropped — the header line's
    // per-term summary (the `No rows for: …` line above) already carries which
    // terms found nothing, and the echo repeated on every row for little signal.
    return `${m.id} — ${m.description}${m.archived ? ' [archived]' : ''}${replaced}${files}${inFiles}${m.snippet ? `\n    ${m.snippet}` : ''}${quotes}`
  })
  // The read-before-update rule, surfaced at the moment the model picks a row
  // to write to (#146): the F68 gate rejects an update to a node this Session
  // has not read, and under a seeded graph ~10% of writes paid that wasted
  // roundtrip because the instruction was nowhere in context at decision time.
  // #263 W2.1: the read profile registers no write tool, so the reminder is
  // pure noise there — and it would name a call the authority cannot make.
  const updateReminder = promptProfile === 'read' ? '' : '\nTo update any node above, memory_read it first — updates to nodes not read this session are rejected.'
  return [head, ...rows].join('\n') + updateReminder
}

/** The whole node and its neighbors — one row per logical edge (F54, #90):
 * plain edges are symmetric, so the peers list is also who points here.
 * @param value - the node view.
 * @param appendWrites - whether the `append` route is registered.
 * @param promptProfile - `read` omits the open-work write-back reminder: it
 *   orders a `memory_write` the read authority cannot make (#263 W2.1). The
 *   truncation guard it shares a branch with is unaffected, because with no
 *   reminder to place the branch has nothing left to decide.
 */
function renderNodeView(value, appendWrites = false, promptProfile = 'full') {
  const lines = [`${value.id} — ${value.description}`, `created: ${value.created}`]
  if (value.updated) lines.push(`updated: ${value.updated}`)
  if (value.type) lines.push(`type: ${value.type}`)
  const body = value.body.trim()
  if (body.length > BODY_VIEW_CHARS) {
    // A multi-hundred-KB body would flood the model's context in one call;
    // truncate loudly so the agent knows there is more and where it lives.
    lines.push('', body.slice(0, BODY_VIEW_CHARS).replace(/[\uD800-\uDBFF]$/, ''), `…[body truncated: ${body.length - BODY_VIEW_CHARS} more chars — read node.md inside node ${value.id} under the graph root for the rest]`)
  } else if (body.length > 0) lines.push('', body)
  const list = (label, entries) => {
    if (entries.length === 0) return
    lines.push('', `${label}:`)
    // A typed edge shows its relationship in a `[type]` tag between the id
    // and description; an untyped edge renders as before.
    for (const entry of entries) lines.push(entry.type ? `  ${entry.id} [${entry.type}] — ${entry.description}` : `  ${entry.id} — ${entry.description}`)
  }
  // Each logical edge once (F54, #90): a symmetric edge used to appear twice —
  // under "Edges out" here and under "Backlinks" on the peer — reading as two
  // relations where the graph stores one.
  list('Edges', value.edges)
  if (value.files.length > 0) {
    // Bounded like the body above: a node carrying hundreds of attachments
    // must not flood the context through the file list instead.
    const FILE_LINES_MAX = 20
    // Say how to open one (F22, #42): a bare list taught the agent that files
    // exist without telling it a file is readable, so it invented the content.
    lines.push('', `Files in this node — open one with memory_read_file(id: "${value.id}", file: "<name>"):`)
    for (const file of value.files.slice(0, FILE_LINES_MAX)) lines.push(`  ${file.name} (${file.size} bytes)${file.summary ? ` — ${file.summary}` : ''}`)
    if (value.files.length > FILE_LINES_MAX) lines.push(`  …[${value.files.length - FILE_LINES_MAX} more files — list the node directory under the graph root for the rest]`)
  }
  // Write-time findings still queued against this node (F70, #149) — the
  // session reading it is the one best placed to act on them.
  // #263 W2.1: in the read profile nobody can act on them, so the heading keeps
  // the ROWS (they are facts about the node, and a reader may need to know the
  // node is flagged) but drops the two write actions it used to order.
  if ((value.advisories ?? []).length > 0) {
    const heading = promptProfile === 'read'
      ? 'Maintenance advisories on this node (the maintain pass addresses these):'
      : 'Maintenance advisories on this node — address what still applies (split an overgrown node into linked children, refresh a stale description) or leave for the maintain pass:'
    lines.push('', heading)
    for (const row of value.advisories) lines.push(`  ${row}`)
  }
  // The sanctioned no-change close (F71, #157), the counterpart of F66's
  // zero-write marker: reading an open deliverable-tracking node and resolving
  // nothing is exactly where the writer invents a resolution — all three
  // fabricated assistant-failure episodes in the synthetic replay followed
  // a memory_read of an open handoff/thread. Give it the correct
  // zero-information write-back at the moment of the read. Open means live
  // work-state type with no superseded banner; a closed ledger is history and
  // gets no write-back prompt. Bounded by the truncation contract (codex
  // review of this change): memory_write replaces the WHOLE body, so an
  // "append" instructed from a truncated view — the same past-BODY_VIEW_CHARS
  // boundary F62's seenBodies draws — would order exactly the blind tail loss
  // that guard exists to catch; a body this view could not show whole gets no
  // write-back prompt either.
  // F89 (#219): with the append route on, the reminder names it — one word
  // inside the same sentence, no new prose. The truncation bound above stays
  // even though an append no longer replaces: a body past BODY_VIEW_CHARS has
  // outgrown a write-back reminder either way.
  if (promptProfile !== 'read' && WORK_STATE_TYPES.includes(value.type) && supersededBy(value.body) === undefined && body.length <= BODY_VIEW_CHARS) {
    lines.push('', `This node tracks open work. If this turn resolves or advances none of it, the correct write-back is exactly one appended line — 状态未变（turn N 无新信息）, with this turn's number or today's date for N — via memory_write ${appendWrites ? '`append` ' : ''}with this id, never a narrative. A status line about what the assistant did must quote the turn, or not be written at all.`)
  }
  return lines.join('\n')
}

/** An edge row: a peer that may additionally carry its edge `type` (F3,
 * #12). The key is absent on untyped edges, so it is optional, not required. */
const OUT_EDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description'],
  properties: { id: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: EDGE_TYPES } },
}

/** A write-time suggestion: an existing node with the score that surfaced it. */
const SUGGESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'score'],
  properties: { id: { type: 'string' }, description: { type: 'string' }, score: { type: 'number' } },
}

/**
 * The zero-write marker and the bounds of the notice that reads it back
 * (F46/F48 write it, F60 reads it, #105).
 *
 * ZERO_WRITE_FILE is the contract between the exit hook and the prompt block —
 * one name, so a rename cannot leave the producer appending to a file the
 * reader no longer looks at.
 *
 * ZERO_WRITE_DAYS: how recent an entry must be to still be worth salvaging.
 * Seven days — one working week, past which nobody's recollection of "what
 * that conversation covered" is reliable enough to store as fact anyway, and a
 * notice that never clears is a notice nobody reads. It doubles as the
 * tolerance on the other side of now: a marker dated in the future is a broken
 * clock, and without an upper bound one such entry would pin the notice open
 * until its own date came round.
 *
 * ZERO_WRITE_TAIL: how much of the marker is read. It is append-only and
 * unbounded, and the reader runs on the synchronous assembly path, so only the
 * tail is read — 64 KiB is ~1000 entries, far past a week of any real traffic.
 * The one entry it can miss is a pathological one: `turnId` is validated as a
 * single LINE with no length cap, so an id longer than this window would make
 * its own entry unreadable here. That costs a count, never a crash, and the
 * marker file still holds it.
 *
 * ZERO_WRITE_MAX_COUNT: the largest count rendered, above which it shows
 * "20+". The number exists to convey "this keeps happening"; past twenty it
 * has already conveyed it, and the exact figure is in the file.
 */
const ZERO_WRITE_FILE = '.zero-write-turns'
const ZERO_WRITE_DAYS = 7
const ZERO_WRITE_TAIL = 64 * 1024
const ZERO_WRITE_MAX_COUNT = 20

/**
 * Register the memory tools and the memory prompt section.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the deployment's graph root and result bounds.
 */
export function apply(ctx, config) {
  const { root, searchLimit, maxIndexEntries, indexCacheMs, maintenanceBacklog, rankWeights, expectWrite, turnId, contextDate, sessionKey, provenance, batchWrites, handsOffRule, appendWrites, promptProfile, attachTraceMin, attachFromPath: fromPathEnabled, attachFromPathRoots, indexSnapshot, promptSnapshot, indexBudget, placeholderGuards } = resolveConfig(config)

  // A Symbol cannot collide with any real id the harness supplies. Calls with
  // no usable execution context all share this singleton, preserving the old
  // one-state behavior for one-Session deployments and direct callers/tests.
  const DEFAULT_SESSION_KEY = Symbol('memory-graph:default-session')

  /**
   * Resolve the Session that owns one tool call's process state (F69, #137).
   *
   * In the installed dsh contract, `ToolExecutionInput.agent` from
   * `@deepseek-ai/dsh-tools` carries the calling Agent, whose `Agent.id` in
   * `@deepseek-ai/dsh-agent` is "The single identity shared with session".
   * That confirmed id is the primary built-in path. The older speculative
   * `sessionId`, `conversationId`, and `session.id` shapes remain as harmless
   * lower-priority fallbacks for harness surfaces that differ from
   * ToolExecutionInput; the configured resolver remains the escape hatch and
   * gets first refusal, with `undefined` meaning "not resolved".
   */
  const sessionKeyOf = (exec) => {
    if (sessionKey !== undefined) {
      const key = sessionKey(exec)
      if (key !== undefined) return key
    }
    const agentId = exec?.agent?.id
    if (agentId !== undefined && agentId !== null) return String(agentId)
    return exec?.sessionId ?? exec?.conversationId ?? exec?.session?.id ?? DEFAULT_SESSION_KEY
  }

  /**
   * The provenance of one tool call (#317): WHICH root chat session is writing.
   *
   * Deliberately separate from {@link sessionKeyOf}, which stays the
   * authorization/concurrency key and is never consulted here. The order is
   * fixed and the first match wins:
   *
   *   1. `exec.provenance` — an object a host adapter stamped on the exec after
   *      resolving the root ITSELF (dsh's memory agent stamps the delegation's
   *      root; OpenCode's `makeExec` stamps its walk result). The engine cannot
   *      walk a harness's ancestry, so it trusts that stamp and only checks its
   *      shape.
   *   2. `config.provenance(exec)` — the deployment's resolver, final including
   *      a `null` session. A throw, or any answer outside the schema, is
   *      `resolver-error`, never a crash and never a repaired id.
   *   3. `{actor:'unknown', host:'unknown', session:null, reason:'no-resolver'}`
   *      — and ONLY this case: no resolver configured and no exec stamp. A
   *      configured resolver that returns nothing is a broken resolver, not an
   *      unconfigured one.
   *
   * `exec.agent.id` is NEVER read: a subagent's `agent.id` is the CHILD, and a
   * wrong id is worse than a missing one (rules 1 and 2).
   */
  const provenanceOf = (exec) => {
    const resolverError = { actor: 'unknown', host: 'unknown', session: null, reason: 'resolver-error' }
    let value = exec?.provenance
    if (value !== undefined) return checkProvenance(value) ?? resolverError
    if (provenance === undefined) return { actor: 'unknown', host: 'unknown', session: null, reason: 'no-resolver' }
    try {
      value = provenance(exec)
    } catch {
      return resolverError
    }
    // A configured resolver owes an answer. `undefined` is a malformed answer,
    // not "no resolver": `no-resolver` stays reserved for the absent case.
    return checkProvenance(value) ?? resolverError
  }

  /**
   * The closed sets of the line schema (design 26111000 §Line schema). A value
   * outside them is malformed — never a new actor, host or reason drifting into
   * the log from a host that guessed.
   */
  const PROVENANCE_ACTORS = new Set(['chat', 'import', 'unknown'])
  const PROVENANCE_HOSTS = new Set(['dsh', 'opencode', 'unknown'])
  const PROVENANCE_REASONS = new Set(['no-resolver', 'root-unverified', 'walk-failed', 'import', 'resolver-error'])

  /**
   * A well-formed `{actor, host, session, reason?}`, or `undefined` — the
   * caller maps that to `resolver-error`. `session:null` REQUIRES a reason from
   * the closed set (a null session with no explanation has no positive root
   * signal), and a proven session must never carry one.
   */
  const checkProvenance = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const { actor, host, session, reason } = value
    if (!PROVENANCE_ACTORS.has(actor)) return undefined
    if (!PROVENANCE_HOSTS.has(host)) return undefined
    if (session === null) {
      return PROVENANCE_REASONS.has(reason) ? { actor, host, session: null, reason } : undefined
    }
    if (typeof session !== 'string' || session.length === 0 || session.length > 200) return undefined
    if (reason !== undefined) return undefined
    return { actor, host, session }
  }

  /**
   * Warn once, on stderr, that a call's provenance could not be resolved — the
   * same guarded posture as {@link journalAdvisories}' own append failure. The
   * line names no session and no answer: it is operator bookkeeping about a
   * broken resolver, and the write's outcome never changes because of it.
   */
  const warnProvenance = (detail) => {
    try {
      process.stderr.write(`memory-graph: could not resolve write provenance — ${detail} (#317). The write itself landed, and its line says resolver-error.\n`)
    } catch { /* no channel left to report on, and the node is safe either way */ }
  }

  /**
   * Append one call's provenance lines, grouped per node: one
   * {@link appendProvenance} per node, carrying every line this call made on
   * it. Callers hand the transition table's rows, not paths.
   *
   * FAIL-OPEN (rule 4), on the exact posture {@link journalAdvisories} takes:
   * the mutation has already committed, so a bookkeeping failure costs one
   * stderr line and changes neither the tool result nor the write fence. The
   * warning is best-effort too — a harness that replaced stderr must not turn a
   * landed write into a thrown error.
   *
   * `entries` is a list of `{id, op, peer?, file?, type?}`; `ts` comes from the
   * caller's own clock reading so a line's time is the write's time, and `call`
   * is the transient per-call plan, not a log statement.
   *
   * Safe to hand the SAME array from an outer `finally` (the committed-transition
   * flush a handler that threw still owes): the input is DRAINED at entry, so a
   * second flush of the same array sees an empty list and writes nothing twice.
   * That is what lets a handler push a receipt in one scope and drain it in
   * another without tracking whether the first drain already ran.
   */
  const recordProvenance = async (entries, exec, ts) => {
    if (!Array.isArray(entries)) return
    // Drain first: whatever this flush does not see, a later flush cannot write.
    const drained = entries.splice(0)
    if (drained.length === 0) return
    let who
    try {
      who = provenanceOf(exec)
      if (who.reason === 'resolver-error') warnProvenance('the resolver threw or answered outside the schema')
    } catch {
      who = { actor: 'unknown', host: 'unknown', session: null, reason: 'resolver-error' }
      warnProvenance('the resolver threw or answered outside the schema')
    }
    const byId = new Map()
    for (const entry of drained) {
      if (entry === undefined || entry === null) continue
      if (typeof entry.id !== 'string' || !ULID_RE.test(entry.id)) continue
      const record = { v: 1, ts, op: entry.op, actor: who.actor, host: who.host, session: who.session }
      if (who.session === null) record.reason = who.reason
      if (typeof exec?.callId === 'string') record.call = exec.callId
      if (entry.peer !== undefined) record.peer = entry.peer
      if (entry.file !== undefined) record.file = entry.file
      if (entry.type !== undefined) record.type = entry.type
      const list = byId.get(entry.id)
      if (list === undefined) byId.set(entry.id, [record])
      else list.push(record)
    }
    for (const [id, records] of byId) {
      try {
        await appendProvenance(root, id, records)
      } catch (error) {
        try {
          process.stderr.write(`memory-graph: could not append ${records.length} provenance line${records.length === 1 ? '' : 's'} for ${id} — ${error.message} (#317). The write itself landed.\n`)
        } catch { /* no channel left to report on, and the node is safe either way */ }
      }
    }
  }

  /** The ISO stamp a provenance line carries: the same clock reading as its write. */
  const provenanceTs = (now) => new Date(now).toISOString()

  /**
   * Turn an `addEdge` mutation receipt into `edge` lines (#317, review of
   * #319). Two record shapes, two very different fan-outs:
   *
   *   - a symlink HALF (`{src, dst}`, no `previous` key): the logical edge is
   *     now present, so BOTH endpoints' records changed — one line each, both
   *     carrying the call's `type` when it had one;
   *   - an `.edge-types` SLOT (`{src, dst, type, previous}`): only the OWNER's
   *     record changed, so exactly one line, carrying the NEW type. `type` is
   *     absent when the slot was cleared (a directed type replacing the peer's
   *     symmetric line), because from that side the edge now holds no type at
   *     all and claiming otherwise would be a wrong record.
   *
   * An empty receipt yields no lines, which is what keeps an identical repeated
   * typed link a no-op. Lines are deduped per `(node, peer)`: creating a plain
   * edge mints BOTH halves, and each endpoint's record still changed exactly
   * once — so one line each, not one per half.
   */
  const edgeReceiptLines = (minted, callType) => {
    const seen = new Set()
    const lines = []
    const push = (line) => {
      const key = `${line.id}\u0000${line.peer}`
      if (seen.has(key)) return
      seen.add(key)
      lines.push(line)
    }
    for (const entry of minted) {
      if (Object.hasOwn(entry, 'previous')) {
        const line = { id: entry.src, op: 'edge', peer: entry.dst }
        if (entry.type !== undefined) line.type = entry.type
        push(line)
        continue
      }
      for (const [id, peer] of [[entry.src, entry.dst], [entry.dst, entry.src]]) {
        const line = { id, op: 'edge', peer }
        if (callType !== undefined) line.type = callType
        push(line)
      }
    }
    return lines
  }

  /**
   * The `edge` lines a FAILED `addEdge` still owes (#321). `addEdge` throws,
   * so it never returned a status — but its `minted` receipts name exactly the
   * mutations it had already committed when it threw, and those are still on
   * disk. Nothing here is re-read from disk: a later writer can invalidate a
   * before/after guess, a receipt cannot.
   *
   * The rule differs from {@link edgeReceiptLines}' success fan-out on purpose:
   *
   *   - a symlink HALF (`{src, dst}`) is recorded on `src` ONLY. Half a
   *     symmetric pair landed; whether the mirror half did is exactly what is
   *     unknown, and a line on `dst` would claim an edge `dst` may not hold. A
   *     mirror receipt (`{dst, src}`) in the same array gives `dst` its own line
   *     — then both halves really did land.
   *   - a slot receipt is recorded on its OWNER exactly as on the success path:
   *     the sidecar write returned, so that type record is on disk.
   *   - the half line carries NO type: the call's `type` may never have reached
   *     the sidecar (that write is what failed), and claiming a type the disk
   *     does not hold is a wrong record. Where a slot receipt covers the same
   *     (id, peer), its line wins and does carry the type — that one landed.
   */
  const edgeFailureLines = (minted) => {
    // A Map keeps first-insertion order and updating a key keeps its slot, so
    // the slot-over-half precedence needs no separate ordering array.
    const byKey = new Map()
    const place = (line, isSlot) => {
      const key = `${line.id}\u0000${line.peer}`
      if (isSlot || !byKey.has(key)) byKey.set(key, line)
    }
    for (const entry of minted) {
      if (Object.hasOwn(entry, 'previous')) {
        const line = { id: entry.src, op: 'edge', peer: entry.dst }
        if (entry.type !== undefined) line.type = entry.type
        place(line, true)
        continue
      }
      place({ id: entry.src, op: 'edge', peer: entry.dst }, false)
    }
    return [...byKey.values()]
  }

  /**
   * Drop the transitions a rollback actually UNDID (#317, #321).
   *
   * `rollbackSuccessor` deletes the successor's own directory and nothing
   * else, so the ONLY transitions it undoes are the ones recorded ON the
   * successor: its `create`, the attach that rode its rename, its
   * `supersede` line, and its own half of each edge. Those go.
   *
   * A line whose `peer` names the successor is KEPT, even though the review's
   * first cut dropped it with the rest: the mutation it records is still on
   * disk. A SYMMETRIC half (plain, `relates-to`) has a reciprocal half in the
   * PEER's `__edges__`, which the rollback never touches, so the peer really did
   * gain that edge — its line is accurate (the half is dangling, which
   * `isEdgeEntry` still counts as an edge and graph-maintain reports separately).
   * The same holds for a `superseded-by` banner on the old node: the banner
   * landed and stays, so its line stays. Dropping peer-side lines would lose
   * real, still-visible provenance; removing the peer's half to make the drop
   * true would mutate a node the rollback deliberately spares.
   *
   * A DIRECTED half (`supersedes`, `follows-from`) is the exception (#321): it
   * lives in the SUCCESSOR's own `__edges__` — or, when the successor is the
   * target, in its own sidecar — and nothing reciprocal exists on the peer. The
   * rollback deletes that directory, so a peer-side `edge` line naming the
   * removed successor would describe a half no node holds any more. Those go
   * with the successor's own lines.
   *
   * The rule is therefore "drop by the node the rollback removed, plus any
   * directed edge line pointing at it", applied BEFORE the flush.
   */
  const dropRevertedProvenance = (removed, id, lines) => {
    if (removed !== true) return
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].id === id) { lines.splice(i, 1); continue }
      if (lines[i].op === 'edge' && lines[i].peer === id && DIRECTED_EDGE_TYPES.includes(lines[i].type)) lines.splice(i, 1)
    }
  }

  /**
   * The lines one supersede attempt owes, from its receipts alone (#321) —
   * shared by both spellings (`supersedes:` on create, a typed `supersedes`
   * link) so they cannot drift. Three-way, in the design's order:
   *
   *   1. a `banner` receipt → the `supersede` pair, and NO edge lines (even if
   *      `moveExtraFiles` then threw: the banner is the record a reader
   *      follows, and design row 61 gives that pair no `edge` line);
   *   2. an `already` receipt → nothing. An already-bannered node transitioned
   *      nothing, including a sidecar retype, so its receipts must not surface
   *      as edge lines;
   *   3. otherwise the attempt threw before either exit → the failure rule's
   *      edge lines, with `type` only where a slot receipt proves it landed.
   *
   * `newId`/`oldId` are the successor/superseded ids; `type` is the pair's
   * recorded edge type. `banner` comes back beside the lines because a caller
   * that must act on it (the typed path's `bannerLanded`) would otherwise test
   * the same predicate again. Rollback filtering stays with the caller — only
   * the line translation is shared.
   */
  const supersedeOutcome = ({ receipts, minted, newId, oldId, type }) => {
    const banner = receipts.some((receipt) => receipt.kind === 'banner')
    if (banner) {
      const line = { id: newId, op: 'supersede', peer: oldId }
      const mirror = { id: oldId, op: 'superseded-by', peer: newId }
      if (type !== undefined) { line.type = type; mirror.type = type }
      return { banner, lines: [line, mirror] }
    }
    if (receipts.some((receipt) => receipt.kind === 'already')) return { banner, lines: [] }
    return { banner, lines: edgeFailureLines(minted) }
  }

  /**
   * The text of the user turn that prompted this tool call (F79, #180) — the
   * raw observation the write is a gist over. #174's spike confirmed the path
   * is documented public API on the dsh contract, present at execute time:
   * `exec.agent.session.deriveMessages()` returns the live history, and the
   * tail `source.kind === 'user'` message is the prompting turn verbatim (tool
   * results are also `role: 'user'` but carry a different source kind; the
   * plugin's own injected context is `source.kind === 'plugin'`).
   *
   * Degrades to `undefined` on the same posture `sessionKeyOf` takes: `exec`
   * or `exec.agent` absent (direct callers, tests, other runtimes), or any
   * shape mismatch. Never throws — a fidelity capture must not be able to fail
   * a good write.
   */
  const promptingTurn = (exec) => {
    try {
      const msgs = exec?.agent?.session?.deriveMessages?.()
      if (!Array.isArray(msgs)) return undefined
      const turn = [...msgs].reverse().find((m) => m?.role === 'user' && m?.source?.kind === 'user')
      const text = turn?.content?.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      return text && text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The recent conversation as one string (F88, #157): the last
   * {@link TRACE_WINDOW_MESSAGES} messages of the session that are not the
   * plugin's own injected context or a tool result, ending at the last user
   * message so this turn's own generations are excluded. Both roles on
   * purpose — a
   * legitimate detail-tier attachment usually restates what the ASSISTANT just
   * produced, on a turn whose user half is 存一下 — and `source.kind` filters
   * out the plugin's injected sections, which would otherwise vouch for
   * anything the index happens to name.
   *
   * Same posture as {@link promptingTurn}: `undefined` rather than a throw
   * whenever the surface is missing or shaped unexpectedly, so a precondition
   * can never fail a good write on a runtime it does not recognise.
   */
  const conversationWindow = (exec) => {
    try {
      const msgs = exec?.agent?.session?.deriveMessages?.()
      if (!Array.isArray(msgs)) return undefined
      // The window ENDS at the last user message, so this turn's own
      // generations are not in it. Including them would hand back the whole
      // check: a model that narrates an invented report in its visible text
      // and then attaches it would be vouching for itself. What the exchange
      // before the request holds is evidence; what the writer just said is
      // the claim under scrutiny.
      const lastUser = msgs.findLastIndex((m) => m?.role === 'user' && m?.source?.kind === 'user')
      if (lastUser === -1) return undefined
      const text = msgs
        .slice(0, lastUser + 1)
        // Tool results are excluded with the plugin's own context: a
        // memory_read result carrying an earlier invented node would vouch for
        // re-stating it, which is the loop this precondition exists to break.
        .filter((m) => m?.source?.kind !== 'plugin' && m?.source?.kind !== 'tool')
        .slice(-TRACE_WINDOW_MESSAGES)
        .flatMap((m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text) : []))
        .join('\n')
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The traceability precondition on both attach routes (F88, #157): an
   * attachment whose content the prompting turn does not carry is REFUSED,
   * before any file is written. Refusal, not advice, because this class has
   * now survived four advisory rounds — round 12's invented report drew zero
   * fires, round 13's satisfied the quote gate in letter, and the 09-08
   * relapse drew `unsourced_assertions` and stored the file anyway. An
   * advisory arrives after the artifact it should have stopped.
   *
   * The operand is a WINDOW of the recent conversation, not the tail user turn
   * (opus pre-merge review): the canonical flow is a long assistant answer
   * followed by 存一下 / "save that", and scored against that eleven-character
   * turn a genuine detail-tier attachment measures 0.0% and is refused. The
   * material a legitimate attachment restates lives in the exchange, so the
   * window is what the corpus numbers were measured against — one replay turn
   * is one session, so its window IS its turn — and it is what a live session
   * must be judged on too.
   *
   * Exemptions, all fail-toward-silence:
   *   - no readable conversation (direct callers, tests, other runtimes, or a
   *     first assembly) — a missing operand is never evidence of fabrication;
   *   - content under {@link ATTACH_TRACE_MIN_BYTES}, or fewer than
   *     {@link ATTACH_TRACE_MIN_TOKENS} distinct tokens — too small to judge,
   *     where one shared phrase swings the ratio;
   *   - `attachTraceMin` of 0 — the deployment has opted out.
   * `from_path` is exempt at its call site instead: those bytes come from disk,
   * so the conversation was never their source. Deliberately NOT named in the
   * refusal message — the writer that meets a refusal reroutes (that is #178's
   * lesson, and round 13 moved to the standalone route the moment the inline
   * one refused), so a message advertising the exempt route hands over the
   * bypass.
   */
  const refuseUntraceableAttachment = async (tool, content, exec, id, filename) => {
    if (attachTraceMin === 0 || typeof content !== 'string') return
    if (Buffer.byteLength(content.trim(), 'utf8') < ATTACH_TRACE_MIN_BYTES) return
    const window = conversationWindow(exec)
    if (window === undefined) return
    const coverage = turnCoverage(content, window)
    if (coverage >= attachTraceMin) return
    if (id !== undefined) freezeAfterRefusal(exec, id)
    const corrected = await markUnwrittenAttachment(id, filename, exec)
    throw new Error(`${tool}: this attachment is not traceable to this conversation — ${(coverage * 100).toFixed(1)}% of its content appears in what was said, under the ${(attachTraceMin * 100).toFixed(0)}% floor, so it reads as composed rather than captured. Nothing was written.${corrected ? ` The body already named \`${filename}\`, so that promise has been marked in the node — the file does not exist; correct the line rather than leaving it.` : ''} Do not restate the payload in the body either: for the rest of this turn this node takes only one appended 状态未变（turn N 无新信息）line. Store the detail on the exchange that actually carries it.`)
  }

  /**
   * The per-Session record of one attached FILE, keyed by its identity inside
   * the node (#247 review 2): `${id}\0${dev}:${ino}`, from the fstat of the very
   * handle whose bytes were read or written. A name is only a spelling — on a
   * case-insensitive filesystem two spellings are one file, on a case-sensitive
   * one they are two — while the inode is the file. Every tool publish is
   * stage-and-rename, so a replaced file gets a NEW identity and the record that
   * described the old bytes can never describe the new ones.
   */
  const fileIdentityKey = (id, dev, ino) => `${id}\0${dev}:${ino}`

  /** One byte range, merged into a sorted non-overlapping list. */
  const addByteRange = (ranges, start, end) => {
    if (end <= start) return ranges
    const merged = []
    for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1]
      if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
      else merged.push([range[0], range[1]])
    }
    return merged
  }

  /**
   * Whether these ranges, already merged by {@link addByteRange}, cover every
   * byte of a file of `size`. An empty file needs no window.
   */
  const rangesCoverAll = (ranges, size) => size === 0 || ranges.some(([start, end]) => start === 0 && end >= size)

  /**
   * Record what `memory_read_file` just returned (#247): the range, against the
   * hash of the WHOLE file as it stands now. A different hash means the file
   * changed under the Session — the ranges it had read no longer describe these
   * bytes, so they start again from this window alone.
   */
  const recordFileRead = (state, id, { dev, ino }, { offset, bytes, sha, size }) => {
    const key = fileIdentityKey(id, dev, ino)
    const prior = state.filesSeen.get(key)
    const sameVersion = prior !== undefined && prior.sha === sha
    state.filesSeen.set(key, {
      sha,
      size,
      ranges: addByteRange(sameVersion ? prior.ranges : [], offset, offset + bytes),
      authored: sameVersion ? prior.authored : false,
      preserved: sameVersion ? prior.preserved : false,
    })
  }

  /**
   * Record that this Session wrote these bytes (#247): no read is needed to
   * replace them next time, and `preserved` carries the snapshot obligation
   * forward — see {@link preservedAfterWrite}.
   *
   * Keyed by the identity the write LEFT BEHIND, read back from the published
   * path: every publish is stage-and-rename, so the target is a new inode and the
   * entry for the bytes it replaced must not be inherited. If the identity
   * cannot be read, nothing is recorded — the safe direction, since an absent
   * entry only costs a read.
   */
  const recordFileWritten = async (exec, id, filename, bytes, preserved) => {
    const identity = await fileIdentity(path.join(root, id, filename))
    if (identity === undefined || identity.regular !== true) return
    sessionState(sessionKeyOf(exec)).filesSeen.set(fileIdentityKey(id, identity.dev, identity.ino), {
      sha: hashBytes(bytes),
      size: bytes.length,
      ranges: addByteRange([], 0, bytes.length),
      authored: true,
      preserved,
    })
  }

  /**
   * The snapshot obligation after a write this Session just made (#247, review
   * finding 3). `preserved` means "no snapshot obligation remains", which is
   * what lets the NEXT overwrite skip the copy — it is NOT the same thing as
   * having written the file, and NOT the same thing as a `.prev` existing:
   *   - a file this Session created has nothing prior to lose, so it is
   *     preserved — with no `.prev` written;
   *   - a write that CHANGED the bytes took a `.<name>.prev` copy, so it is
   *     preserved too;
   *   - an IDENTICAL-bytes write took no copy and destroyed nothing, so an
   *     obligation the entry did not already hold stays owed.
   * Conflating this with authorship is exactly the hole: re-attaching identical
   * bytes used to mark the file "authored" and the next, different replacement
   * then skipped the snapshot, leaving the bytes from before this Session with
   * no copy. Conflating it with a copy is the other edge: a create owes nothing,
   * so within the Session its later versions are overwritten without a snapshot.
   */
  const preservedAfterWrite = ({ existed, preservedBefore, identical }) => !existed || preservedBefore === true || !identical

  /**
   * Refuse an attach that would replace an attachment this Session has not
   * seen (#247). Nothing here writes: the check is a read of the node
   * directory, and the caller throws before any mutation.
   *
   * The invariant, and only it: replacing an existing file with DIFFERENT bytes
   * requires either that this Session read the whole file at its current hash,
   * or that this Session wrote those bytes itself. Everything else is allowed
   * without a read:
   *   - a new filename (nothing exists to lose);
   *   - identical incoming bytes (the replacement destroys nothing);
   *   - a file this Session authored (a create-then-refine is not a blind one).
   * `memory_read` does NOT count: a node view lists an attachment's name and
   * size, which is exactly the knowledge the 2026-10-26 test_2 incident (#247) had when it
   * replaced a 1,696-byte report with 11 bytes.
   *
   * The knowledge is held per FILE, never per name: the record is keyed by the
   * inode the bytes came from, so a read of `report.md` cannot authorize a
   * replacement of a different file, and on a case-insensitive filesystem
   * `Report.md` inherits exactly the knowledge the shared file earned — no more,
   * because the ranges must still cover it in full. There is no cross-name
   * fallback of any kind.
   *
   * ONE write is exempt, by design rather than by oversight: the F79 observation
   * autosave (`observation.txt`) is the framework's own capture of the prompting
   * turn, replaced wholesale on every qualifying write (F79/#180), so it is not
   * gated by this rule — it keeps the bytes from before its own first capture
   * in `.observation.txt.prev` instead, the same one-deep, per-Session anchor
   * every other attachment gets (#247). One path differs: a capture that rides a
   * node CREATE is published with the node and never recorded, so the next
   * capture in that Session snapshots its own first page rather than a page from
   * before the Session.
   * Agents cannot author that name at all (#255): both write tools refuse it
   * in their `semantic` hook, which is what keeps this exemption from
   * becoming a hole.
   *
   * Every throw below is CERTIFIED (#245's `attach_overwrite_unseen`): the
   * checks are pure reads of the node directory and this Session's own
   * bookkeeping, and every call site runs before the call mutates anything —
   * `brand` is the handler's scoped branding closure, so an absent one leaves
   * the error unproven exactly like any other handler throw. On the from_path
   * route the guard is invoked from inside `attachFromPath`'s `authorize` hook
   * (it judges the exact Buffer that call will publish), so the throw crosses
   * graph.js's frame without being caught, rewritten or rethrown — the branded
   * Error reaches `defineTool` as the very object this invocation threw, which
   * is what keeps the proof.
   *
   * @param brand - the handler's branding closure: `(error) => error`, built
   *   from `defineTool`'s scoped `refuse` helper. `undefined` when the
   *   definition declares no codes (a direct plugin caller/test).
   * @returns `{ state, preserved, identical }` — `preserved` says the caller may
   *   pass `snapshot: false` because no snapshot obligation remains: the bytes
   *   from before this Session are already aside, or this Session created the
   *   file (the create exception — no `.prev` exists for it);
   *   `identical` and `state` let the caller compute the obligation this write
   *   leaves behind ({@link preservedAfterWrite}).
   */
  const refuseUnseenAttachmentOverwrite = async (tool, id, filename, incoming, exec, brand) => {
    if (id === undefined || !ULID_RE.test(id)) return { state: 'missing', preserved: false, identical: false }
    const evidence = await inspectFileBytes(path.join(root, id, filename))
    if (evidence.state === 'missing') return { state: 'missing', preserved: false, identical: false }
    // Each never-authorizable state gets its OWN message (#255): a symlink, an
    // over-cap file and a file that shrank mid-read can never be authorized by
    // any amount of reading, so "memory_read_file every page" would send the
    // writer into a loop it cannot exit. They reuse graph.js's own wording for
    // the two the snapshot layer already names, and say what to do instead.
    const reasonFor = () => {
      switch (evidence.state) {
        case 'nonregular':
          return 'is not a regular file, so its prior content cannot be kept — nothing was written; store the replacement under a new filename'
        case 'tooLarge':
          return `is ${evidence.size} bytes, over the ${ATTACH_MAX_BYTES}-byte attachment cap, so its prior content cannot be copied aside — nothing was written; store the replacement under a new filename`
        case 'shortRead':
          return `changed while it was being read (${evidence.size} of ${evidence.expected} bytes), so its prior content cannot be vouched for — nothing was written; memory_read_file it again and pass the full revised text, or store the replacement under a new filename`
        default:
          return `holds ${evidence.size} bytes you have not fully read this session (or it changed since you read it) — attaching that name REPLACES the file. Nothing was written. memory_read_file every page and pass the full revised text; to add to the node, use body/append; to keep both, use a new filename.`
      }
    }
    const refuse = () => {
      const error = new Error(`${tool}: ${filename} on ${id} ${reasonFor()}`)
      return brand === undefined ? error : brand(error)
    }
    // A symlink or other non-regular file under the name, or bytes we cannot
    // read whole: the prior content cannot be vouched for, so refuse rather
    // than replace what we cannot account for.
    if (evidence.state !== 'ok' || evidence.bytes.length !== evidence.size) throw refuse()
    const identical = incoming !== undefined && evidence.bytes.equals(incoming)
    // The FILE, not the name (#247 review 2). `evidence` was read through one
    // no-follow handle, so its dev/ino and its bytes are the same version by
    // construction; a stale entry (different sha) is not evidence at all, so an
    // out-of-band rewrite that kept the inode still invalidates.
    const entry = sessionState(sessionKeyOf(exec)).filesSeen.get(fileIdentityKey(id, evidence.dev, evidence.ino))
    const current = entry !== undefined && entry.sha === hashBytes(evidence.bytes) ? entry : undefined
    if (identical) {
      // Nothing is destroyed, so no read is owed — and, crucially, the caller
      // must still keep any snapshot obligation it already had.
      return { state: 'present', preserved: current?.preserved === true, identical: true }
    }
    if (current !== undefined && (current.authored === true || rangesCoverAll(current.ranges, evidence.size))) {
      return { state: 'present', preserved: current.preserved === true, identical: false }
    }
    throw refuse()
  }

  /**
   * Mark a body that already promises a refused attachment (F88.3, #157).
   *
   * The gate runs before any file is written, so an inline `attach` that is
   * refused leaves nothing behind. A write-then-attach sequence does: the body
   * lands first, names the file, and the refusal arrives afterwards — a synthetic
   * example ends with `周报完整内容存于附件 sample-weekly-report.md`
   * on a node that has no such file, a promise every later session reads as
   * fact. The writer is told to correct it, and may not; this line is what
   * survives if it does not. Deliberately one appended sentence, never an edit
   * of what the writer wrote — the body stays its author's, with the
   * correction visible beside it.
   */
  const markUnwrittenAttachment = async (id, filename, exec) => {
    if (id === undefined || !ULID_RE.test(id)) return false
    if (typeof filename !== 'string' || filename.length === 0) return false
    const nodeFile = path.join(root, id, 'node.md')
    // One clock reading for the correction's date and its provenance line, so
    // the two can never name different days (#317).
    const now = Date.now()
    // Predicate AND append under the node lock (terra review of 1bdaca8):
    // unlocked, a concurrent attach could create the file between the access
    // check and the append — leaving a correction that says a file this node
    // now has does not exist — and a concurrent body rewrite could drop the
    // promise, or land on top of the correction.
    // Whether the correction actually landed — set under the lock, flushed in
    // the `finally` below so a later throw (the post-append re-read or the lock
    // release) still reports a correction that is on disk (#321).
    let appended = false
    let marked = false
    try {
      marked = await withNodeLocks(root, [id], async () => {
        let text
        try {
          text = await fsp.readFile(nodeFile, 'utf8')
        } catch {
          return false // no node on disk (a create refused pre-write): nothing promised
        }
        if (!text.includes(filename)) return false
        try {
          // An earlier attachment under the same name makes the body's promise
          // true; this refusal rejected a replacement, and the node still has one.
          await fsp.access(path.join(root, id, filename))
          return false
        } catch {}
        await fsp.appendFile(nodeFile, `\n（${today(now)}：上文提到的附件 ${filename} 未写入——其内容无法追溯到本轮对话，该次尝试被拒绝。）\n`, 'utf8')
        // The append is durable: the transition below cannot be undone by
        // anything that throws after it.
        appended = true
        // The correction changed node.md, so THIS session's version expectation
        // is now stale — and F88.1's whole promise is that the mandated
        // 状态未变 line still lands. Refresh it here, under the same lock, for
        // the refused caller only: another session never read these bytes and
        // must still meet the Stale Write gate (terra review of 1bdaca8).
        //
        // Only when the expectation was CURRENT a moment ago (terra round 2):
        // if another Session had already rewritten this body, refreshing to the
        // post-correction hash would vouch for that Session's content, which
        // this caller never read — the exact authorization the gate exists to
        // withhold. A stale expectation stays stale; the writer re-reads.
        const state = sessionState(sessionKeyOf(exec))
        if (state.versionSeen.get(id) === hashBytes(Buffer.from(text, 'utf8'))) {
          state.versionSeen.set(id, hashBytes(await fsp.readFile(nodeFile)))
        }
        return true
      })
    } finally {
      // Outside the lock on purpose: the append is lock-free by contract, and a
      // bookkeeping write must not extend a node lock it is merely describing.
      // Awaited and fail-open, so it neither escapes nor swallows the lock
      // release error it runs after (#321).
      if (appended) await recordProvenance([{ id, op: 'annotate', file: filename }], exec, provenanceTs(now))
    }
    return marked
  }

  /**
   * Mark a node closed for the rest of this turn (F88.1, #157).
   *
   * A refusal the writer can route around is a nudge, not a precondition, and
   * a synthetic replay demonstrates that route: the invented attachment is
   * refused, and the same call came back a moment later WITHOUT the file and
   * WITH the claim rewritten into the body (233 -> 459 chars), which then sat
   * in the graph to turn 120. The artifact was stopped and the fabrication
   * was not. dsh gives a plugin no way to end a turn — a thrown tool error is
   * the whole vocabulary, and what the model does next is its own choice — so
   * the only place to stand is the next call.
   */
  const freezeAfterRefusal = (exec, id) => {
    const state = sessionState(sessionKeyOf(exec))
    const turn = userTurns(exec)
    if (turn !== state.refusedTurn) {
      state.refusedTurn = turn
      state.refusedNodes.clear()
    }
    state.refusedNodes.add(id)
  }

  /**
   * The other half: refuse a write that would restate a refused payload
   * (F88.1, #157). Only prose is barred — the sanctioned no-change line fits
   * under {@link REFUSAL_FOLLOWUP_MAX_CHARS} with room to spare, so the writer
   * keeps the one form the section text tells it to use.
   *
   * Measured on what the write ADDS, and a write that does not preserve the
   * stored body is refused outright (F88.4, #219 Finding 6). `body` replaces
   * the whole body, so a bound on its total length — F88.1 as shipped — could
   * only be met on a node past the bound by deleting the body, and the replay
   * did exactly that five times to one handoff (see the constant). The prior
   * side is prepared as F55 prepares it, normalizeBody then
   * withoutBookkeeping, and the new side the same way: a legacy escaped body,
   * a supersede banner or F88.3's own correction line — which lands on THIS
   * node after the writer's read — must never turn an honest write-back into
   * a "drop". The disk read rides the RARE path only: `refusedNodes` is empty
   * for almost every write, so the ordinary call still costs nothing here.
   *
   * An expectation that is not current — never read, or changed since —
   * returns without judging: the F68 gate inside the lock owns that write,
   * and a drop verdict measured against bytes the writer never saw would
   * misname the fix (re-read) as a content loss.
   *
   * An `append` (F89, ADR-0014) is its own delta and preserves by
   * construction, so it meets only the bound — no read, no prefix check. The
   * sanctioned path through the freeze, not an exemption from it: a 612-char
   * narrative laundered through `append` is the same laundering.
   *
   * Returns `true` when a FULL-BODY write passed on a frozen node, so the
   * update path can restore the framework lines the comparison forgave (F88.5,
   * #219) — see the restoration under the node lock. Every other outcome
   * returns undefined: not frozen, an append, or a throw.
   */
  const refuseRestatementAfterRefusal = async (id, body, append, exec) => {
    if (id === undefined || (typeof body !== 'string' && typeof append !== 'string')) return
    const state = sessionState(sessionKeyOf(exec))
    const turn = userTurns(exec)
    if (turn !== state.refusedTurn) {
      state.refusedTurn = turn
      state.refusedNodes.clear()
      return
    }
    if (!state.refusedNodes.has(id)) return
    if (typeof append === 'string') {
      const added = normalizeBody(append).trim().length
      if (added <= REFUSAL_FOLLOWUP_MAX_CHARS) return
      throw new Error(`memory_write: this node is closed for the rest of this turn — an attachment on it was refused as untraceable to this conversation, and a ${added}-character append is a restatement of it rather than a correction. Append only one 状态未变（turn N 无新信息）line if the turn resolved nothing, or write the detail on the exchange that carries it. Nothing was written.`)
    }
    let raw
    try {
      raw = await fsp.readFile(path.join(root, id, 'node.md'))
    } catch (error) {
      // Only a vanished node is this helper's intended "nothing to judge" case:
      // the update path's own ENOENT (the `update_target_missing` site) owns it.
      // Any other read error means the freeze check did not complete, and it
      // runs BEFORE every branded site of this invocation — so it must abort
      // unbranded rather than return normally and let a later gate (the typed
      // supersede pre-check, the attached-overwrite guard) mint a code from a
      // prefix that never finished (#253 review 2).
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (state.versionSeen.get(id) !== hashBytes(raw)) return
    const strip = (text) => withoutBookkeeping(normalizeBody(text)).trim()
    const before = strip(parseNode(raw.toString('utf8')).body)
    const after = strip(body)
    if (!after.startsWith(before)) {
      throw new Error(`memory_write: this node is closed for the rest of this turn — an attachment on it was refused as untraceable to this conversation, and this ${after.length}-character body drops stored content: it does not begin with the ${before.length} characters the node holds. Write the stored body back verbatim with one 状态未变（turn N 无新信息）line after it${appendWrites ? ', or pass just that line as `append` with this id' : ''}. Nothing was written.`)
    }
    const added = after.length - before.length
    if (added <= REFUSAL_FOLLOWUP_MAX_CHARS) return true
    throw new Error(`memory_write: this node is closed for the rest of this turn — an attachment on it was refused as untraceable to this conversation, and this write adds ${added} characters to the body — a restatement of it rather than a correction. Add only one 状态未变（turn N 无新信息）line if the turn resolved nothing, or write the detail on the exchange that carries it. Nothing was written.`)
  }

  /**
   * How many user turns this Session has taken (F80, #184) — the boundary the
   * search-depth floor re-arms on.
   *
   * Read off the SAME public surface F79 uses, deliberately: `agent.phase` is
   * declared private in dsh-agent-loop and `agent.session` is the documented
   * one (#175), so keying a new mechanism on `phase.turn` would repeat F62's
   * accident in fresh code. #175 records why F62 itself cannot simply move —
   * `deriveMessages()` returns `[]` at a turn's FIRST ASSEMBLY, because the
   * turn is still in `agent.inbox` — but that objection is about the assembly
   * call site. This one runs at EXECUTE time, where the prompting user message
   * is already in the history: exactly the fact F79 (#180) ships on.
   *
   * The count is the ordinal, not an identity: `source.kind === 'user'` picks
   * the human turns out of a history whose tool results are also `role: 'user'`
   * (the same discrimination `promptingTurn` makes), and one more of them means
   * one more turn. Being derived from this Session's own history, it is
   * per-Session by construction — no cross-conversation reset can exist.
   *
   * `undefined` on any runtime that does not expose the history (direct
   * callers, tests, another harness). The counter then never re-arms and the
   * floor speaks at most once per Session, which is the quiet direction: a
   * missing nudge, never a false "this was your first search". Never throws.
   */
  const userTurns = (exec) => {
    try {
      const msgs = exec?.agent?.session?.deriveMessages?.()
      if (!Array.isArray(msgs)) return undefined
      let turns = 0
      for (const message of msgs) if (message?.role === 'user' && message?.source?.kind === 'user') turns += 1
      return turns
    } catch {
      return undefined
    }
  }

  // F46 (#75): in the dossier replay, 4 of 39 memory-update turns ended with
  // zero tool calls — no write, no error, just a text answer — and each was an
  // unrecoverable loss of one compaction segment. One headless dsh run is one
  // turn, so "the turn wrote nothing" is checkable at process exit: when the
  // composition declared `expectWrite` and no memory_write landed, say so
  // loudly on stderr and leave a marker line the caller can act on (retry with
  // a firmer prompt, alert, count). Detection lives here; policy stays with
  // the caller. The exit hook is registered only when the flag is set, so a
  // default composition carries no handler at all.
  //
  // F60 (#105) gave the marker a reader: `zeroWriteBlock` surfaces a recent
  // count in the injected section, so the loss reaches the next SESSION and
  // not only the operator's log. Re-invoking the dead turn is still the
  // harness's call, not this hook's — and writing a salvage node from here
  // would be the plugin inventing memory (F50).
  let writes = 0
  if (expectWrite) {
    process.once('exit', () => {
      if (writes > 0) return
      // F48 (#84): `turn=` names the segment that died so a salvage pass can
      // find its input. Omitted entirely when the caller set no turnId — the
      // line keeps its exact F46 shape for anything parsing it as opaque text.
      const turn = turnId ? ` turn=${turnId}` : ''
      const line = `${new Date().toISOString()} pid=${process.pid}${turn} zero memory_write calls\n`
      // Exit handlers must stay synchronous; appendFileSync is the only write
      // that still lands here. A marker that cannot be written must not turn
      // exit into a crash — stderr already carries the warning. The root may
      // not exist yet: createNode makes it lazily, and a zero-write turn is
      // exactly the turn that never called createNode.
      try {
        fs.mkdirSync(root, { recursive: true })
        fs.appendFileSync(path.join(root, ZERO_WRITE_FILE), line)
      } catch { /* stderr warning below still fires */ }
      // The stderr line carries the same turn id, so an operator can tie the
      // warning to a segment without opening the marker file (F48, #84).
      process.stderr.write(`memory-graph: expectWrite was set but this process made no memory_write call${turn ? ` (turn=${turnId})` : ''} — the turn's content was not persisted (F46, #75). Logged to ${path.join(root, ZERO_WRITE_FILE)}, and reported in the memory section of any session opened within ${ZERO_WRITE_DAYS} days (F60, #105).\n`)
    })
  }

  /**
   * Per-Session state for the two knowledge gates (F69, #137).
   *
   * One long-lived plugin instance may serve several concurrent conversations
   * (`dsh web`, the deployment shape ADR-0013 calls out). A process-wide read
   * map lets conversation A authorize conversation B's write, defeating the
   * read-before-write contract. Both structures therefore live in one entry
   * keyed by {@link sessionKeyOf}; evicting that whole entry is safe because
   * forgotten knowledge only forces the Session to re-read.
   *
   * The Map's insertion order provides a small LRU: every access moves its
   * entry to the newest end, and creating entry 101 drops the least recently
   * used one. This bounds a server whose harness never announces Session end.
   */
  const MAX_SESSIONS = 100
  const sessionStore = new Map()

  /**
   * Node ids whose CURRENT body this Session has actually seen (F62, #107).
   *
   * Replay v3's 420002 s7 replaced a fee schedule in a node it had not read
   * that turn, rewriting the body from its recollection of the description
   * line: 1496 → 1456 chars, so every size-delta heuristic (F47, F52) stayed
   * silent while the tier numbers, the labor-day rates and the OB total went
   * away. F59's `.node.md.prev` made that recoverable but not noticed. This
   * set is the missing half — whether the writer ever LOOKED.
   *
   * Membership is "has seen the whole body", by either route:
   *   - `memory_read` returned the node, body included;
   *   - a `memory_write` supplied a body — the model authored that exact text,
   *     so a create-then-refine inside one turn is not a blind rewrite.
   * `memory_read_file` deliberately does NOT count: an attachment is the bulk
   * detail that `memory_attach` moved OUT of the body, so opening one says
   * nothing about what the body still holds — and answering from a node's file
   * is precisely the moment a writer knows least about its body. `memory_search`
   * does not count either: a row is a description line, not the body.
   *
   * Lifetime is ONE TURN inside its Session, not one process. The replay path
   * runs a process per turn and the two coincide there, but `dsh web` may call
   * `apply()` once and serve many conversations from it. Membership that
   * crossed Sessions would vouch for a body the other conversation's model
   * has never been shown, which is the whole failure again.
   *
   * The boundary is the loop's own turn COUNTER, not the prompt assembly:
   * dsh assembles once per STEP (`preStep` → `systemPrompt.assemble` inside
   * `turn()`'s step loop), and a turn routinely spends several steps — read in
   * one, write in the next. Clearing per assembly would therefore fire on
   * exactly the read-then-write flow the section prescribes. See
   * {@link startTurn} for how the counter is read.
   *
   * Each Session entry also holds node ids and the SHA-256 of node.md's raw
   * bytes at their last-known-good state, for the read-before-write version
   * gate (F68, #129 / ADR-0013). That map lasts for the Session — deliberately
   * unlike `seenBodies`, it is never cleared by startTurn. Layer 2 guards disk
   * staleness across turns, not whether the model saw a whole body during this
   * turn, so an unchanged Node read last turn remains safe to update.
   */
  const sessionState = (key) => {
    const existing = sessionStore.get(key)
    if (existing !== undefined) {
      sessionStore.delete(key)
      sessionStore.set(key, existing)
      return existing
    }
    // `searches` counts this turn's term-bearing memory_search calls (F80,
    // #184) — the reword floor speaks on the FIRST one only. `searchTurn` is
    // the {@link userTurns} ordinal those calls belong to, taken from this
    // Session's own history at execute time; a change in it is what re-arms
    // the floor. Both are per-Session and neither is touched by `startTurn`,
    // whose clear cannot tell which Session is assembling.
    // `refusedNodes` holds the nodes whose attachment this turn already failed
    // the traceability floor (F88.1, #157), with `refusedTurn` the
    // {@link userTurns} ordinal they belong to — re-armed exactly like
    // `searches`, from this Session's own history at execute time.
    // `filesSeen` is the attachment twin of `versionSeen` (#247): what this
    // Session knows about each attached FILE, keyed by the file's identity
    // inside the node — `${id}\0${dev}:${ino}`, from {@link fileIdentityKey},
    // never its name — as `{ sha, size, ranges, authored, preserved }`. `sha` is
    // of the whole file's bytes when the Session last looked, `ranges` the byte
    // windows `memory_read_file` actually returned (only their union covering
    // `[0, size)` vouches for a whole read), `authored` says this Session wrote
    // those very bytes, and `preserved` says no snapshot obligation remains:
    // either the bytes from before this Session are already in `.<name>.prev`,
    // or this Session created the file and there were none. The next overwrite
    // may then skip the copy ({@link preservedAfterWrite}) — which is why a
    // file whose creation this Session recorded grows no `.prev` while the
    // record lasts. The observation autosave that rides a node create records
    // nothing, so its next changed capture does snapshot that first page.
    // Like `versionSeen` it lasts for the Session and is never cleared by
    // `startTurn`: a file read on an earlier turn has still been read.
    const state = { seenBodies: new Set(), versionSeen: new Map(), filesSeen: new Map(), searches: 0, searchTurn: undefined, refusedNodes: new Set(), refusedTurn: undefined }
    sessionStore.set(key, state)
    if (sessionStore.size > MAX_SESSIONS) sessionStore.delete(sessionStore.keys().next().value)
    return state
  }

  /**
   * The loop turn the tracked reads belong to (F62, #107). `undefined` until an
   * assembly names one.
   */
  let seenTurn

  /**
   * Forget the last turn's reads when — and only when — the turn actually
   * changed (F62, #107).
   *
   * A variable provider is called with dsh's assemble context (`{agent, scope,
   * signal}`), whose `agent` is the loop instance; `phase.turn` there is
   * incremented once per turn, while the assembly around it runs once per step.
   * So the turn number is the signal and the render is not.
   *
   * Unreachable `phase.turn` — a different runtime, a harness driving the tools
   * directly — falls back to NO reset, i.e. process scope. That is the safe
   * direction: a missed reset only makes the guard quiet across turns of one
   * long-lived process, while a spurious one accuses a writer that read the
   * node a step ago. The one-shot path, where the process is the turn, is exact
   * either way.
   */
  const startTurn = (context) => {
    const turn = context?.agent?.phase?.turn
    if (turn === undefined || turn === seenTurn) return
    seenTurn = turn
    // Prompt assembly exposes no tool-call Session identity, so conservatively
    // clear F62 knowledge for every tracked Session. With today's common one-
    // Session instance this is identical to the old single-Set reset. In a
    // shared instance, over-clearing can only cause an extra blind-rewrite
    // ADVISORY; it cannot bypass F68, whose versionSeen maps stay untouched.
    // Deliberately only `seenBodies`: the search-depth counter (F80, #184)
    // re-arms on its OWN Session's turn ordinal, read at execute time, and
    // never here. This loop cannot know which Session is assembling, so
    // clearing that counter from it would let one conversation's new turn
    // re-arm another's floor mid-turn (codex P2 on #187) — over-clearing is
    // harmless for a blind-rewrite advisory and is not harmless for a nudge
    // that claims "this was your first search".
    for (const { seenBodies } of sessionStore.values()) seenBodies.clear()
  }

  /**
   * Mirror a write's advisories into `<root>/.advisories` (F64, #109).
   *
   * Advisories ride the tool RESULT, which exists only in the session
   * transcript: offline analysis — replays, QA, graph-maintain — could not
   * tell an advisory that fired and was ignored from one that never fired, and
   * replay v3 left F51/F52 formally unauditable for exactly that reason. One
   * greppable line per advisory at the graph root makes them countable per
   * turn from the graph alone, the same loud-and-cheap posture as the
   * zero-write marker above; `turn=` correlates a line to the step that
   * produced it, and is omitted entirely when the caller set no `turnId`
   * ({@link journalTurn} keeps that field one token, since the rest of the
   * line is positional).
   *
   * The journal is bookkeeping about a write that ALREADY landed, so a root
   * gone read-only mid-turn costs a stderr line and nothing else — a failed
   * append must never surface as an error in the tool result, and neither may
   * the warning about it (a harness that replaced stderr is not the write
   * path's problem). One `appendFile` per write carries every line the write
   * produced, so a concurrent writer's lines cannot land inside this one.
   */
  const journalAdvisories = async (value) => {
    const entries = advisoryEntries(value)
    if (entries.length === 0) return
    const turn = turnId ? ` turn=${journalTurn(turnId)}` : ''
    const at = new Date().toISOString()
    const lines = entries.map(([kind, payload, about]) => `${at}${turn} ${kind} ${about ?? value.id} ${advisoryDigest(payload)}\n`).join('')
    try {
      await fsp.appendFile(path.join(root, '.advisories'), lines, 'utf8')
    } catch (error) {
      try {
        process.stderr.write(`memory-graph: could not append ${entries.length} advisory line${entries.length === 1 ? '' : 's'} to ${path.join(root, '.advisories')} — ${error.message} (F64, #109). The write itself landed.\n`)
      } catch { /* no channel left to report on, and the node is safe either way */ }
    }
  }

  // The prompt section renders once per assembly; rescanning the graph on
  // every step is wasted work at this scale, and an index that is stale by
  // seconds is never wrong in a way a `memory_search` call does not correct.
  let cached = { at: 0, text: '' }
  let cachedHandoffs = { at: 0, text: '' }
  // The open work-state nodes behind BOTH the handoff banner and the close-out
  // sweep (F61, #106), cached under the same TTL and invalidated by the same
  // writes. The sweep runs on every write, and the scan it needs is the scan
  // the banner was already paying for — sharing it is what keeps F61 from
  // adding a whole-graph pass per write. `at: 0` means "no data": a write
  // invalidates by resetting it, exactly as it does the index and the banner.
  let cachedWorkState = { at: 0, nodes: [] }

  /**
   * #263 W3-lite: the run-stable render of the two graph-derived prompt
   * variables (`indexSnapshot: 'run'`).
   *
   * What it freezes is the DISPLAYED DISCOVERY CONTEXT — the rendered index
   * lines and the handoff banner, i.e. the text the model sees when it decides
   * where to look. It freezes nothing about live tool state.
   *
   * Why a separate holder and not `cached`/`cachedHandoffs`: those are the
   * TOOL-side caches. `memory_search` calls `refreshIndex`, the stale-pending
   * sweep reads `cachedWorkState`, and both must keep working exactly as they
   * do today — a search result must reflect the graph now, not the prompt's
   * frozen view. Only the two strings that ride the SYSTEM PROMPT freeze,
   * because only they are paid for by the provider's prefix cache.
   *
   * Read authority is NOT filesystem-pure, which is exactly why this lever
   * exists: `memory_read` appends access lines and a traversal read
   * (`memory_read` with `from`) can wire a missing edge (index.js ~4375-4400).
   * Both re-rank the index (graph.js rankIndex), so an ordinary read run
   * rewrites its own system prompt at the next step boundary and forces a full
   * re-prefill (measured: spliced steps ~13% cache share vs ~64%). Those are
   * bookkeeping and discovery effects, not content changes, so they must NOT
   * re-render: only a successful content mutation drops the snapshot.
   *
   * `undefined` = the feature is off (today's behavior, byte for byte). An
   * object is the per-instance capture: `index`/`handoffs` are set on their
   * first render and never re-derived until a successful mutation drops them.
   * This is a HINT, never evidence and never a freshness guarantee — the tools
   * (search/read/read_file, successor and version/receipt checks) all stay
   * live, and another process may edit the graph mid-run while this text keeps
   * showing the run's opening view.
   */
  // #263 (wave 3, lever 1) adds a SECOND, wider holder alongside it —
  // `frozenPromptText` below — rather than reusing this one, because the two
  // levers differ in exactly the property this one is built on: this one drops
  // on a successful write, and that drop is what `promptSnapshot` must not do.
  const freezeRunPrompt = promptSnapshot === 'run'
  let snapshot = indexSnapshot === 'run' ? {} : undefined

  /**
   * The per-variable freeze `promptSnapshot: 'run'` applies to every prompt
   * variable that can change mid-run, keyed so each still renders at most once.
   * Off (the default, and every read run) the thunk is simply called: today's
   * behaviour, byte for byte.
   *
   * Why this exists at MANAGE authority, where W3-lite dropped the snapshot on
   * write: a manage run's whole job is to change the graph it is reading. Under
   * the W3-lite rule the run re-splices its own system prompt after virtually
   * every write, and because the system message sits at the head of the
   * request, one changed character there invalidates the provider's cached
   * prefix for the entire tool history behind it. Measured over the #263 A/B
   * control runs (test_2/test_3/test_1, 152 manage runs with a decodable
   * session log; scripts in the #263 wave-3 report):
   *
   *  - every one of the 337 mid-run re-splices changed the system prompt in
   *    test_2 — none was a no-op re-render (337/337);
   *  - the first divergence always sat inside the index block, at char
   *    22.3k–25k of a ~44.1–44.3k prompt: the whole ~21.6k rule prefix was
   *    stable in all 152 runs;
   *  - a step whose prompt had NOT changed kept 200-350% cache share (a re-read
   *    can exceed the prompt's own size), while a step whose prompt HAD changed
   *    kept ~30%.
   *
   * What changes, and is therefore frozen — all eight measured or proven:
   *  1. index RANK — access bookkeeping from this run's own reads, and a
   *     traversal read's edge wiring (249/337 transitions in test_2, 281/382 in
   *     test_3, 77/186 in test_1);
   *  2. index DESCRIPTION lines this run revised (75/337 in test_2, 67/382 in
   *     test_3, 59/186 in test_1 — including the transitions that also added a
   *     node);
   *  3. index MEMBERSHIP — creates (21/337, 37/382, 57/186, including those
   *     same mixed transitions) and archive/merge removals (2 in test_1);
   *  4. the duplicate block (`<root>/.duplicates`, filtered by liveness — 10
   *     transitions in test_3);
   *  5. the orphan census block (10 in test_3, 2 in test_1);
   *  6. the handoff banner (2 in test_1 — a handoff created or revised);
   *  7. the zero-write notice (a 7-day sliding window over a marker file:
   *     monotone in wall-clock, so a long or midnight-crossing run can change
   *     it with no write at all);
   *  8. `memory_today` and the calendar strip built from it — the runtime clock
   *     is re-read per assembly by design (F67's weekday lookup; the F62
   *     blind-rewrite guard's turn counter rides the same variable).
   *
   * NOT frozen, on purpose: nothing outside the system prompt. Every tool stays
   * live — search/read/read_file, the `similar` and `link_candidates`
   * advisories, version/receipt checks and the write gates all read the graph
   * as it is now. And nothing is appended to the system message to announce
   * either the freeze or the run's own writes: such a tail would itself change
   * the prompt and pay the exact re-prefill this lever exists to avoid. The
   * model already sees its writes in tool results.
   */
  const promptFreeze = new Map()
  const frozenPromptText = (key, render) => {
    if (!freezeRunPrompt) return render()
    if (promptFreeze.has(key)) return promptFreeze.get(key)
    const text = render()
    promptFreeze.set(key, text)
    return text
  }

  /**
   * Forget the frozen render, so the next assembly re-reads the graph.
   *
   * The two halves are COUPLED and must not be separated: re-capturing a
   * snapshot serves whatever `cached` currently holds, so expiring the TTL
   * caches is part of the drop. Drop only `snapshot` and a still-fresh `cached`
   * is re-captured verbatim — the run freezes the PRE-mutation bytes and keeps
   * them for the rest of its life, which is worse than not having the feature.
   * Centralised here so the four mutation paths cannot drift out of order.
   *
   * Off-snapshot this is a pure no-op: the callers' own cache resets (where
   * they have them) keep describing legacy behavior byte for byte.
   *
   * #263 (wave 3, lever 1): under `promptSnapshot: 'run'` the TTL caches are
   * still expired — they are TOOL-side, and `memory_search` must see the graph
   * as it is now — but the frozen PROMPT is not released, because that lever's
   * entire premise is the opposite of W3-lite's: a manage run's writes must not
   * re-splice the system prompt.
   */
  const dropSnapshot = () => {
    if (snapshot === undefined && !freezeRunPrompt) return
    cached = { at: 0, text: '' }
    cachedHandoffs = { at: 0, text: '' }
    cachedWorkState = { at: 0, nodes: [] }
    if (!freezeRunPrompt) snapshot = {}
  }

  /** Turn index lines into the text the prompt variable carries. */
  const format = (lines) => (lines.length === 0 ? '(empty — nothing has been remembered yet)' : lines.join('\n'))

  /**
   * The duplicate-candidate advisory (F17, #26), appended after the index. It
   * reads only `<root>/.duplicates` — a tiny dotfile `graph-maintain` writes
   * (top pairs, one `<a> <b>` per line) — never a graph scan, so it stays cheap
   * on the synchronous assembly path. Absent/empty file yields '' so the section
   * is byte-identical to before whenever there are no candidates.
   *
   * #263 W2.1: the whole block is write-only — its one action is a merge — so
   * the read profile renders '' and `manage` renders it without the tool name
   * A2A strips (see {@link duplicatesNote}). The dotfile is still read in the
   * `manage` shape only, so the read profile's assembly does not pay for it.
   */
  const duplicatesNote = () => {
    if (promptProfile === 'read') return ''
    let text
    try {
      text = fs.readFileSync(path.join(root, '.duplicates'), 'utf8')
    } catch {
      return ''
    }
    const pairs = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/)).filter((parts) => parts.length >= 2)
      // Drop any pair whose either side is no longer a LIVE node — a prior
      // memory_merge may have archived one, and recommending its re-merge would
      // only throw. Filter BEFORE the slice so stale leading rows never crowd
      // out a live pair further down; `.duplicates` is capped at 10 rows, so
      // this is at most a handful of existsSync calls, never a graph scan.
      .filter(([a, b]) => fs.existsSync(path.join(root, a, 'node.md')) && fs.existsSync(path.join(root, b, 'node.md')))
      .slice(0, 3)
    if (pairs.length === 0) return ''
    // `full` names the tool; `manage` cannot call it, so it names the pass that
    // can instead of an instruction the authority cannot follow.
    const lead = promptProfile === 'manage'
      ? 'Possible duplicate memories — if two are the same fact, the maintenance pass can fold one into the other:'
      : 'Possible duplicate memories — if two are the same fact, run memory_merge(keep_id, absorb_id):'
    return ['', lead, ...pairs.map(([a, b]) => `  ${a} ~ ${b}`)].join('\n')
  }

  /**
   * The orphan census (F40, #60), appended after the index like the duplicate
   * advisory. Write-time link suggestions fire once, at the moment the agent
   * is least interested — 12 of 73 nodes in the dossier replay ended up
   * islands anyway, and an unconnected node is nearly unfindable once it
   * leaves the index. Persistent surfacing makes linking them something any
   * session can notice and fix. Empty census yields '' so the section stays
   * byte-identical whenever every node is connected. Shares the index cache,
   * so its scan runs at most once per `indexCacheMs`.
   *
   * #263 W2.1: the block exists to get nodes LINKED, and its only action is a
   * `memory_write` — write-only, so the read profile renders '' without even
   * paying for the census scan.
   */
  const ORPHANS_SHOWN = 3
  const orphansBlock = () => {
    if (promptProfile === 'read') return ''
    let census
    try {
      census = orphanCensus(root, ORPHANS_SHOWN)
    } catch {
      return ''
    }
    if (census.total === 0) return ''
    const more = census.total > census.shown.length ? [`  …${census.total - census.shown.length} more — memory_search "" lists the whole graph`] : []
    return [
      '',
      `${census.total} unlinked memor${census.total === 1 ? 'y has' : 'ies have'} no edges at all — nearly unfindable once out of this index. When one relates to a node you touch, wire it: memory_write with just its id and links:`,
      ...census.shown.map(({ id, description }) => `  ${id} — ${description.length > 500 ? description.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '') + '…' : description}`),
      ...more,
    ].join('\n')
  }

  /**
   * The zero-write notice (F60, #105), appended after the census.
   *
   * F46/F48 made a zero-write memory turn LOUD — a stderr line and a marker
   * entry — but loud only where nobody is listening: stderr belongs to the
   * harness run that already ended, and the marker is an offline forensic
   * file. The turn's content stayed lost, 4 times in 39 turns in replay v3.
   * This is the other half of the escalation: the next session that assembles
   * a prompt is TOLD, in the one place it cannot miss, that recent turns died
   * without writing — because a person or a later conversation that still
   * remembers what those turns covered is the only party who can salvage them.
   *
   * The hook itself cannot salvage anything: writing a node on the agent's
   * behalf would be the plugin fabricating memory, which is exactly F50's sin.
   * So it surfaces forensics and nothing more — a count and a pointer at the
   * file, never a line of it. The marker's format is untouched (F46/F48).
   *
   * Deliberately NOT gated on `expectWrite`: the turn that lost content and
   * the session that could recover it are different processes, and the
   * recovering one is usually an ordinary chat with the flag off.
   *
   * Nothing marks an entry salvaged — the marker is append-only and this
   * reader never writes — so the notice stands for its whole window even after
   * someone acts on it. That is why it says search first: the section's
   * search-before-write rule and the `similar` advisory are what stop a second
   * session from storing the same salvage twice, and a notice that outlives
   * its own fix by a few days is cheaper than a marker file the prompt path
   * mutates.
   *
   * See ZERO_WRITE_FILE and friends for the window, the read bound and the
   * display cap.
   *
   * #263 W2.1: the notice exists to get a lost turn WRITTEN back — write-only,
   * so the read profile renders '' without reading the marker file at all.
   */
  /**
   * The tail of one line-oriented dotfile at the graph root, as whole lines —
   * the read every journal-shaped file here gets (`.zero-write-turns` since
   * F60, `.advisories` for F70's two read-backs). `undefined` when the file is
   * absent or unreadable; the callers all treat that as silence.
   *
   * The open is the guarded one the attachment scan uses (graph.js):
   * O_NOFOLLOW so a symlink dropped in the graph root cannot redirect the
   * read, O_NONBLOCK so a fifo left in the file's place cannot hang the
   * caller — two of the three run on the synchronous assembly path.
   *
   * These files are append-only and unbounded, so only `bound` bytes are read.
   * The read starts one byte BEFORE the cut, so a tail that happens to begin
   * exactly at a line boundary is not mistaken for a partial entry: that byte
   * is then the previous newline, and dropping the split's first element
   * discards whatever the cut landed in (a clean cut drops an empty string).
   */
  const tailLines = (name, bound) => {
    let text
    let cut = false
    let fd
    try {
      fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      const { size } = fs.fstatSync(fd)
      const start = Math.max(0, size - bound)
      cut = start > 0
      const from = cut ? start - 1 : 0
      const buffer = Buffer.alloc(size - from)
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, from)).toString('utf8')
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd) } catch { /* nothing left to do about it */ }
    }
    const lines = text.split('\n')
    if (cut) lines.shift()
    // The file is newline-terminated per entry, so a clean read ends in one
    // empty element — never an entry, so never returned.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return { lines, cut }
  }

  /**
   * One parsed `.advisories` line: `{ at, kind, id, digest }`, or undefined
   * for a line this reader does not understand (a truncated cut survivor, a
   * foreign line). Fields are positional — timestamp, optional `turn=`, kind,
   * node id, digest — exactly as {@link journalAdvisories} writes them; the
   * digest is whatever remains, which is safe because `advisoryDigest` folded
   * it to one line before it was written.
   */
  const parseAdvisoryLine = (line) => {
    const parts = line.split(' ')
    const shift = parts[1]?.startsWith('turn=') ? 1 : 0
    if (parts.length < shift + 4) return undefined
    const [kind, id] = [parts[1 + shift], parts[2 + shift]]
    if (!ULID_RE.test(id)) return undefined
    return { at: parts[0], kind, id, digest: parts.slice(3 + shift).join(' ') }
  }

  /**
   * The advisory queue's depth (F70, #149) — how many journal lines are
   * waiting for a maintenance pass. The journal IS the queue: nothing marks a
   * line handled short of the maintain agent rotating the file away (the same
   * consolidation contract `.access` has), so the file's line count is the
   * backlog. A cut read undercounts, deliberately: at ADVISORY_TAIL the tail
   * alone already holds thousands of lines, so the returned floor still clears
   * any sane threshold, and reading an unbounded file whole on every write is
   * exactly the cost this bound exists to avoid.
   */
  const advisoryBacklog = () => tailLines('.advisories', ADVISORY_TAIL)?.lines.length ?? 0

  /**
   * The journal's lines about ONE node, rendered for its read view (F70,
   * #149) — the opportunistic read-time surface: a session that opens a node
   * mid-conversation is the session best placed to act on what write time
   * already noticed (split the hub it is about to append to, refresh the stale
   * description it just read past). Newest NODE_ADVISORIES_SHOWN only, oldest
   * first like the journal; the date, not the full timestamp, because the view
   * needs "how stale" at a glance, not correlation. Absent journal or no lines
   * for this id yields [] — the read is silence, never an error: the view is
   * bookkeeping ABOUT the node, and a node must never fail to load over it.
   */
  const nodeAdvisories = (id) => {
    const tail = tailLines('.advisories', ADVISORY_TAIL)
    if (tail === undefined) return []
    const rows = []
    for (const line of tail.lines) {
      const entry = parseAdvisoryLine(line)
      if (entry === undefined || entry.id !== id) continue
      rows.push(`${entry.kind} (${entry.at.slice(0, 10)}): ${entry.digest}`)
    }
    return rows.slice(-NODE_ADVISORIES_SHOWN)
  }

  /**
   * Contention steering appended to a Stale Write rejection on a hub (#145).
   * The concurrency eval showed the gate's cost concentrating on hub-shaped
   * nodes: every collision buys a full reject → re-read → rewrite loop inside
   * the turn (2–4× the plain-turn median), and the organic collisions all
   * landed on one high-degree node both streams kept appending to. When the
   * rejected edit was ADDING a fact rather than revising what the hub already
   * says, that loop is avoidable entirely — a new node created with `links`
   * to the hub carries the fact born connected, and a create is gate-exempt,
   * so it cannot collide. Only the writer knows which shape its edit was, so
   * this is wording on an error that already threw, never a behavior change:
   * revisions of the hub's own content still must re-read and reconcile.
   * Same threshold as the F70 hub advisory, one best-effort readdir on a path
   * only reached when a write was rejected — any failure keeps the plain
   * message.
   *
   * Returns `{ read, text }` rather than a bare string (#245 review): the text
   * is byte-identical to what callers saw before, but a failed edge lookup is
   * distinguishable from a successful one with no hint. The stale branch
   * certifies "nothing was written" only when the whole prefix it audited
   * completed, and retrieval of the hint is part of that prefix — so a failed
   * lookup throws the same message UNBRANDED (ordinary unknown) instead of
   * being certified. (`outEdges` itself still treats a missing `__edges__/` as
   * the empty set, its long-standing contract.)
   */
  const hubContentionHint = async (id) => {
    try {
      const degree = (await outEdges(root, id)).length
      if (degree > NODE_DEGREE_CAP) {
        return {
          read: true,
          text: `. This node is a high-traffic hub (${degree} edges): if your change ADDS a new fact rather than revising what the hub already says, skip the retry — store the fact as a NEW node created with links: ["${id}"] (born connected, and a create has no version to contend for).`,
        }
      }
      return { read: true, text: '' }
    } catch {
      // The rejection stands on its own; the hint is unavailable.
      return { read: false, text: '' }
    }
  }

  const zeroWriteBlock = () => {
    if (promptProfile === 'read') return ''
    const tail = tailLines(ZERO_WRITE_FILE, ZERO_WRITE_TAIL)
    // No marker, or a root that cannot be read: silence, byte-identical to
    // a deployment that has never lost a turn.
    if (tail === undefined) return ''
    const { lines } = tail
    const now = Date.now()
    const window = ZERO_WRITE_DAYS * 24 * 60 * 60 * 1000
    let count = 0
    for (const line of lines) {
      // Only the timestamp field is parsed; the rest of the line (pid, turn)
      // is the file's business, and its shape is F46/F48's contract, not this
      // reader's to depend on beyond the leading instant. But the separator
      // must actually be there: a line with no space is a truncated or
      // corrupted entry, not an entry — and reading its "first field" as
      // everything-but-the-last-character would turn `<recent ISO>x` into a
      // parseable instant and count a loss that never happened.
      const field = line.indexOf(' ')
      if (field < 0) continue
      const at = Date.parse(line.slice(0, field))
      // Bounded on BOTH sides: an entry dated past the window is stale, and one
      // dated a window into the future came from a skewed clock — counting it
      // would hold the notice open until its own date arrived. Mild skew still
      // counts; the tolerance is the window itself.
      if (Number.isNaN(at) || at < now - window || at > now + window) continue
      count++
    }
    if (count === 0) return ''
    const shown = count > ZERO_WRITE_MAX_COUNT ? `${ZERO_WRITE_MAX_COUNT}+` : `${count}`
    return `\n\n${shown} memory turn${count === 1 ? '' : 's'} in the last ${ZERO_WRITE_DAYS} days exited without writing anything (see ${ZERO_WRITE_FILE} at the graph root) — if you know what those conversations covered, store it; search first, an earlier session may already have. Content from those turns is otherwise lost.`
  }

  /**
   * The open handoff/thread nodes, read at most once per `indexCacheMs`.
   *
   * A scan failure yields an empty list and is NOT cached: both readers treat
   * "no open work state" as silence — the banner renders '' and the sweep
   * fires nothing — and a transient unreadable root must not freeze that
   * silence in for the cache's whole lifetime.
   */
  const workStateNodes = () => {
    if (Date.now() - cachedWorkState.at < indexCacheMs) return cachedWorkState.nodes
    let nodes
    try {
      nodes = openWorkState(root)
    } catch {
      return []
    }
    cachedWorkState = { at: Date.now(), nodes }
    return nodes
  }

  /**
   * Open handoffs (F38, #58), rendered ABOVE the index: a handoff exists to
   * be the next session's first read, so it must not compete with 200 index
   * lines for attention — round 4's next session found neither the handoff
   * attachment nor the pointer node built to advertise it. Empty result
   * yields '' so the section is byte-identical when no handoff is open.
   */
  const computeHandoffs = () => {
    const open = workStateNodes().filter((node) => node.type === 'handoff')
    if (open.length === 0) return ''
    // Every open handoff, uncapped: search cannot filter by type, so a hidden
    // row would be unreachable (codex review of this change). The section's
    // one-open-handoff-per-thread discipline is what bounds this list.
    //
    // #263 W2.1: the closing parenthetical names two WRITES. A read run cannot
    // make either, so its banner keeps the visibility — the ids, the
    // descriptions, and "read it before touching the thread" — and drops only
    // the how-to-close. The banner itself is never removed: an open handoff is
    // exactly what a read run must be told about.
    const closing = promptProfile === 'read'
      ? ''
      : ` (close a finished one by superseding it, or by retyping it journal/thread if it should stay as history)`
    return [
      `Open handoff${open.length === 1 ? '' : 's'} — unfinished work left for this session; memory_read ${open.length === 1 ? 'it' : 'each'} before anything that could touch ${open.length === 1 ? 'its' : 'their'} thread${closing}:`,
      ...open.map(({ id, description }) => `  ${id} — ${description.length > 500 ? description.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '') + '…' : description}`),
      '',
      '',
    ].join('\n')
  }

  /**
   * The close-out sweep (F61, #106): the open work-state nodes whose pending
   * list this write may just have resolved.
   *
   * Work-state nodes are only ever updated when the writer happens to address
   * THAT node, and a delivered result is normally stored as a NEW one — so the
   * graph ends up asserting "answered" and "pending" about the same fact
   * (420002's `ledger-a` still marked three items 结果未返回 while sibling nodes
   * recorded their completion; 430003's `ledger-b` read 检索中 for 13 steps after
   * the answer landed). Nothing here mutates the ledger: only the writer knows
   * whether this write really is that item's answer, and cross-session
   * close-out is graph-maintain's business.
   *
   * Bounded by construction: the node list is the banner's cached scan
   * (`workStateNodes`) — read BEFORE this write invalidates it, so in the
   * ordinary flow (dsh assembles the prompt, and therefore the banner, once
   * per step) the sweep reuses a scan that already happened and adds no
   * whole-graph pass of its own. Capped at STALE_PENDING_NODES; only those
   * bodies are tokenized, at most STALE_PENDING_LINES lines each; the new
   * content is reduced to bigram units once, not once per node.
   *
   * `closed` are the ids this very write took out of the open set — the node
   * itself (a ledger's own write-back IS the close-out) and any node it
   * superseded. They are passed in rather than re-read, because the cached
   * list is the pre-write one: a scan is not worth paying for to learn what
   * this call already knows.
   *
   * Accepted fire: content that is itself still pending — a second ledger
   * opening the same item, or a write-back that says "still waiting" — reads
   * as a resolution here, because the sweep can only see vocabulary, not
   * delivery. The advisory says "may resolve" and asks for a read, and reading
   * the other ledger is the right move either way: the section's rule is one
   * open handoff per thread, revised, not a second one. Guessing at
   * done-vs-not-done wording would silence real resolutions, which is the
   * failure this feature exists to end.
   *
   * Accepted fire: a finished handoff retyped to `thread` (one of the two
   * documented ways to close one) is still swept, because `thread` is the
   * live work-state kind. That is the right answer, not a leak — retyping
   * does not make a "结果未返回" line true, and the sweep is what asks for the
   * line to be cleaned up. Retype to `journal` for history that is genuinely
   * done.
   */
  const stalePendingMatches = (closed, content) => {
    const contentUnits = new Set(hanBigrams(tokenize(content)))
    if (contentUnits.size === 0) return []
    const matches = []
    // Handoffs first inside the budget, then threads, each newest-first.
    // `thread` nodes accumulate (they close by retype, which nothing forces),
    // and twenty recent threads must not be able to push the one open handoff
    // — the node a fresh session reads first — out of the scan.
    const open = workStateNodes()
    const candidates = [...open.filter((node) => node.type === 'handoff'), ...open.filter((node) => node.type !== 'handoff')]
    for (const node of candidates.slice(0, STALE_PENDING_NODES)) {
      if (closed.includes(node.id)) continue
      const hit = resolvedPendingLine(node.body, contentUnits)
      if (hit !== undefined) matches.push({ id: node.id, line: hit.line, score: hit.score })
    }
    // Best coverage first; ties keep the scan's newest-first order (sort is
    // stable), so the most recent ledger wins a tie.
    matches.sort((a, b) => b.score - a.score)
    return matches.slice(0, STALE_PENDING_MATCHES).map(({ id, line }) => ({ id, line }))
  }

  /** The handoff banner, cached like the index and invalidated with it. */
  const handoffsBlock = () => {
    // #263: frozen on the first render under `indexSnapshot: 'run'` — the
    // banner comes from the same work-state scan the index's two blocks do, so
    // leaving it live would splice a new prompt on exactly the boundary the
    // snapshot exists to protect.
    if (snapshot?.handoffs !== undefined) return snapshot.handoffs
    if (Date.now() - cachedHandoffs.at >= indexCacheMs) cachedHandoffs = { at: Date.now(), text: computeHandoffs() }
    const text = cachedHandoffs.text
    if (snapshot !== undefined) snapshot.handoffs = text
    return text
  }

  /** Whether the cached index may still be served. */
  const fresh = () => cached.text !== '' && Date.now() - cached.at < indexCacheMs

  /**
   * The index lines plus the graph-derived blocks that ride after them —
   * composed in one place so the async refresh and the synchronous first
   * assembly cannot drift into rendering different sections.
   */
  const indexBlocks = (lines) => format(lines) + duplicatesNote() + orphansBlock()

  const refreshIndex = async () => {
    if (fresh()) return cached.text
    let text
    try {
      text = indexBlocks(await indexLines(root, maxIndexEntries, rankWeights, undefined, indexBudget))
    } catch (error) {
      text = `(memory index unavailable: ${error.message})`
    }
    // Appended OUTSIDE the index's failure handling, deliberately: the notice
    // reads a dotfile, not the graph, so an unreadable node must not take the
    // loss signal down with the index — that is exactly the moment a graph is
    // losing content (F60, #105).
    text += zeroWriteBlock()
    cached = { at: Date.now(), text }
    return text
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    // Assembly is synchronous, so an async warm-up loses the race on the first
    // request and would show the model a placeholder where its memory belongs.
    // Read the graph directly when the cache cannot answer.
    //
    // #263 (wave 3, lever 1): `frozenPromptText` wraps EVERY provider whose
    // value can change mid-run, so one flag freezes the whole system message and
    // not just the two W3-lite variables. Off (`promptSnapshot` absent — every
    // read run, every non-A2A deployment) the wrapper is a straight call.
    promptCtx.systemPrompt.variable('memory_index', () => frozenPromptText('index', () => {
      // #263: with `indexSnapshot: 'run'`, the first render is the run's
      // prompt text. Serving it unconditionally — not just inside the TTL — is
      // the point: a TTL expiry or a re-rank from this run's own reads must not
      // rewrite the system prompt mid-run.
      if (snapshot?.index !== undefined) return snapshot.index
      let text
      if (fresh()) {
        text = cached.text
      } else {
        try {
          text = indexBlocks(indexLinesSync(root, maxIndexEntries, rankWeights, undefined, indexBudget))
        } catch (error) {
          text = `(memory index unavailable: ${error.message})`
        }
        text += zeroWriteBlock()
        cached = { at: Date.now(), text }
      }
      if (snapshot !== undefined) snapshot.index = text
      return text
    }))
    // Ledger #20: the section orders relative dates rewritten as ISO dates. Without
    // an anchor the model copied the date out of the example bullet, so every
    // "today" landed a day off. Evaluated per assembly — a long-lived `dsh web`
    // process must not freeze the date at startup.
    // Pinned above the index heading (F38, #58): a handoff is the next
    // session's first read, so it must not compete with 200 index lines.
    promptCtx.systemPrompt.variable('memory_handoffs', () => frozenPromptText('handoffs', handoffsBlock))
    promptCtx.systemPrompt.variable('memory_today', (context) => {
      // Every assembly evaluates this variable and nothing caches it, so it is
      // where the blind-rewrite guard watches for a turn change (F62, #107) —
      // the assemble context carries the loop, and the loop counts turns. A
      // long-lived `dsh web` process would otherwise let one conversation's
      // reads vouch for the next conversation's rewrites. The reset keys on the
      // COUNTER, never on the render: assembly happens per step, and a read and
      // the write it informs sit in different steps of one turn.
      //
      // #263 (wave 3): `startTurn` stays OUTSIDE the freeze — the side effect is
      // the guard, not the prompt text, and freezing it would let one turn's
      // reads vouch for the next turn's rewrite. Only the rendered date freezes,
      // which is what a midnight-crossing run would otherwise splice.
      startTurn(context)
      // F67 (#121): carry the weekday so weekday-name phrases resolve against
      // a stated anchor instead of the model's own calendar math (measured +1
      // on 3/3 weekday-name resolutions in QA pass 7).
      return frozenPromptText('today', () => {
        const stamp = today()
        return `${stamp} (${weekdayName(stamp)})`
      })
    })
    // F53 (#89): the caller's event clock, rendered next to the runtime clock
    // so the writer can tell them apart. Captured once, unlike `memory_today`,
    // which is re-read per assembly: the runtime clock moves under a long-lived
    // process, a single invocation's conversation date does not — which is also
    // why a composition serving many conversations must leave it unset rather
    // than freeze one date for all of them. '' when unset: the event clock IS
    // today and there is nothing to supply. The rule itself stays unconditional
    // and ranks a date the conversation states ABOVE this one — replay v3's
    // worst misses had the true date stated in the segment and stamped the run
    // date anyway, and a supplied date must never overrule a stated one.
    // #263 W2.1: the supplied date itself is read-visible — a reader answering
    // "when was that" needs the conversation's clock. Its clause about how to
    // DATE EVENTS is write guidance ("date events against it"), so the read
    // profile keeps the date and the weekday and drops that instruction.
    promptCtx.systemPrompt.variable('memory_context_date', () => (contextDate
      ? `This conversation's date: ${contextDate} (${weekdayName(contextDate)})${promptProfile === 'read' ? '.\n' : ' — date events against it, not against today.\n'}`
      : ''))
    // F67 option 1.5 (#121): a lookup table instead of arithmetic. Annotating
    // the anchors (option 1) fixed only the anchors the plugin renders — a
    // conversation-STATED date has no parenthesis, and CN weekday phrases
    // against one still resolved +1 (0/3 across two QA rounds). The strip
    // makes every nearby date's weekday a lookup: Mon-first rows covering
    // ±14 days around today AND the supplied conversation date, full ISO in
    // every cell so the resolved date can be copied, not re-derived. Date-only
    // UTC math on purpose (a calendar day is not an instant); re-rendered per
    // assembly because today() moves under a long-lived process.
    const calendarStrip = () => {
      const anchors = [today(), ...(contextDate ? [contextDate] : [])]
      const DAY = 864e5
      const mondayOf = (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY
      // One ±14-day window PER anchor, deduped — never the span between them:
      // a historical contextDate would otherwise emit every intervening week
      // (a 1999 date is ~1,400 rows) into every prompt (codex catch on #124).
      const weeks = new Set()
      for (const anchor of anchors) {
        const t = Date.parse(`${anchor}T00:00:00Z`)
        for (let week = mondayOf(t - 14 * DAY); week <= mondayOf(t + 14 * DAY); week += 7 * DAY) weeks.add(week)
      }
      const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      const rows = []
      let prev
      for (const week of [...weeks].sort((a, b) => a - b)) {
        if (prev !== undefined && week - prev > 7 * DAY) rows.push('⋮ (weeks omitted)')
        prev = week
        const cells = []
        for (let i = 0; i < 7; i++) {
          const iso = new Date(week + i * DAY).toISOString().slice(0, 10)
          let cell = `${names[i]} ${iso}`
          if (iso === anchors[0]) cell += ' ←today'
          if (contextDate && iso === contextDate) cell += " ←conversation's date"
          cells.push(cell)
        }
        rows.push(cells.join('  '))
      }
      return rows.join('\n')
    }
    // #263 W2.1: the calendar strip exists to resolve weekday names when a date
    // is being WRITTEN, and the read profile removes both it and the sentence
    // that points at it — so the read profile renders '' here. The variable is
    // still REGISTERED and still evaluated on every assembly; `memory_today`
    // above is what carries the per-assembly `startTurn` side effect (F62,
    // #107), and nothing about that guard depends on this variable existing.
    promptCtx.systemPrompt.variable('memory_calendar', () => (promptProfile === 'read' ? '' : frozenPromptText('calendar', calendarStrip)))
    // P7-C: the write-batching bullet, or nothing. A variable rather than a
    // second SECTION_TEXT so the section stays one string with one slot,
    // exactly like `memory_context_date`; '' when off leaves the surrounding
    // bullets adjacent with no blank line.
    promptCtx.systemPrompt.variable('memory_batch_writes', () => (batchWrites && promptProfile !== 'read' ? BATCH_WRITES_BULLET : ''))
    // #263 W2.1: the write-time surface, one variable per slot. `full` (the
    // default) renders every one of them verbatim, so the section is
    // byte-identical to what it was before this profile existed; `manage` drops
    // nothing here (its only removals are the two tool-named surfaces further
    // down); `read` renders the write rules out and substitutes the read forms
    // of the two bullets that mix read and write guidance. Slots sit at the
    // START of the next KEPT line and each value ends with '\n', so '' leaves
    // the surviving bullets adjacent with no blank line — the same contract
    // `memory_batch_writes` has always had.
    const writeSurface = (text) => (promptProfile === 'read' ? '' : `${text}\n`)
    promptCtx.systemPrompt.variable('memory_hands_off', () => (handsOffRule ? `${HANDS_OFF_BULLET}\n` : ''))
    promptCtx.systemPrompt.variable('memory_learn_bullet', () => writeSurface(WRITE_LEARN_BULLET))
    // #263 W2.1: `{{memory_append_line}}` now sits inside this block rather than
    // in SECTION_TEXT, so it is resolved HERE — a harness renders the section's
    // slots in one pass and would otherwise hand the model a literal token.
    promptCtx.systemPrompt.variable('memory_unknown_rule', () => `${promptProfile === 'read' ? READ_UNKNOWN_BULLET : WRITE_UNKNOWN_BULLET}\n`)
    promptCtx.systemPrompt.variable('memory_write_guidance', () => writeSurface(WRITE_WORKFLOW_BULLETS.replace('{{memory_append_line}}', appendWrites ? 'line, via `append`' : 'appended line')))
    promptCtx.systemPrompt.variable('memory_link_bullets', () => writeSurface(WRITE_LINK_BULLETS))
    promptCtx.systemPrompt.variable('memory_type_bullet', () => writeSurface(WRITE_TYPE_BULLET))
    // This block closes the bullet list, so its slot owns the blank line before
    // `Today is …`: full renders the block plus that separator, and `read` keeps
    // the separator alone so the date paragraph does not butt against the list.
    promptCtx.systemPrompt.variable('memory_supersede_bullets', () => (promptProfile === 'read' ? '\n' : `${WRITE_SUPERSEDE_BULLETS}\n\n`))
    // The identifier rule is read-visible in BOTH profiles: a reader must quote
    // an id verbatim and never invent one. Only its write half (copy it into
    // `body`/`description`) is write-time, so the read profile swaps the whole
    // bullet for its read form rather than dropping it.
    promptCtx.systemPrompt.variable('memory_identifiers', () => `${promptProfile === 'read' ? READ_IDENTIFIER_BULLET : WRITE_IDENTIFIER_BULLET}\n`)
    // The weekday-resolution sentence is the calendar strip's companion; the
    // read profile drops both. The event-clock rule above it is also write-time
    // ("date events against it") and goes with them, while `Today is …` stays.
    promptCtx.systemPrompt.variable('memory_date_rules', () => (promptProfile === 'read' ? '' : `${DATE_RULES_SENTENCE}\n`))
    // The blank line between the date paragraph and whatever follows it. Its own
    // slot because it is the one separator BOTH shapes need: with the strip
    // present, `full`/`manage` end the strip on a blank line; with the strip and
    // the date rule both gone (`read`), one newline is exactly the blank line
    // that keeps the handoff banner off the date.
    promptCtx.systemPrompt.variable('memory_dates_separator', () => (promptProfile === 'read' ? '\n' : '\n\n'))
    // F89 (#219): the no-change bullet names the route when it exists — a
    // phrase slot, not a new sentence, so the section's size is the same
    // either way (#219 Finding 5: the section is 96% of the system prompt,
    // and a mechanism pays for its instruction out of words already spent).
    promptCtx.systemPrompt.variable('memory_append_line', () => (appendWrites ? 'line, via `append`' : 'appended line'))
    promptCtx.systemPrompt.section({ name: 'memory:graph', order: 150, text: SECTION_TEXT })
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    // #263 W2.1: `memory_restore` is stripped by the restricted wrapper at BOTH
    // A2A authorities (read and manage), so any profile but `full` drops the
    // advice rather than naming a call the run cannot make.
    description: 'Search persistent memory. Pass the words you would use to describe what you are looking for; an empty query returns the whole index. Descriptions weigh more than bodies, which weigh more than attached files; a row with a `[N files]` marker carries attached files, and the top rows that matched inside a file also quote the matching passage with the byte offset it starts at — the quote comes from the file, the snippet beside it comes from the node body, so when they disagree the file is the raw record and memory_read_file (with that offset) reads more of it; a lower row that only shows `[N files]` may still hold the answer inside a file, so open it with memory_read_file. Call this before answering anything that depends on earlier work, past decisions, or facts about this user or this machine. Set `include_archived` to also reach nodes maintenance set aside for staleness — those hits are marked [archived]' + (promptProfile === 'full' ? '; bring one back with memory_restore.' : '.') + ' A row marked [superseded by <id>] was replaced by a later decision — read that node instead, and treat the marked one as history. The result names any term no node carried at all — reword that term, not the ones that worked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to look for. An empty string lists every node.' },
        limit: { type: 'integer', description: 'Maximum matches to return. Defaults to the deployment limit.' },
        include_archived: { type: 'boolean', description: 'Also search archived (pruned) nodes. Off by default; matches from the archive are marked [archived].' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'full', 'tokens', 'matches'],
        properties: {
          total: { type: 'integer' },
          full: { type: 'integer' },
          tokens: { type: 'integer' },
          // Query terms no node in the graph carried (F36, #56). Present only
          // when some term found nothing — the word to change before retrying.
          unmatched: { type: 'array', items: { type: 'string' } },
          // This turn's FIRST search came back with no rows at all (F80, #184).
          // Present (and true) only then, so the reword floor rides the one
          // result where the model is about to conclude "not in memory".
          first_probe: { type: 'boolean' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'description', 'score', 'uses', 'snippet'],
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                score: { type: 'number' },
                uses: { type: 'integer' },
                snippet: { type: 'string' },
                // Attachment names, present only on rows whose node carries
                // agent-space files — the marker that a node has deeper context
                // than its body shows (F2, #11). Computed for returned rows only.
                files: { type: 'array', items: { type: 'string' } },
                // Attachment names the query matched inside (F29, #49);
                // present only on rows where one did.
                matched_in: { type: 'array', items: { type: 'string' } },
                // What those attachments say around the hit (F81, #182), with
                // the byte offset to resume memory_read_file at. Present only
                // on rows that matched inside a file; one entry per file, at
                // most three.
                file_matches: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['file', 'offset', 'excerpt'],
                    properties: {
                      file: { type: 'string' },
                      offset: { type: 'integer' },
                      excerpt: { type: 'string' },
                    },
                  },
                },
                // Present (and true) only on hits from the archive, so a
                // default search carries the same match shape it always did.
                archived: { type: 'boolean' },
                // The successor's id, on a node a later write replaced (F24, #44).
                superseded_by: { type: 'string' },
                // The query terms this row answered (F36, #56); absent on a
                // whole-graph listing, which has no terms.
                matched: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMatches(value, promptProfile) }],
    },
    async execute(args, exec) {
      const limit = args.limit === undefined ? searchLimit : Math.max(1, args.limit)
      await refreshIndex()
      // Search returns only a bounded first-line snippet, never a full body,
      // so it deliberately does not satisfy the F68 version gate (#129).
      const result = await search(root, args.query, limit, { includeArchived: args.include_archived === true })
      // The reword floor (F80, #184). On reference retrieval, 89 of 104 failed answers made
      // exactly one memory_search and 12 made none: one shallow probe decided
      // "not in memory" for a 55-node graph. #169's lesson is that a
      // side-channel advisory with no actuator gets ignored, so the floor rides
      // the tool RESULT the model must read — and only the result where the
      // conclusion is about to be drawn: the turn's FIRST probe, returning no
      // rows at all. A second search is the floor, not a licence for unbounded
      // probing, so the line never fires twice in a turn.
      //
      // A whole-graph listing (empty query, `tokens === 0`) is not a probe: it
      // has no wording to reword, and zero rows there is an empty graph rather
      // than a miss. It therefore neither draws the line nor spends the
      // Session's one first probe — listing the index first must not silence
      // the floor for the targeted search that follows.
      if (result.tokens === 0) return result
      const state = sessionState(sessionKeyOf(exec))
      // Which turn of THIS Session the count belongs to, off the public
      // `agent.session` surface rather than the private `agent.phase` F62 reads
      // (#175). See {@link userTurns}: per-Session by construction, so no
      // conversation can re-arm another's floor, and `undefined` on a runtime
      // that exposes no history — where the counter simply never re-arms.
      const turn = userTurns(exec)
      if (turn !== undefined && turn !== state.searchTurn) {
        state.searchTurn = turn
        state.searches = 0
      }
      const first = state.searches === 0
      state.searches += 1
      if (first && result.matches.length === 0) return { ...result, first_probe: true }
      return result
    },
    presentCall: (args) => ({ card: 'generic', title: `Search memory: ${args.query === '' ? '(all)' : args.query}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Open one memory node by id and read its full content and its connected nodes — plain edges are symmetric, so the edge list is also who points here. Pass `from` when you reached this node by following an edge from another node — recorded traversals are what rank the graph over time.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The 26-character node id.' },
        from: { type: 'string', description: 'The node you followed an edge from, if any.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description', 'created', 'updated', 'type', 'body', 'edges', 'files'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          created: { type: 'string' },
          updated: { type: 'string' },
          type: { type: 'string' },
          body: { type: 'string' },
          edges: { type: 'array', items: OUT_EDGE_SCHEMA },
          // Each agent-space attachment with its byte size and, when its first
          // line reads as text, a one-line summary (F2, #11).
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'size'],
              properties: { name: { type: 'string' }, size: { type: 'integer' }, summary: { type: 'string' } },
            },
          },
          // Journal lines still queued against this node (F70, #149), rendered
          // `<kind> (<date>): <digest>`. Present only when there are any, so a
          // clean node's view is byte-identical to before.
          advisories: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderNodeView(value, appendWrites, promptProfile) }],
    },
    async execute(args, exec) {
      const { seenBodies, versionSeen } = sessionState(sessionKeyOf(exec))
      const { view, raw } = await withNodeLocks(root, [args.id], async () => {
        const view = await readNode(root, args.id)
        const raw = await fsp.readFile(path.join(root, args.id, 'node.md'))
        return { view, raw }
      })
      // Layer 2 records disk state even when the rendered body is truncated:
      // unlike F62, this gate protects the state read, not model attention.
      versionSeen.set(args.id, hashBytes(raw))
      // The read landed, so this Session has now seen this body — the
      // membership the blind-rewrite guard checks (F62, #107). Only when the
      // view showed ALL of it: past BODY_VIEW_CHARS the render truncates, and
      // a prefix says nothing about the tail a rewrite would destroy, which is
      // exactly the knowledge the guard is asking about. Recorded before the
      // access bookkeeping below, which is best-effort: a traversal that failed
      // to log is still a body the model was shown.
      if (view.body.trim().length <= BODY_VIEW_CHARS) seenBodies.add(view.id)
      if (args.from === undefined) {
        // A direct read (no arriving edge) is the strongest signal a memory is
        // in use, yet it left no trace — so ranking, staleness, and archiving
        // all treated heavily-read nodes as never-touched. Record it against
        // the node's own log so it counts as a visit. A read that cannot be
        // logged is not a failed read.
        try {
          await touchRead(root, args.id)
        } catch { /* best-effort; the node still loaded */ }
      } else {
        // A traversal that cannot be recorded is not a failed read.
        try {
          await touchEdge(root, args.from, args.id)
        } catch (error) {
          // Missing edge — reaching this node from `from` IS association
          // evidence, so wire it and log the touch. A wrong guess ages out:
          // the edge is born with log history, so the stale-edge prune rule
          // applies. Any other failure (malformed symlink, I/O) is left for
          // graph-maintain to report rather than papered over here.
          if (/^no such edge/.test(error?.message ?? '')) {
            // #317: `touchEdge` above throws `no such edge` for TWO states — no
            // edge at all, and a half-edge `addEdge` is about to complete. The
            // receipt is the ONLY trustworthy answer: `addEdge` reports what
            // THIS call actually changed, so a wire another root made between
            // two of our own reads can never be attributed to this one.
            //
            // #321: both the receipt and the "did `addEdge` return" flag are
            // hoisted above the inner try, and the flush sits in a `finally`, so
            // a `touchEdge` that throws AFTER the wiring landed still logs it —
            // with the success fan-out, because `addEdge` did return. A failed
            // `addEdge` logs the failure rule's lines instead. Either way the
            // read itself still cannot fail on any of this.
            const minted = []
            let edgeReturned = false
            const at = Date.now()
            try {
              await addEdge(root, args.from, args.id, { minted })
              edgeReturned = true
              await touchEdge(root, args.from, args.id)
            } catch {
              /* invalid `from` — the node still loaded */
            } finally {
              const lines = edgeReturned ? edgeReceiptLines(minted) : edgeFailureLines(minted)
              if (lines.length > 0) await recordProvenance(lines, exec, provenanceTs(at))
            }
          }
        }
      }
      // Opportunistic (F70, #149): a node carrying queued advisories says so in
      // its own view — the reader is already looking at exactly the node the
      // findings are about. A journal that cannot be read surfaces nothing.
      const advisories = nodeAdvisories(args.id)
      return advisories.length === 0 ? view : { ...view, advisories }
    },
    presentCall: (args) => ({ card: 'generic', title: `Read memory ${args.id}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read_file',
    // #263 W2.1: the provenance clause names the tool that PUT the file there,
    // which a read run cannot call. The sentence keeps its meaning without the
    // name rather than dropping the explanation a reader needs to understand
    // why the bulk is in a file at all.
    description: `Read back a file attached to a memory node — the bulk detail (transcripts, meeting notes, long summaries) that ${promptProfile === 'read' ? 'the write side moved' : 'memory_attach moved'} out of the node body. Get the file names from memory_search or memory_read, then open one here. Returns at most ${ATTACH_READ_BYTES} bytes at a time; when the result reports more remaining, call again with \`offset\` set to the reported next offset. Never answer from a file's one-line summary — open it.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'file'],
      properties: {
        id: { type: 'string', description: 'The 26-character id of the node carrying the file.' },
        file: { type: 'string', description: 'The attachment name exactly as memory_read or memory_search listed it.' },
        offset: { type: 'integer', description: 'Byte offset to start reading at. Omit for the start of the file; pass the previous call\'s next offset to continue.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'size', 'offset', 'bytes', 'content'],
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          size: { type: 'integer' },
          offset: { type: 'integer' },
          bytes: { type: 'integer' },
          content: { type: 'string' },
          // Present exactly when the file continues past this window; its
          // absence is the end-of-file signal.
          next_offset: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const head = value.next_offset === undefined
          ? `${value.file} on ${value.id} (${value.size} bytes${value.offset > 0 ? `, from offset ${value.offset}` : ''}):`
          : `${value.file} on ${value.id} (bytes ${value.offset}–${value.next_offset - 1} of ${value.size}):`
        const tail = value.next_offset === undefined
          ? []
          : [`…[${value.size - value.next_offset} more bytes — call memory_read_file again with offset: ${value.next_offset}]`]
        return [{ type: 'text', text: [head, '', value.content, ...tail].join('\n') }]
      },
    },
    async execute(args, exec) {
      const { versionSeen } = sessionState(sessionKeyOf(exec))
      const { result, raw } = await withNodeLocks(root, [args.id], async () => {
        // Read the attachment first: a failed file read must not fabricate
        // knowledge of a node whose requested content was never returned.
        // #247: the window and the whole-file hash come from ONE read of one
        // version (review finding 4) — hashing the pathname afterwards would
        // credit an out-of-band replacement's hash to content the caller never
        // received.
        const result = await readAttachmentWithHash(root, args.id, args.file, { offset: args.offset ?? 0 })
        const raw = await fsp.readFile(path.join(root, args.id, 'node.md'))
        return { result, raw }
      })
      versionSeen.set(args.id, hashBytes(raw))
      // `sha` is undefined for a file past the attachment cap, which no tool can
      // overwrite anyway: a partial view must never vouch for the whole file.
      if (result.sha !== undefined) {
        recordFileRead(sessionState(sessionKeyOf(exec)), args.id, result, {
          offset: result.offset,
          bytes: result.bytes,
          sha: result.sha,
          size: result.size,
        })
      }
      // The hash and the identity are bookkeeping, not part of the tool's
      // declared output.
      const { sha: _sha, dev: _dev, ino: _ino, ...view } = result
      // A read is a read: the node answered a question, so it counts the same
      // way memory_read's direct read does. Best-effort — a read that cannot be
      // logged is not a failed read.
      try {
        await touchRead(root, args.id)
      } catch { /* the file still loaded */ }
      return { id: args.id, ...view }
    },
    presentCall: (args) => ({ card: 'generic', title: `Read ${args.file} on ${args.id}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Store or update one durable fact. Omit `id` to create a node — `description` is then required, and it is the one line that must make the node findable later. Pass `id` to revise an existing node. Updating REQUIRES a memory_read of that node in this same session first — a search hit is not a read, and an update to an unread node is rejected. When the revision changes what the node says (a placeholder resolved, a decision landed), refresh `description` and `type` in the same call: both are revisable on update, and descriptions are what search and the index surface. Always pass `links` with the ids of related nodes: an unconnected node is nearly unfindable. Keep one topic per node: the FIRST fact about a new topic may ride an existing related node, but when a SECOND fact about that topic arrives, extract both into a new node created with `links` to the old one (born connected, never orphaned) — do not keep appending distinct topics to one node. Store decisions and their reasons, preferences, in-flight work state (what is pending, blocked, or still owed to the user), system facts, and gotchas — not what the repository or this conversation already answers (work state is never "answered" by the conversation that reports it pending). Identifiers are first-class content: an artifact or file id, a recording id, a task or ticket number, a deliverable\'s filename, a user\'s own alias for something goes into `body` VERBATIM — never trimmed away as detail, never reconstructed from memory. They are the exact-match retrieval keys that survive paraphrase, and a pending item without its worker id is not resumable. An attachment is the node\'s detail tier: when the turn carries detail beyond the gist — a complete list, a full option enumeration, an exact click or step sequence — or the body you are about to write recites a verbatim deliverable — a table, an enumeration of an artifact\'s items, quoted full text — pass that detail as `attach: {filename, content}` in THIS call, named for what it contains, and keep `body` a gist card (what it is, the key conclusions, the attached file\'s name): one call stores both. The split is by kind, not by degree — the body keeps the retrieval keys (identifiers, dates, names, the file\'s name, the conclusions), the file keeps the bulk (rows, steps, option lists, enumerations, verbatim passages), and a fact that is BOTH (a table of dates, a list of ids) stays complete in the file while the body keeps its range, its count and the load-bearing member. Restating the file\'s rows in the body buys nothing: a search row quotes the matching row back out of the file itself. Never trim the detail file down to what the body left out — a deliverable compressed into body prose cannot be re-served when the user asks for it back. Attach the detail this exchange carries — your own summary or reorganisation of what was said counts, and is the usual case. What does not is an artifact the turn merely NAMES: its contents are not yours to supply, an invented payload is rejected as untraceable, so store the gist and what is still owed instead. A memory-update turn always ends in a write: when nothing certain emerged, store one node naming what the conversation covered and which questions it left open, rather than storing nothing; when everything it carries is already stored, revise or link the covering node by `id`, recording at least the re-confirmation — only a segment with nothing durable at all ends without a write, and never with a node that just says so.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Existing node to update — memory_read it this session first, or the write is rejected. Omit to create a new one.' },
        description: { type: 'string', description: 'One line naming the fact: at most 500 chars, no newlines; detail goes in `body`. Required when creating.' },
        body: { type: 'string', description: 'The fact itself, in full. Markdown.' },
        // F89 (#219; ADR-0014): a FIELD, not a tool — a schema is re-sent on
        // every step, and a new tool's 500-1,500 chars of self-description at
        // 596 steps is 85k-250k input tokens per arm, plausibly more than the
        // route saves; this description is budgeted at ~200 chars for the same
        // reason. Present only when the deployment opted in, so a model on a
        // default composition never sees a field the boundary would reject.
        ...(appendWrites ? { append: { type: 'string', description: 'Text to add below the stored body, which is kept verbatim (the blank line is inserted for you). Needs `id` and no other field. On handoff/thread/journal nodes no prior memory_read is needed.' } } : {}),
        type: { type: 'string', enum: [...NODE_TYPES, ''], description: 'Optional memory kind, when one clearly fits. Set on create or update; omit to leave a node as it is; pass an empty string to clear a misclassified node back to untyped.' },
        links: { type: 'array', description: 'Ids of related nodes to connect this node to (untyped symmetric edges — one link connects both directions). Every id must already exist in the graph: an id that names nothing is refused with nothing written, so copy ids from memory_search/memory_read rather than composing them. One edge takes one spelling: do not also name the same id in directed `typed_links`, and do not name a node `supersedes` is replacing — the supersede already records the relation.', items: { type: 'string' } },
        typed_links: {
          type: 'array',
          description: 'Named edges to add, each `{id, type}` with type one of supersedes/relates-to/follows-from. `supersedes` and `follows-from` record a direction (from this node); `relates-to` is symmetric like a plain link. Plain `links` stay untyped. Every target must already exist. Entries for the same target must have the same type; identical duplicates are allowed. One edge takes one spelling: a target also named in `links` (directed types) or in `supersedes` is refused with nothing written. A `supersedes` typed link marks the target replaced by this node exactly like the `supersedes` argument — the target is bannered as superseded and its attachments move here — so memory_read the target this session first: an unread or since-changed target rejects the write.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'type'],
            properties: { id: { type: 'string' }, type: { type: 'string', enum: EDGE_TYPES } },
          },
        },
        attach: {
          type: 'object',
          additionalProperties: false,
          required: ['filename', 'content'],
          description: 'A file to store on this node in the SAME call — the node\'s detail tier: the full detail (a complete list, a table, an exact step sequence, a verbatim payload) the body is a gist card for. Same node directory, same rules and same result as memory_attach, one call instead of two. Use memory_attach instead only when the bulk is already a file on disk (`from_path`) or when the node needs no other change.',
          properties: {
            filename: { type: 'string', description: 'A plain file name: no path separators, no leading dot, not a reserved name (node.md, accessed.log, __edges__, MAP.md) that SAYS WHAT THE FILE CONTAINS (`magento-orders-grid-columns.md`). Use the deliverable\'s real name when it has one — a filename is an identifier the user will later ask by ("那份周报" resolves through `…-2025W32.md`), so a generic `attachment.md`/`notes.md` throws that handle away. Name it in the body too, beside the artifact id it was delivered under.' },
            content: { type: 'string', description: 'The file\'s full text, the detail this conversation carries, organised and summarised however serves it \u2014 never a document invented because the turn merely named one: an untraceable payload is rejected and nothing is written. Attaching a name that already exists overwrites it, so pass the whole replacement \u2014 and only after opening that file with memory_read_file this session (every page): replacing a file you have not read is refused. An empty string is refused when it would replace a non-empty file.' },
          },
        },
        supersedes: { type: 'string', description: 'Id of a node this new node replaces (create only, not combinable with `id`). Records the new node as the successor of the old one — adds a typed `supersedes` edge from the new node to it and prepends a "Superseded by … on <date>." banner to the old body, without rewriting or deleting it. The old node\'s attached files move to this new node, so bulk detail follows the live head. Use when new information changes a past decision; the old rationale stays on record.' },
      },
    },
    // A serialized `attach` is parsed, not rejected (F78, #171). Round 13's
    // first use of the one-call path passed the exact {filename, content}
    // shape as a JSON STRING, drew `arguments.attach must be object`, and the
    // model recovered with a body rewrite plus a standalone memory_attach —
    // silently regressing to the two-call flow F74 exists to remove, with
    // nothing anywhere recording that the inline path was attempted. Both
    // prompt surfaces already state the object shape, so this is not a
    // documentation gap: a nested object argument arrives serialized often
    // enough that the boundary owns the repair. A string that does not parse
    // stays a string, and one that parses to a non-object is substituted as
    // parsed — either way validation below still rejects it with the same
    // clear violation as before (see the coerce contract in tool.js).
    coerce: (args) => {
      if (typeof args?.attach !== 'string') return args
      try {
        return { ...args, attach: JSON.parse(args.attach) }
      } catch {
        // F78.1 (#157/#171): the synthetic pair serialized `attach` AND left the
        // payload's own `"` unescaped, so `JSON.parse` died mid-content and
        // F78's coercion handed back the string unchanged — the boundary
        // rejected the call, and the model fell back to write-then-attach.
        // That split is what let a body naming the file land BEFORE the
        // traceability gate saw the file, which is how a node ends a run
        // promising an attachment that was refused. Salvaging the two known
        // keys keeps the one-call path intact, where the refusal costs the
        // node nothing. Deliberately narrow: the exact `{"filename": …,
        // "content": …}` prefix this shape always carries, nothing else.
        const salvaged = salvageSerializedAttach(args.attach)
        return salvaged === undefined ? args : { ...args, attach: salvaged }
      }
    },
    // Pure argument-shape contradictions are rejected HERE, inside the trusted
    // preparation (26102311): a rejection proves the handler never ran, which is
    // what lets the runtime wrapper mark the call `executionStarted: false`.
    // Nothing stateful belongs in this hook — those checks stay in the handler.
    semantic: placeholderGuards ? (args) => [...writeArgumentViolations(args), ...placeholderWriteViolations(args)] : writeArgumentViolations,
    // Audited pre-mutation refusals (#245, #247, #253). Only the branches
    // below may mint a code, and only through `defineTool`'s scoped helper — no
    // error text, class or result shape can earn this trust. Each code means
    // THIS call threw at a branch the source audit established runs before any
    // graph content was modified; the node lock is the same lock the ordinary
    // write takes. It says nothing about locks/files, and lock-release failure
    // is still unknown.
    //
    // The three `supersedes` codes (#253) come from the two PRE-CHECKS only —
    // the `supersedes:` argument before createNode, and the same guard for a
    // typed-link target. Their locked re-checks are deliberately unbranded:
    // those run after the call has written (a published successor, or a landed
    // update), so a throw there is never a provable no-op.
    auditedRefusals: [
      'update_unread',
      'update_stale',
      'update_contradicted_figure',
      'update_target_missing',
      'attach_overwrite_unseen',
      'supersede_unread',
      'supersede_stale',
      'supersede_target_missing',
      'link_target_missing',
    ],
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'created', 'description', 'links', 'similar', 'link_candidates'],
        properties: {
          id: { type: 'string' },
          created: { type: 'boolean' },
          description: { type: 'string' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['to', 'status'],
              properties: { to: { type: 'string' }, status: { type: 'string', enum: ['created', 'exists', 'failed'] } },
            },
          },
          // Both advisory, populated only on the create path (empty on update).
          // `similar`: existing nodes that likely restate this fact (F6, #15).
          // `link_candidates`: top related nodes to consider linking (F9, #18).
          similar: { type: 'array', items: SUGGESTION_SCHEMA },
          link_candidates: { type: 'array', items: SUGGESTION_SCHEMA },
          // Present only when `supersedes` was passed (F4, #13): the old node's
          // id, whether its banner was newly added or already there, and how
          // many of its attachments followed to this node (F41, #61).
          superseded: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'status', 'files_moved'],
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['banner-added', 'already'] },
              files_moved: { type: 'integer' },
            },
          },
          // Present only when this call carried an inline `attach` that landed
          // (F74, #163) — the same {file, bytes, status} memory_attach returns,
          // so one payload reads the same however it was stored.
          attached: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'bytes', 'status'],
            properties: {
              file: { type: 'string' },
              bytes: { type: 'integer' },
              status: { type: 'string', enum: ['created', 'overwritten'] },
            },
          },
          // Present only when an inline `attach` FAILED after the node write
          // had landed (F74, #163): the failure, verbatim. The write is kept —
          // see the execute comment for why it is not rolled back — so this is
          // the one surface that keeps the payload from being believed stored.
          attach_failed: { type: 'string' },
          // Present only when the attachment this call stored landed under a
          // generic name (F82, #191): the name, verbatim. Advisory — the file
          // is stored as asked; what is lost is the retrieval handle its name
          // could have been. `observation.txt` (F79) is exempt.
          generic_filename: { type: 'string' },
          // Present only when the raw prompting turn was auto-captured as
          // observation.txt (F79, #180): the same {file, bytes, status} an
          // inline attach reports, with an added 'unchanged' status for a
          // re-observed page whose observation was already stored. An outcome,
          // not an advisory — the node write already landed and this is best-
          // effort beside it, so it never blocks and is not journaled.
          observation: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'bytes', 'status'],
            properties: {
              file: { type: 'string' },
              bytes: { type: 'integer' },
              status: { type: 'string', enum: ['created', 'overwritten', 'unchanged'] },
            },
          },
          // Present only when the body just written is long enough to warrant
          // the offload-the-bulk nudge (F21, #37): its length in characters.
          long_body: { type: 'integer' },
          // Present only when the body just written carries a deliverable-
          // shaped payload — a multi-row table, a long enumeration, a quoted
          // block (F73, #159): a short descriptor of the shape seen. The
          // sibling `long_body` fires on size; this fires on SHAPE, because at
          // turn granularity a recited artifact arrives in slices no size bar
          // ever sees.
          verbatim_deliverable: { type: 'string' },
          // Present only when the body just written left the node past the
          // per-node size cap (F70, #149): its total length in chars. Unlike
          // `long_body` (move bulk into an attachment), this asks for TOPICS
          // to move into linked child nodes.
          node_size: { type: 'integer' },
          // Present only when the node just written carries more edges than
          // the degree cap (F70, #149): its edge count. The node is becoming
          // a hub; per-topic facts belong in their own linked children.
          node_degree: { type: 'integer' },
          // Present only when a link THIS call created pushed a peer past the
          // degree cap (F70, #149, codex round 2): a symmetric edge grows both
          // ends, so hubs accrete through incoming links without ever being
          // the written node. Each entry is the peer and its new edge count;
          // journaled as node_degree about the peer.
          hub_links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'degree'],
              properties: { id: { type: 'string' }, degree: { type: 'integer' } },
            },
          },
          // Present only when an id-addressed update changed the body of a
          // node this Session never read (F62, #107): the prior body's length
          // in chars — the text that was rewritten from recollection. About
          // Session state, so it rides alongside the content advisories below rather
          // than instead of either.
          blind_rewrite: { type: 'integer' },
          // Present only on an `append` (F89, #219): the body's length after
          // the join — the one measurement a read-free write cannot make for
          // itself, and what long_body and node_size speak to when they fire
          // beside it.
          body_chars: { type: 'integer' },
          // Present only when an `append` restates the body past
          // APPEND_RESTATED_COVERAGE (F89, #219): the share the body already
          // carried, in whole percent. Advisory — the append landed.
          restated_append: { type: 'integer' },
          // Present only when an in-place update replaced a non-empty body
          // with one sharing NONE of its topic vocabulary (F47, #80): the
          // prior body's length in characters — text that is now gone.
          replaced_body: { type: 'integer' },
          // Present only when an in-place update kept some prior text but
          // shrank the body past the lossy thresholds (F52, #88): how many
          // chars the body lost. Mutually exclusive with `replaced_body`,
          // which owns the keep-nothing case.
          dropped_body: { type: 'integer' },
          // Present only when a body revision dropped EVERY identifier-shaped
          // token the prior body carried (F55, #91): the dropped ids verbatim,
          // capped at DROPPED_IDS_CAP. About WHICH strings went, which no char
          // count can say, so it rides alongside the advisories above.
          dropped_ids: { type: 'array', items: { type: 'string' } },
          // Present only when a body revision left `description` untouched
          // (unsupplied or echoed verbatim) and suspect — the change was
          // substantial, or the description carries a placeholder marker
          // while the body moved on (F52, #88): the description exactly as
          // it still stands.
          stale_description: { type: 'string' },
          // Present only when a body supplied this call asserts a concrete
          // event about the assistant (助手…检索/告知/未生成/捏造/被…纠正 and
          // the English equivalents) in a line that quotes no source and — on
          // update — was not already in the prior body (F71, #157): up to
          // three such lines. The plugin never sees the turn, so this flags
          // the assertion's SHAPE (an uncited claim about assistant
          // behaviour), never its truth.
          unsourced_assertions: { type: 'array', items: { type: 'string' } },
          // Present only when a line supplied this call pairs a vague time
          // phrase with the precision that resolved it — a relative-week word
          // beside a resolved ISO date in the same clause, or a deferral
          // beside a hard no-schedule qualifier — with no inference marker or
          // quoted source on the line, and (on update) not already in the
          // prior body (F72, #152): up to three such lines. Same blindness as
          // its F71 sibling: this flags the pairing's SHAPE, never whether
          // the source actually stated the precise half.
          minted_precision: { type: 'array', items: { type: 'string' } },
          // Present only when this write's content matches a pending item
          // still open in another live handoff/thread node (F61, #106): up to
          // two of them, each with the first matching line of its body. About
          // OTHER nodes, unlike every advisory above — the write itself was
          // fine; what is now wrong is the ledger that still calls this item
          // open.
          stale_pending: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'line'],
              properties: {
                id: { type: 'string' },
                line: { type: 'string' },
              },
            },
          },
          // Present only when the advisory journal's depth has crossed the
          // configured maintenance threshold (F70, #149): the queue depth (a
          // floor once the journal outgrows the bounded tail read). The tier-2
          // trigger — a headless maintain pass is due. Not an advisory itself
          // (see advisoryEntries): it is a reading of the queue, never queued.
          maintenance_due: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const linked = value.links.filter((link) => link.status !== 'failed').length
        const failed = value.links.filter((link) => link.status === 'failed')
        // An `append` confirms itself with the body's new size (F89, #219):
        // the one fact a read-free write cannot know, and the confirmation
        // a synthetic frozen writer would otherwise miss.
        const verb = value.body_chars !== undefined ? 'Appended to' : value.created ? 'Stored' : 'Updated'
        const size = value.body_chars !== undefined ? `, body now ${value.body_chars} chars` : ''
        const head = `${verb} ${value.id} — ${value.description} (${linked} link${linked === 1 ? '' : 's'}${size})`
        const lines = [failed.length === 0 ? head : `${head}\nUnlinked: ${failed.map((link) => link.to).join(', ')}`]
        // The supersede outcome, when this write replaced an earlier node.
        if (value.superseded) {
          const moved = value.superseded.files_moved ?? 0
          const files = moved > 0 ? ` Its ${moved} attached file${moved === 1 ? '' : 's'} moved to this node.` : ''
          lines.push((value.superseded.status === 'already'
            ? `Superseded ${value.superseded.id} — banner already present.`
            : `Superseded ${value.superseded.id} — banner added to the old node.`) + files)
        }
        // The inline attachment (F74, #163), worded exactly as memory_attach
        // reports its own — the payload reads the same however it was stored.
        if (value.attached !== undefined) {
          lines.push(`${value.attached.status === 'created' ? 'Attached' : 'Overwrote'} ${value.attached.file} on ${value.id} (${value.attached.bytes} bytes).`)
        }
        // The auto-captured raw observation (F79, #180): a stated outcome, not
        // a nag — the gist body a write left may have distilled away static
        // detail, and this line tells the writer the source turn is preserved
        // and openable with memory_read_file if it needs the dropped specifics.
        if (value.observation !== undefined) {
          lines.push(value.observation.status === 'unchanged'
            ? `Raw observation already stored as ${value.observation.file} on ${value.id} (${value.observation.bytes} bytes) — memory_read_file it for detail the gist dropped.`
            : `Captured the prompting turn as ${value.observation.file} on ${value.id} (${value.observation.bytes} bytes) — the raw observation this write is a gist over; memory_read_file it for detail the gist dropped.`)
        }
        // The write landed and the file did not. Said in the same breath, and
        // loudly: a payload silently believed stored is the loss this feature
        // exists to prevent, so name the retry rather than the failure alone.
        if (value.attach_failed !== undefined) {
          lines.push('', `The node was written but the attachment was NOT stored: ${value.attach_failed}. The write above stands and must not be repeated — store the file with memory_attach on ${value.id}, or the payload is only in this conversation.`)
        }
        // The detail tier's name (F82, #191). Advisory, in memory_attach's
        // exact words — one payload draws the same line however it was stored.
        if (value.generic_filename !== undefined) {
          lines.push('', renderGenericFilename(value.generic_filename, value.id))
        }
        // Advisory only — the node was already stored above. `?? []` guards
        // render calls made with hand-built values that predate these fields.
        const similar = value.similar ?? []
        if (similar.length > 0) {
          // Imperative on purpose (F51, #87): name the next call. The old
          // "possible duplicate(s)" phrasing left the follow-up implicit, and
          // the replay agent read past it even on the writes where it fired.
          lines.push('', `Similar node${similar.length === 1 ? ' exists' : 's exist'} — read ${similar.length === 1 ? 'it' : 'them'} first (memory_read); revise or link instead of duplicating, and keep this new node only if genuinely distinct:`)
          // F87 (#202): bound the block — the tail of this list ran to 12k-char
          // results re-sent on every later step. Highest score first (the scan
          // already returns matches score-descending; sort defensively for a
          // hand-built value) and cap at ADVISORY_ROWS_SHOWN, with a loud count
          // of what was cut so the writer knows more duplicates exist.
          const shown = [...similar].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, ADVISORY_ROWS_SHOWN)
          for (const m of shown) lines.push(`  ${m.id} — ${m.description}`)
          if (similar.length > shown.length) lines.push(`  … ${similar.length - shown.length} more`)
        }
        // Advisory too: the long body is stored as written, never truncated.
        // F87 (#202): the rule and the next call, one line — the examples of
        // what counts as bulk detail are cut (the prompt already carries them).
        if (value.long_body !== undefined) {
          lines.push('', `Long body (${value.long_body} chars) — move bulk detail into an attachment via memory_attach and keep the body a gist.`)
        }
        // The shape sibling (F73, #159): long_body fires on size, this on
        // verbatim-deliverable shape — at turn granularity a recited report
        // arrives in slices too small for any size bar. Advisory like its
        // sibling.
        //
        // F82 (#191) narrows its own-synthesis escape hatch (codex review of
        // #192). The old closing clause — "if these lines are your own
        // synthesis, keep them in the body, no attachment needed" — was the
        // pre-F82 stance that authorship decides, and it now contradicts the
        // tier: a complete list or table is detail whoever composed it, and
        // only ORDINARY PROSE is exempt. The detector already fires on shape
        // alone (three table rows, eight list items, three quoted lines), so
        // every text reaching this branch is structured; what changes is that
        // self-authorship no longer excuses it.
        //
        // It cannot nag a compliant writer into a loop: the ask is a detail
        // FILE, never a stripped body — the summary stays — and a body that
        // keeps only a short summary sits under the detector's floors, while a
        // write that attaches in the same call takes the second `fix` branch,
        // which asks for nothing further.
        //
        // The long_body branch stays provenance-aware (codex round 2 of #159):
        // when the size rule fired on the same write, this copy defers to it
        // instead of issuing a second, differently-worded instruction.
        if (value.verbatim_deliverable !== undefined) {
          // F87 (#202): the rationale (why structured detail is the
          // attachment's material) is cut to one line, but the THREE branch
          // distinctions each F-number here earns stay intact — the detector is
          // untouched, and what the advisory ASKS FOR still turns on whether the
          // payload already rode this call and whether long_body also fired.
          const synthesis = value.attached !== undefined
            ? ''
            : value.long_body === undefined
              ? ` Composing it yourself is no exemption — only running prose has no detail tier.`
              : ` Composing it yourself is no exemption; the Long body advisory above still stands.`
          // The one-call path (#163) is a pointer for the NEXT write; the
          // already-attached branch asks for nothing further so it cannot read
          // as a contradiction (F82, #191).
          const fix = value.attached === undefined
            ? `Store the full version with memory_attach and keep this body the gist card; the summary stays here.`
            : `You stored ${value.attached.file} this call — nothing left to attach; just confirm the body is the gist card.`
          lines.push('', `This body carries ${value.verbatim_deliverable} — the shape of a verbatim deliverable. ${fix}${synthesis}`)
        }
        // The tier-1 granularity advisories (F70, #149). Same posture as
        // long_body — the write landed — but a different fix: not "move the
        // bulk out", "move the TOPICS out". Both name the split rule's safe
        // shape: the child is created WITH links, so a split can never mint an
        // orphan.
        // F87 (#202): one line each — the "one topic per node keeps facts
        // findable" rationale is cut, but the split rule's safe shape (a child
        // born WITH links, never an orphan) stays, since it is the fix itself.
        if (value.node_size !== undefined) {
          lines.push('', `This node's body is ${value.node_size} chars — likely several topics. Split each into its own node created with links: ["${value.id}"], then trim here.`)
        }
        if (value.node_degree !== undefined) {
          lines.push('', `This node carries ${value.node_degree} edges — it is becoming a hub. Link new facts to the specific node they are about, not this one.`)
        }
        // The peer's half of the degree check (F70): the written node is fine;
        // the node it was linked TO is the one accreting.
        for (const hub of value.hub_links ?? []) {
          lines.push('', `This link pushed ${hub.id} to ${hub.degree} edges — it is becoming a hub. Link the specific node a fact is about; consider splitting ${hub.id} into children.`)
        }
        const candidates = value.link_candidates ?? []
        if (candidates.length > 0) {
          lines.push('', 'Related nodes — pass the genuinely related ones as `links` in a follow-up memory_write:')
          // F87 (#202): same bound as `similar`. The execute side already slices
          // to 3, so this is defensive for a hand-built value; highest score
          // first, capped, with a loud count of the remainder.
          const shown = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, ADVISORY_ROWS_SHOWN)
          for (const m of shown) lines.push(`  ${m.id} — ${m.description}`)
          if (candidates.length > shown.length) lines.push(`  … ${candidates.length - shown.length} more`)
        }
        // The process guard (F62, #107), ahead of the two content advisories
        // it explains: they report what the rewrite KEPT, this one reports
        // that the writer never saw what it was rewriting. Same after-the-fact
        // posture as its siblings, and it names the next call the way the F51
        // duplicate advisory does — the old implicit phrasing was read past.
        // F87 (#202): one line — read the body, restore any dropped fact (the
        // prior text is on disk), or add facts as a new linked node.
        if (value.blind_rewrite !== undefined) {
          lines.push('', `You replaced a body you have not read this turn (${value.blind_rewrite} chars, from recollection) — read it with memory_read ${value.id}. Restore any dropped fact (prior text is in .node.md.prev), or add new facts as a new linked node.`)
        }
        // The append restatement (F89, #219), beside the process guard it is
        // the read-free counterpart of: the append landed, and the one thing
        // the writer can do about a duplicate it could not see is read before
        // the next one. Advisory, never a refusal (CONTEXT.md).
        if (value.restated_append !== undefined) {
          lines.push('', `This append restates the body — ${value.restated_append}% of it was already there. memory_read ${value.id} before appending again, and add only what the node does not yet say.`)
        }
        // Loud, after the fact — the write already landed (F47, #80). An
        // in-place write keeps no history, so this is the one moment the
        // prior text can still be restored from the model's own context.
        // F87 (#202): one line — same fix, no restated rationale.
        if (value.replaced_body !== undefined) {
          lines.push('', `This update REPLACED the node's entire prior body (${value.replaced_body} chars, no history kept). Restore any removed user-stated fact with memory_write, or record it as a NEW node with supersedes.`)
        }
        // The lossy-shrink sibling (F52, #88): same voice, same posture — the
        // write already landed, and this is the one moment the dropped text
        // can still be restored from the model's own context.
        if (value.dropped_body !== undefined) {
          lines.push('', `This update dropped a ~${value.dropped_body}-char portion of the node's prior body (no history kept). Restore any dropped fact with memory_write, or record it as a NEW node with supersedes.`)
        }
        // The provenance nudge (F55, #91), after the size advisories because it
        // says what they cannot: which strings went. Imperative, and it quotes
        // the ids — this render is the last place they still exist outside the
        // source conversation.
        const droppedIds = value.dropped_ids ?? []
        if (droppedIds.length > 0) {
          // "including", not a bare list: the payload is capped at
          // DROPPED_IDS_CAP, so a body that carried more would otherwise have
          // the render assert a complete manifest it is not (codex review).
          // F87 (#202): one line — the ids (the offending list) stay; the
          // why-ids-matter rationale is cut.
          lines.push('', `This revision dropped every identifier the prior body carried, including ${droppedIds.join(', ')}. Put them back with memory_write passing this id, unless the fact is gone.`)
        }
        // Stale-description nudge (F52, #88). Descriptions are the retrieval
        // surface — the injected index and search rows are built from them —
        // so a body that moved on without its description makes the graph
        // misdescribe what it knows. Advisory only; nothing is rewritten.
        if (value.stale_description !== undefined) {
          // The placeholder wording is a CONDITIONAL on purpose (codex review
          // of #100): marker absence in the new body is no proof the pending
          // item resolved, so the advisory claims only what is certain — the
          // description advertises a pending state — and leaves "did this
          // update resolve it?" to the one party who knows.
          // F87 (#202): one line per branch — the "descriptions build search
          // and the index" rationale is cut; the certain claim (the description
          // still advertises a pending state) and the fix stay.
          const marker = placeholderMarker(value.stale_description)
          lines.push('', marker !== undefined
            ? `Body revised while the description still advertises a pending state ("${marker}") — "${value.stale_description}". If this update resolved it, refresh the description (and \`type\`) with memory_write passing this id.`
            : `Body revised but description unchanged — confirm "${value.stale_description}" still summarizes the node. Refresh it (and \`type\`) if stale, with memory_write passing this id.`)
        }
        // The evidence gate (F71, #157), after the description nudge because
        // it is still about the node just written. Imperative like its
        // siblings, and it names both sanctioned fixes — quote the turn, or
        // write the no-change line — because the observed failure has no
        // third option: an uncited assistant-behaviour claim is either a
        // quote the writer forgot or an episode that never happened.
        const assertions = value.unsourced_assertions ?? []
        if (assertions.length > 0) {
          // F87 (#202): the rule and the two sanctioned fixes, one line — the
          // 用户说「…」 worked example and the "why nothing can check it" gloss are
          // cut. The exact ledger form and the handoff/thread target are kept:
          // they are operative rules, not prose (codex review of #202). The
          // offending lines (the text to fix) stay listed below.
          lines.push('', `This write asserts what the assistant did (${assertions.length === 1 ? 'the line below' : `${assertions.length} lines below`}) without quoting a source. Quote the EVENT verbatim (「…」) with memory_write passing this id, or drop the line — and on an open handoff/thread ledger record the open state instead: 状态未变（turn N 无新信息）, with this turn's number or today's date for N:`)
          for (const line of assertions) lines.push(`  ${line}`)
        }
        // The minted-precision gate (F72, #152), beside its F71 sibling — the
        // same mechanism at qualifier granularity, and the same two sanctioned
        // fixes: quote the source, or mark the inference as one.
        const minted = value.minted_precision ?? []
        if (minted.length > 0) {
          // F87 (#202): the rule and the three fixes, one line — the examples of
          // the vague/precise pairing are cut. Offending lines stay below.
          lines.push('', `This write pairs a vague phrase with precision that resolves it (${minted.length === 1 ? 'the line below' : `${minted.length} lines below`}) — the precise half may be your inference. Quote the source's words (「…」), mark yours 推断 (a resolved date as 「…, 以<anchor date>为基准」), or drop it, with memory_write passing this id:`)
          for (const line of minted) lines.push(`  ${line}`)
        }
        // The close-out sweep (F61, #106), last because it is the one advisory
        // pointing AWAY from the node just written. Imperative like `similar`
        // and `blind_rewrite`: it names the node, the line, and the turn the
        // fix belongs in — the earlier "possible …" phrasings were read past.
        const pending = value.stale_pending ?? []
        if (pending.length > 0) {
          lines.push('', pending.length === 1
            ? `This write may resolve a pending item in ${pending[0].id} — memory_read it and update or close that item this turn (mark it delivered, or drop the line). A pending list that survives its own resolution is a lie:`
            : `This write may resolve pending items in ${pending.map((m) => m.id).join(' and ')} — memory_read each and update or close those items this turn (mark them delivered, or drop the lines). A pending list that survives its own resolution is a lie:`)
          for (const m of pending) lines.push(`  ${m.id} — ${m.line}`)
        }
        // The tier-2 trigger (F70, #149), dead last: it is about the GRAPH,
        // not this write, and the agent's only move is to relay it.
        if (value.maintenance_due !== undefined) {
          lines.push('', `Maintenance due: ${value.maintenance_due} advisories queued at the graph root — tell the user the graph needs a maintenance pass (headless maintain agent).`)
        }
        // F87 (#202): a hard ceiling on the whole result. The per-block bounds
        // above keep an ordinary write well under it; this is the backstop for a
        // pathological write that trips many advisories at once, so the result
        // re-sent on every later step of a turn can never run to the 12k-char
        // tail this feature exists to cut. Loud like ADR 0006's other bounded
        // surfaces — a marker, never a silent cut, so the writer knows more
        // fired than is shown.
        //
        // Only the advisory TAIL is bounded, never the outcome head (codex
        // review of #202): the head carries the id, the description (which
        // node-new/updateNode let run past the ceiling on their own) and the
        // link count, and a truncation that ate it would report a bogus
        // "advisories omitted" on a clean write and hide which node landed. So
        // the head is always emitted whole and the tail fills what budget
        // remains — if the head alone exceeds the ceiling the outcome still
        // wins, since a legible write result beats the byte cap here.
        const outcome = lines[0]
        const tail = lines.slice(1).join('\n')
        const text = tail === '' ? outcome : `${outcome}\n${tail}`
        if (text.length <= RESULT_CHAR_CEILING) return [{ type: 'text', text }]
        // Room the tail may occupy: the ceiling minus the whole outcome head,
        // the joining newline, and the marker (so the surface, marker included,
        // stays bounded). The trailing high-surrogate strip mirrors the
        // memory_read body cut (never split a surrogate pair).
        const budget = RESULT_CHAR_CEILING - outcome.length - 1 - RESULT_TRUNCATED_MARKER.length
        const cut = budget > 0 ? tail.slice(0, budget).replace(/[\uD800-\uDBFF]$/, '') : ''
        // The marker means advisory text was dropped — so it rides only a cut
        // that actually shortened the tail (codex review of #202). A clean write
        // whose own outcome head runs past the ceiling drops nothing, and must
        // never be stamped "more advisories fired than fit."
        if (cut.length === tail.length) return [{ type: 'text', text }]
        return [{ type: 'text', text: `${outcome}\n${cut}${RESULT_TRUNCATED_MARKER}` }]
      },
    },
    async execute(args, exec, refusal) {
      // The audited-refusal helper supplied by `defineTool` (#245). It binds the
      // ORIGINAL error object to this exact definition, exec and invocation and
      // returns that SAME instance, so direct plugin callers still receive the
      // same Error (message, class and stack unchanged) and the wrapper can only
      // record it as an error receipt, never as a success. `undefined` for a
      // definition that declared no codes — the error is then thrown unbranded.
      const brandRefusal = (code, error) => (refusal === undefined ? error : refusal(code, error))
      const auditedRefusal = (code, message) => brandRefusal(code, new Error(message))
      // The attachment-overwrite guard's own brand (#247 × #245): both its
      // unlocked pre-check and its authoritative under-lock re-check run before
      // any write, so a refusal there is provably pre-mutation.
      const refuseUnseenOverwrite = (error) => brandRefusal('attach_overwrite_unseen', error)
      // The provenance transitions this call actually made (#317), in the order
      // they landed. The handler's single flush reads this in its `finally`, so
      // a transition that committed before a later throw still gets its line.
      const provenanceLines = []
      // The instant this call's mutations are stamped with, so a line's `ts` is
      // the write's own clock reading rather than a later one.
      const provenanceAt = Date.now()
      // The provenance flush is the LAST thing this call does — in `finally`, so
      // every exit path flushes, and after the node locks above have released.
      try {
        const { seenBodies, versionSeen } = sessionState(sessionKeyOf(exec))
        let id = args.id
        let created = false
        let description
        // What the write will actually persist (F63, #108): an escaped body is
        // unescaped once by the graph layer, so every advisory below — the
        // duplicate scan, the F47/F52 loss comparisons, the long-body nudge —
        // must measure the repaired text, not the escaped argument. Only the
        // measurements use it; createNode/updateNode still receive `args.body`
        // and perform the one decode themselves (decoding is not idempotent: a
        // doubly-escaped body would lose a second layer to a second pass).
        // `let`, for one reassignment: an `append` (F89) joins its text onto the
        // stored body INSIDE the node lock, and from there `body` is the joined
        // text so every advisory after the lock measures what a full write
        // would have. Before the lock an append leaves `body` undefined, which
        // is what keeps the F47/F52/F55/F62 loss comparisons silent — an append
        // cannot lose anything, and none of them has a prior to compare.
        let body = args.body === undefined ? undefined : normalizeBody(args.body)
        const appendText = args.append === undefined ? undefined : normalizeBody(args.append)
        // Both advisory outputs; only the create path fills them (#15, #18).
        let similar = []
        let linkCandidates = []
        // The supersede outcome (F4, #13), present only when `supersedes` is used.
        let superseded
        // The inline attachment (F74, #163): what landed, or why it did not.
        let attached
        let attachFailed
        // Whether the overwrite this call publishes keeps a `.<name>.prev` copy
        // (#247). False when no snapshot obligation remains — this Session created
        // the file, or already holds the bytes from before its own first overwrite
        // aside — so `.prev` stays anchored there instead of chasing its own
        // writes to a 2-byte file, the incident's second overwrite. This is the
        // snapshot OBLIGATION, not authorship (review finding 3): an
        // identical-bytes write authorizes but preserves nothing.
        let attachSnapshot = true
        // What the write leaves owed, filled by the guard: `{ state, preserved,
        // identical }` from the target it inspected.
        let attachVerdict = { state: 'missing', preserved: false, identical: false }
        /**
         * Store this call's inline attachment on the UPDATE path — a create
         * publishes its attachment through createNode instead, in the same
         * rename as the body. LOCK-FREE by contract, exactly like `supersede`
         * and `updateNode`: the caller is already inside the critical section
         * that writes the node itself, and `withNodeLocks` is deliberately
         * non-reentrant (F68, #130), so acquiring here would deadlock.
         * Publishing the body and the file in ONE section is the point (codex
         * pre-merge review of #165): a second scope after the first was released
         * let a peer's body land between them, pairing this call's payload with
         * somebody else's gist while both calls reported success. Readers stay
         * lock-free by design (ADR-0013), so a reader can still catch the gist a
         * moment before its file — what the lock buys is that no WRITER
         * interleaves.
         *
         * Failure is recorded, never thrown: the node write has landed by the
         * time this runs, it is gated and public, and an in-place update keeps
         * no history to undo — so the caller reports `attach_failed` rather than
         * unwinding a good write or handing back a bare error that invites a
         * duplicate create.
         */
        const inlineAttach = async () => {
          if (args.attach === undefined) return
          try {
            attached = await attach(root, id, args.attach.filename, args.attach.content, { snapshot: attachSnapshot })
            // #317: the file landed, so this call's attach is a real transition.
            provenanceLines.push({ id, op: 'attach', file: args.attach.filename })
            // This Session wrote these bytes, so it need not read them back before
            // replacing them again (#247) — but the snapshot obligation is decided
            // separately, and a failed attach leaves the entry untouched.
            await recordFileWritten(exec, id, args.attach.filename, Buffer.from(args.attach.content, 'utf8'), preservedAfterWrite({
              existed: attachVerdict.state !== 'missing',
              preservedBefore: attachVerdict.preserved,
              identical: attachVerdict.identical,
            }))
          } catch (error) {
            attachFailed = error.message
          }
        }
        // The auto-captured raw observation (F79, #180), reported like `attached`.
        let observation
        /**
         * Decide whether to auto-capture the raw prompting turn as
         * observation.txt (F79, #180), and return its `{filename, content}` or
         * undefined. `gistLen` is the length of the gist text THIS call actually
         * stored — the create path always has a description, the update path
         * passes only the new body/description it supplied, so a links- or
         * type-only update (which distilled nothing this turn) never captures
         * (codex review of #180). Skipped when the call volunteered its own inline
         * attach: the model did not silently discard a payload it handed over.
         *
         * The capture is published by the caller INSIDE the same critical section
         * that writes the body — createNode's atomic rename on create, the update
         * lock on update — so a peer's gist can never pair with this turn's
         * observation (codex review of #180). deriveMessages/degrade all live in
         * promptingTurn; this is pure and never throws.
         */
        const observationPayload = (gistLen) => {
          if (args.attach !== undefined || gistLen <= 0) return undefined
          const turnText = promptingTurn(exec)
          if (turnText === undefined || turnText.length < AUTO_OBSERVE_MIN_TURN) return undefined
          if (turnText.length / gistLen < AUTO_OBSERVE_RATIO) return undefined
          if (Buffer.byteLength(turnText, 'utf8') <= ATTACH_MAX_BYTES) return { filename: OBSERVATION_FILE, content: turnText }
          // A cut the reader cannot see is the failure this whole issue is about
          // one layer down (F81, #182; overlaps #186): an answer turn that pages
          // observation.txt to its end must not read a silent stop as "the page
          // did not contain it". The marker is deterministic, so the F79 dedup
          // still recognises an identical re-observation.
          //
          // The room for the marker is reserved BEFORE the cut, so the count it
          // reports is the count actually dropped (codex review of #182). Capping
          // to the cap and shaving again for the marker would leave the marker
          // quoting the first cut's number and understating the loss by its own
          // length.
          const head = capUtf8(turnText, ATTACH_MAX_BYTES - OBSERVATION_MARKER_RESERVE)
          return {
            filename: OBSERVATION_FILE,
            content: `${head}\n…[observation truncated at the ${ATTACH_MAX_BYTES}-byte attachment cap: ${turnText.length - head.length} more chars of the prompting turn were not stored]\n`,
          }
        }
        // The prior body length when an update rewrote a body this Session never
        // read (F62, #107).
        let blindRewrite
        // The prior body length when an update wholesale-replaced it (F47, #80).
        let replacedBody
        // Chars lost when an update shrank the body lossily (F52, #88).
        let droppedBody
        // Identifiers the prior body carried and the revision does not (F55, #91).
        let droppedIds
        // The untouched description a substantial body revision left behind (F52, #88).
        let staleDescription
        // New assistant-behaviour assertion lines with no quoted source (F71, #157).
        let unsourcedAssertions = []
        // New lines pairing vague source phrasing with minted precision (F72, #152).
        let mintedPrecision = []
        // The body's length after an `append` joined it (F89, #219), and the
        // share of the appended text the body already carried, when past the
        // advisory threshold.
        let bodyChars
        let restatedAppend
        // Argument-shape contradictions (`supersedes` with `id`, and every
        // `append` restriction) are rejected by this tool's `semantic`
        // preparation, inside defineTool's trusted pipeline (26102311), BEFORE
        // this handler is entered. They are deliberately not repeated here: one
        // authority means the wrapper's precheck and this execution cannot
        // disagree, and a second copy after the awaits would only muddy which
        // rejection a receipt is evidence for. State-dependent rules — the
        // supersede target's existence/read/version, attachment traceability,
        // disk failures — stay below, where a throw is honestly uncertain.
        // The inline attachment (F74, #163) is validated HERE — synchronously,
        // before this call mutates anything — so a reserved name or a path
        // separator rejects the whole write with no node created and no update
        // landed, the same posture as the typed-supersede pre-check below.
        // Only the checks that need no disk state are hoisted; `attach()` stays
        // the authority and re-runs all of them (the empty-overwrite refusal is
        // its own, because only the node directory knows what is already there).
        // Version-gate expectation for the banner prepend (#143), captured
        // before ANY await in this call (codex review, twice): a concurrent
        // same-session write completing during even the existence check would
        // refresh the shared map and vouch for content this caller never read.
        // Hoisted above the attach pre-checks by F88.3 (#157), which made the
        // traceability gate async: the rule is before any await in the call,
        // not merely before the first await that used to be here.
        const supersedePriorHash = args.supersedes !== undefined ? versionSeen.get(args.supersedes) : undefined
        // A `supersedes` typed_link is the same mutation by another spelling
        // (#147): the target gains an incoming supersedes edge, so it gains the
        // banner, so the version gate applies — and its expectation is captured
        // with the same before-any-await discipline, one entry per target.
        // Targets also named in `supersedes` are rejected by preparation.
        const typedSupersedePrior = new Map()
        for (const { id: to, type } of args.typed_links ?? []) {
          if (type === 'supersedes' && to !== args.supersedes && !typedSupersedePrior.has(to)) {
            typedSupersedePrior.set(to, versionSeen.get(to))
          }
        }
        // The update path's own expectation, captured with the same discipline
        // (F68, #129; codex review of #147): the typed pre-checks below await,
        // and a concurrent same-Session write completing during them must not
        // refresh the shared map into satisfying an expectation this call had
        // not yet formed.
        const updatePriorHash = args.id !== undefined ? versionSeen.get(args.id) : undefined
        // Existence is graph state, so this is an audited read rather than a
        // preparation rule. Run it before attachment guards: their refusal can
        // append a correction to node.md. A target disappearing after this
        // unlocked check can still produce a post-write partial; that later
        // failure must never be certified as link_target_missing.
        for (const to of new Set([...(args.links ?? []), ...(args.typed_links ?? []).map((link) => link.id)])) {
          if ((await loadNode(root, to)) === undefined) {
            throw auditedRefusal('link_target_missing', `memory_write: cannot link — node does not exist: ${to}. Nothing was written. memory_search for the correct id, or drop it from \`links\`/\`typed_links\`; do not resend unchanged.`)
          }
        }
        // F88.1 (#157): a node whose attachment this turn already refused takes
        // no narrative — checked before the attach shape checks, so a retry that
        // drops the file and keeps the claim fails on the claim. Async since
        // F88.4 (#219): it reads the node on the rare frozen path, and awaiting
        // here is safe because every expectation this call forms was captured
        // above, before this first await.
        const frozenRetry = await refuseRestatementAfterRefusal(args.id, args.body, args.append, exec)
        if (args.attach !== undefined) {
          // `attach.filename` (a plain, non-reserved basename) and
          // `attach.content` (a string within ATTACH_MAX_BYTES) are rejected by
          // this tool's `semantic` preparation (#253), so they never reach this
          // handler — the same one-authority rule as the id shapes above.
          // `attach()` re-runs both, as the storage-layer authority. What stays
          // here is everything that needs STATE: the overwrite guard below (this
          // Session's read record), F88's turn traceability, and the disk itself.
          // #247: an overwrite of a file this Session never read is refused
          // FIRST — before F88 below, whose refusal path appends a correction to
          // the body (markUnwrittenAttachment) about a file that here still
          // exists. This unlocked pass buys the clean reject; the authoritative
          // one runs under the update's lock, after its stale checks.
          // Audited (`attach_overwrite_unseen`): this point is past every read
          // this handler does and before anything is written — no node.md, no
          // `.prev`, no attachment and no F88 correction.
          if (args.id !== undefined) {
            await refuseUnseenAttachmentOverwrite('memory_write', args.id, args.attach.filename, Buffer.from(args.attach.content, 'utf8'), exec, refuseUnseenOverwrite)
          }
          // F88 (#157): hoisted here with the other pre-write checks, so an
          // untraceable payload rejects the whole write — no node created, no
          // update landed, no file — rather than leaving a body that names a
          // document nobody can produce.
          await refuseUntraceableAttachment('memory_write', args.attach.content, exec, args.id, args.attach.filename)
        }
        // Checked once here, unlocked, BEFORE this call mutates anything — an
        // unread or already-stale typed supersede rejects with no node created,
        // no update landed, no edge, no banner. The locked re-check in the
        // typed_links loop stays authoritative, exactly like the two-step
        // `supersedes:` gate below (#143); what this pass buys is that the
        // deterministic rejects never leave partial state behind.
        //
        // AUDITED (#253): this is one of the two UNLOCKED supersede pre-checks,
        // so a refusal here is provably pre-mutation and mints `supersede_unread`
        // / `supersede_stale` — the class that quarantined a live graph on a
        // typed-link id-update (task 75bd5797). The locked re-check below is
        // deliberately NOT branded: it runs after `createNode`/`updateNode`, so
        // its throw may stand on top of a real write (a successor that a peer
        // already built on, or a body this call already landed on the update
        // path) — never a provable no-op. Missing targets have already been
        // refused by the existence check; a concurrent disappearance is still
        // handled by the locked link operation, never a fabricated proof.
        //
        // "Failed audited prefix ⇒ unbranded" (review 1 of #253): a read that
        // fails for any reason OTHER than the target being absent means this
        // pre-check did not complete, and the loop must stop rather than let a
        // LATER target mint a code. Swallowing EIO/EACCES here would certify an
        // invocation whose read of an earlier target never finished.
        for (const [to, prior] of typedSupersedePrior) {
          // A malformed or self-addressed id must not reach the gate (or a path
          // join): the loop below reports it as a failed link, as it always has.
          if (!ULID_RE.test(to) || to === args.id) continue
          let oldNow
          try {
            oldNow = await fsp.readFile(path.join(root, to, 'node.md'))
          } catch (error) {
            // A target may disappear after the existence check. Let the later
            // link operation report that race. Other I/O failures propagate
            // unbranded, so a later target cannot certify this call.
            if (error?.code === 'ENOENT') continue
            throw error
          }
          if (prior === undefined) {
            throw auditedRefusal('supersede_unread', `memory_write: ${to} has not been read this session — memory_read it before superseding it`)
          }
          if (prior !== hashBytes(oldNow)) {
            throw auditedRefusal('supersede_stale', `memory_write: ${to} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`)
          }
        }
        // Set on the create path (#144 × #147): how to unpublish this call's own
        // create when a gated supersede rejects after createNode published it,
        // and the edge targets this call itself wrote — anything else in the
        // successor's __edges__ is somebody's reference and must spare it.
        let rollbackSuccessor
        const ownEdgeTargets = new Set()
        // Whether a "Superseded by <id>" banner naming this call's create has
        // landed anywhere — from that moment the create is load-bearing and no
        // typed-link gate reject may remove it (#147). Deliberately NOT
        // consulted by the `supersedes:` block's own error path: #144 chose to
        // remove the successor even after its banner when the attachment move
        // fails (a banner naming a ghost is cosmetic and disk-error-only;
        // retries stacking successors is worse — see that catch's comment),
        // and this flag does not reverse that documented trade-off.
        let bannerLanded = false
        if (id === undefined) {
          // `description` and the id shapes are rejected by this tool's `semantic`
          // preparation (#253), so a create with no description, a malformed
          // `supersedes` id or a malformed link id never reaches this handler.
          // Validate the superseded node BEFORE creating anything, so a bad id
          // fails the whole call cleanly with no orphan half-written: no new node,
          // no edge, no banner.
          //
          // AUDITED (#253, `supersede_target_missing`): a target that does not
          // exist is a pre-mutation refusal — this is a read, and `createNode`
          // (the first write) is below. Same class as `update_target_missing`,
          // which is already certified for the update path's ENOENT.
          if (args.supersedes !== undefined && (await loadNode(root, args.supersedes)) === undefined) {
            throw auditedRefusal('supersede_target_missing', `memory_write: cannot supersede — node does not exist: ${args.supersedes}`)
          }
          // Checked once here, unlocked, BEFORE createNode publishes anything —
          // an unread or already-stale supersede rejects with no successor ever
          // visible. The locked re-check below stays authoritative and UNBRANDED:
          // it runs after `createNode`, so its throw stands on a successor that
          // may already be load-bearing (rollback is conditional — it spares a
          // node a peer built on or an earlier banner names), never on a provable
          // no-op. The residue of losing that last millisecond race is a
          // successor this call tried and failed to unpublish, whose incoming
          // edges are the dangling class graph-maintain heals.
          //
          // Audited (`supersede_unread` / `supersede_stale`): the same two codes
          // the typed-link pre-check mints — one supersede gate, whichever verb
          // spells it. The failed-prefix rule holds here by construction: the
          // existence check below is `loadNode`, which turns ONLY `ENOENT` into
          // `undefined` and propagates every other read error, and the version
          // read is an unguarded `readFile` — so neither a swallowed error nor a
          // later code can follow a read that did not complete.
          if (args.supersedes !== undefined) {
            if (supersedePriorHash === undefined) {
              throw auditedRefusal('supersede_unread', `memory_write: ${args.supersedes} has not been read this session — memory_read it before superseding it`)
            }
            const oldNow = await fsp.readFile(path.join(root, args.supersedes, 'node.md'))
            if (supersedePriorHash !== hashBytes(oldNow)) {
              throw auditedRefusal('supersede_stale', `memory_write: ${args.supersedes} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`)
            }
          }
          // Distinct query vocabulary. Dedupe deliberately: search() adds a token
          // hit's weight once per query-token OCCURRENCE, so a word repeated in a
          // long body would let a single shared term clear a threshold meant to
          // require many. A content with no searchable tokens at all (e.g. an
          // emoji-only description and empty body) would make search return the
          // whole graph — meaningless here — so scan only when there is vocabulary.
          // Cap the scan vocabulary: search() walks every node once per query
          // token, so an unbounded transcript-sized body would make this
          // advisory scan cost body-vocabulary × graph-size. The cap applies to
          // BODY tokens only — the description is the node's identity surface and
          // duplicate judgment is computed from it, so a 500-char description
          // with more than 64 distinct tokens must not have half of it dropped.
          // Han runs expand to bigrams throughout this advisory path (F51, #87):
          // the scan query, the duplicate verdict, and the link floor all compare
          // whole tokens, and an unsplit Chinese clause token matches nothing.
          const SCAN_TOKEN_CAP = 64
          const descriptionTokens = [...new Set(hanBigrams(tokenize(args.description)))]
          const seen = new Set(descriptionTokens)
          const bodyTokens = [...new Set(hanBigrams(tokenize(body ?? '')))].filter((token) => !seen.has(token) && !LETTERLESS(token)).slice(0, SCAN_TOKEN_CAP)
          const contentTokens = [...descriptionTokens, ...bodyTokens]
          // Keep bare numbers out of the SCAN too, not just out of the floor
          // (F44, #72). A year matches every dated node in the graph, so leaving
          // it in the query lets junk fill a window the floor then empties —
          // hiding the candidate the wider scan was widened for — and a body of
          // 64 distinct numbers would spend the whole vocabulary cap above on
          // terms no candidate can qualify on. Fall back to the unfiltered
          // vocabulary when a write is nothing but digits: a scan whose hits the
          // floor may reject still feeds the duplicate verdict, which reads the
          // description's own tokens and does count numbers.
          if (contentTokens.length > 0) {
            // Scan for prior art BEFORE the node exists, so it can never match
            // itself. One search, reusing the same scorer memory_search exposes;
            // bounded by searchLimit, no extra whole-graph pass.
            // No attachment text here (F29, #49): a node whose stored transcript
            // happens to carry this write's vocabulary is not a duplicate of it
            // and not a link candidate, and letting one in would evict a
            // genuinely related node from a three-row advisory.
            //
            // Scan wider than the block is deep: the relevance floor below filters
            // AFTER ranking, so substring junk that outranks a real candidate
            // would otherwise fill the window and hide it. Three times the limit
            // costs a few more rows from a scan that already walked every node.
            const queryTokens = contentTokens.filter((token) => !LETTERLESS(token))
            // Deliberately live on every write (F68, #128 audit): search() →
            // loadAll() → fresh fs.readFileSync rereads disk without memoization.
            // It bypasses cached/cachedWorkState/indexCacheMs, which only render
            // session-start banners, so ADR-0013's parallel Sessions (separate
            // plugin instances/processes) catch each other's new facts before
            // storing duplicates.
            const scan = await search(root, (queryTokens.length > 0 ? queryTokens : contentTokens).join(' '), searchLimit * 3, { includeAttachments: false })
            // A genuine duplicate re-states the fact, and the description is the
            // node's identity surface — so judge duplicates on DESCRIPTION
            // overlap alone, never the blended search score: a body that merely
            // mentions an unrelated memory's vocabulary must not flag that
            // memory as a duplicate and invite a destructive update. A candidate
            // is similar when its own description carries at least half of the
            // new description's identity units (`descriptionUnits` above: word
            // tokens for latin, per-character coverage through bigrams for Han —
            // F51, #87). A description with no searchable identity has nothing
            // to duplicate, so it never flags.
            // Advisory only — the node is created regardless.
            // Topic filtering on the new side (F26, #46): counting stopwords
            // made "This can use REST" and "This can use GraphQL" a duplicate
            // pair on three shared function words, and a duplicate verdict is
            // the one advisory that invites a destructive update. The candidate
            // side needs no filter — only the new side's topic units are ever
            // looked up in it.
            const identity = descriptionUnits(args.description)
            if (identity.size > 0) {
              similar = scan.matches
                .filter((m) => 2 * coveredUnits(identity, new Set(hanBigrams(tokenize(m.description)))) >= identity.size)
                .map((m) => ({ id: m.id, description: m.description, score: m.score }))
            }
            // Top related nodes the agent could link, minus ones it already
            // linked and minus likely duplicates (a node can't be both "update
            // this instead" and "link your new node to it"); backfill past those
            // so it always sees the best NEW targets.
            const already = new Set(args.links ?? [])
            const duplicateIds = new Set(similar.map((s) => s.id))
            // A node being superseded must not surface as advice: "update this
            // instead" would erase the very rationale supersession preserves,
            // and the supersede edge already links it. Typed supersede targets
            // count the same — one invariant, whichever verb spells it (#147,
            // codex round 2).
            const superseding = new Set(typedSupersedePrior.keys())
            if (args.supersedes !== undefined) superseding.add(args.supersedes)
            if (superseding.size > 0) {
              similar = similar.filter((s) => !superseding.has(s.id))
              for (const target of superseding) duplicateIds.add(target)
            }
            // The relevance floor (F26, #46). Ranking alone put junk in front of
            // the agent on every write — three housekeeping notes in the round-4
            // trace each drew a ClickHouse-vs-Postgres candidate, and all three
            // were ignored. Two reasons, both closed here:
            //   - search() matches SUBSTRINGS, so "is" inside "This" and "cost"
            //     inside "costs" score as hits. A candidate must now share a
            //     whole token, tokenized the same way on both sides, and a
            //     stopword, single character, bare number or framing verb is
            //     not a topic (the floor's own set is `linkTopics` above).
            //   - it scores a candidate's body as well as its description, so a
            //     node could surface for vocabulary it merely mentions in
            //     passing. The shared token must be in the candidate's own
            //     DESCRIPTION — what that node is about.
            // The new node's side stays description+body: a write whose body
            // names a prior decision is genuinely related to it (F9, #18).
            // When nothing clears the floor, the block says nothing at all.
            const topic = linkTopics(contentTokens)
            linkCandidates = topic.size === 0 ? [] : scan.matches
              .filter((m) => !already.has(m.id) && !duplicateIds.has(m.id))
              .filter((m) => hanBigrams(tokenize(m.description)).some((token) => topic.has(token)))
              .slice(0, 3)
              .map((m) => ({ id: m.id, description: m.description, score: m.score }))
          }
          // The evidence gate (F71, #157) on the create path: every assertion
          // line in a brand-new body is new. The DESCRIPTION is scanned with it
          // (codex pre-merge review of #161 round 3): a description-only create
          // was a clean bypass, and #157's own blast radius was half a
          // description — the W32 node ended the run asserting `真实性存疑`
          // about content its body carried correctly. The description goes
          // first, deduped against the body so a summary of a flagged body line
          // is not named twice.
          // The attachment is scanned WITH them (F71.1, #167): round 12 stored a
          // 1,274-char report invented whole through the inline `attach`, and no
          // gate has ever read an attachment — every scan here took
          // `[description, body]`, so the largest payload a write can carry was
          // the only unchecked one. It is a bypass close, not the fix for that
          // fabrication: measured against the actual invented file, its report
          // prose draws no fire from either gate. What caught turn 6 is the
          // artifact-subject branch above, on the body.
          // The turn joins as the gate's second operand (F71.2, #167): a quote
          // vouches only for a claim the turn also names. Same degradation as
          // F79's capture — no `exec`, no turn, F71.1's behavior unchanged.
          unsourcedAssertions = unsourcedAssertionLines([args.description, body ?? '', args.attach?.content ?? ''].join('\n'), '', promptingTurn(exec) ?? '')
          // The minted-precision gate (F72, #152) shares the create-path shape:
          // every line is new, and the description rides along — …F0BMTR's
          // description carried the deferral while the body minted the
          // qualifier, and a description could as easily carry the whole pair.
          mintedPrecision = mintedPrecisionLines([args.description, body ?? '', args.attach?.content ?? ''].join('\n'))
          // The inline attachment rides INTO the create (F74, #163; codex
          // review round 2 of #165): createNode stages the node and renames it
          // into place, so the file joins what is renamed and the node is
          // published complete — one visible state, body and payload together.
          // Attaching after the rename left three defects behind it: a peer
          // could update the freshly discoverable node before the file landed;
          // a `supersedes` create overwrote an inherited file of the same name,
          // destroying it, because supersede's collision-safe move had already
          // run; and the rollback below had to guess which files were its own.
          // A failure here is total and clean — the staging directory is removed
          // and nothing was ever published — so the create path throws rather
          // than reporting `attach_failed`, which exists for the update path,
          // where the node write cannot be taken back.
          // The auto-observation (F79, #180), measured off the NORMALIZED body
          // and trimmed description createNode actually persists, not the raw
          // arguments (codex review of #180), so an escaped-newline body is
          // measured at its stored length. When the call volunteered no inline
          // attach, it rides createNode's atomic rename in place of one: published
          // WITH the node and BEFORE any supersede's collision-safe file move, so
          // an inherited observation.txt is renamed rather than overwritten
          // (moveExtraFiles), and no unlocked second write ever exposes a public
          // node — reachable through a supersede banner — for a peer to interleave
          // (codex review of #180). `createdAttachment` is the exact payload that
          // rode the rename, which the rollback below keys on.
          const observationAttach = observationPayload(Math.max((body ?? '').length, args.description.trim().length))
          let createdAttachment = args.attach ?? observationAttach
          try {
            id = await createNode(root, { description: args.description, body: args.body ?? '', type: args.type, attachment: createdAttachment })
          } catch (error) {
            // The auto-observation is best-effort: if only that optional payload
            // cannot be written (a full disk on the 512-KiB file, say), the user's
            // node must still land, so retry without it. A volunteered inline
            // attach stays fatal (F74) — the model asked for it, so its failure is
            // loud, not silently dropped.
            if (args.attach !== undefined || observationAttach === undefined) throw error
            createdAttachment = undefined
            id = await createNode(root, { description: args.description, body: args.body ?? '', type: args.type })
          }
          description = args.description.trim()
          created = true
          // #317: the node is public from createNode on, but the line waits for
          // the flush at the end of the handler — a typed-link gate reject can
          // still roll this create back, and a rolled-back successor writes no
          // line because that path rethrows before the flush is reached.
          provenanceLines.push({ id, op: 'create' })
          // Reported exactly as attach() would: a fresh node's directory was
          // empty, so the status can only be 'created'. The payload that rode the
          // rename is reported on its own surface — a volunteered inline attach as
          // `attached`, the auto-observation as `observation`.
          if (args.attach !== undefined) {
            attached = { file: args.attach.filename, bytes: Buffer.byteLength(args.attach.content, 'utf8'), status: 'created' }
            provenanceLines.push({ id, op: 'attach', file: args.attach.filename })
            // A fresh node's directory was empty, so this is the file's first
            // version: this Session authored it and there is nothing prior to
            // preserve (#247).
            await recordFileWritten(exec, id, args.attach.filename, Buffer.from(args.attach.content, 'utf8'), true)
          } else if (createdAttachment !== undefined) {
            observation = { file: OBSERVATION_FILE, bytes: Buffer.byteLength(createdAttachment.content, 'utf8'), status: 'created' }
            // #317: the automatic capture is a file this call published, so it is
            // an attach transition like any other — a create whose gist is
            // unchanged can still mutate the graph through this file alone.
            provenanceLines.push({ id, op: 'attach', file: OBSERVATION_FILE })
          }
          if (args.supersedes !== undefined || typedSupersedePrior.size > 0) {
            // The successor is public from createNode on, and a gate reject may
            // arrive only after waiting on a contended old-node lock. Roll back
            // ONLY what this call created: if the successor's body changed or it
            // gained files while briefly public, another Session built on it — a
            // stray unlinked node is recoverable, a deleted write is not (codex
            // review, round 4). Shared by the `supersedes:` block below and the
            // typed_links supersede gate (#147) — both may need to unpublish
            // this call's create.
            const initialSuccessorHash = hashBytes(await fsp.readFile(path.join(root, id, 'node.md')))
            // #317: whether the rm below actually ran. A conditional rollback that
            // SPARES the successor leaves this call's create (and any attach that
            // rode it) committed, so those lines must survive the throw — the
            // early returns keep it false.
            rollbackSuccessor = async () => {
              let removed = false
              try {
                const entries = await fsp.readdir(path.join(root, id))
                // The one file this call itself published is the payload
                // createNode renamed in WITH the node — the volunteered inline
                // attachment (F74, #163) or the auto-observation (F79, #180),
                // whichever rode the create in `createdAttachment`. Either way it
                // is not another Session building on the successor and must not
                // veto the rollback. Matched by CONTENT, never by name alone
                // (codex round 2): a peer that overwrote that filename while this
                // call waited on the target's lock owns those bytes, and the
                // recursive rm below must not take them.
                const stray = entries.filter((name) => name !== 'node.md' && name !== '__edges__')
                if (stray.length > 1) return false
                if (stray.length === 1) {
                  if (createdAttachment === undefined || stray[0] !== createdAttachment.filename) return false
                  if (hashBytes(await fsp.readFile(path.join(root, id, stray[0]))) !== hashBytes(Buffer.from(createdAttachment.content, 'utf8'))) return false
                }
                if (hashBytes(await fsp.readFile(path.join(root, id, 'node.md'))) !== initialSuccessorHash) return false
                // A concurrent link TO the successor lands as a reciprocal entry
                // in its __edges__ without touching node.md (codex, round 5).
                // The only entries this call itself writes are its own edges,
                // tracked in `ownEdgeTargets`, and their sidecar; anything else
                // is somebody's reference.
                if (entries.includes('__edges__')) {
                  const edges = await fsp.readdir(path.join(root, id, '__edges__'))
                  if (edges.some((name) => name !== '.edge-types' && !ownEdgeTargets.has(name))) return false
                }
              } catch {
                // Unreadable means already gone or torn mid-removal — rm below is
                // force:true and settles either way.
              }
              // Residual, accepted (review round 6): a lock-free symlink landing
              // between this inspection and the rm, or a DIRECTED edge another
              // node wrote toward this successor (visible only in the source's
              // sidecar), can leave a dangling edge — the same maintenance-healed
              // class a crashed writer leaves; readers tolerate it by design
              // (ADR-0013), and no node content is ever lost. This exposure
              // predates #143 (the F41/#61 rollback had it unconditionally).
              // ponytail: closing it means staged-invisible creates or an O(n)
              // sidecar scan under lock — upgrade only if maintenance ever
              // reports it happening for real. The same class covers a rollback
              // after this call's own symmetric links landed (#147): their
              // reciprocal halves in the peers dangle until maintenance heals
              // them.
              await fsp.rm(path.join(root, id), { recursive: true, force: true })
              removed = true
              return removed
            }
          }
          if (args.supersedes !== undefined) {
            // The old id was validated above, so both steps target real nodes: a
            // typed `supersedes` edge new→old (F3, #12), then a banner on the old
            // body. One clock reading drives the banner date and the old node's
            // `updated:` stamp, so they cannot diverge.
            try {
              // One top-level lock scope covers both sidecar owners and the old
              // node's banner RMW. supersede itself stays lock-free by contract;
              // nesting another acquisition for either id would deadlock because
              // withNodeLocks is deliberately non-reentrant (F68, #130).
              await withNodeLocks(root, [id, args.supersedes], async () => {
                try {
                  // Authoritative gate check (#143): the banner prepend is an
                  // update to the old Node, so compare-then-write runs under this
                  // lock exactly like the `id` update path — against the
                  // expectation captured BEFORE the scan/create/lock queue, never
                  // a re-read of the shared map. On reject the agent's re-read
                  // shows the competing content and it reconciles instead of
                  // stamping a Node it never saw current (user story 8).
                  const oldRaw = await fsp.readFile(path.join(root, args.supersedes, 'node.md'))
                  if (supersedePriorHash !== hashBytes(oldRaw)) {
                    throw new Error(`memory_write: ${args.supersedes} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`)
                  }
                  // Own the edge only when this call CREATED it (codex, #147
                  // round 2): 'exists' on a just-published successor means
                  // another Session linked it first, and the rollback below —
                  // reachable when the gate rejects before this line runs, or
                  // when supersede() fails after it — must spare that reference
                  // rather than claim it. #144's inline allowlist predates the
                  // distinction; this is the same tightening the other loops got.
                  // Residue, accepted (codex round 3): addEdge failing AFTER its
                  // symlink landed (a .edge-types disk error) leaves that edge
                  // unowned, so the rollback spares the successor — a stray
                  // recoverable node holding an untyped half-edge, the
                  // maintenance-healed class, deliberately the safe direction
                  // (#144: a deleted reference
                  // is not recoverable). Owning the edge up front instead would
                  // reintroduce the round-2 hazard: plain edge symlinks are
                  // lock-free by design (ADR-0013), so no pre-check under this
                  // lock can prove the next symlink to appear is this call's own.
                  const minted = []
                  const receipts = []
                  try {
                    if (await addEdge(root, id, args.supersedes, { type: 'supersedes', minted }) === 'created') {
                      ownEdgeTargets.add(args.supersedes)
                    }
                    crashAt('supersede-between-edge-and-banner')
                    const { oldNode, ...supersedeResult } = await supersede(root, args.supersedes, id, undefined, receipts)
                    superseded = { id: args.supersedes, ...supersedeResult }
                    // Supersede's write is protected by this block's two-Node lock.
                    // Hash the exact Node this call wrote, not a later disk read that
                    // could capture somebody else's intervening bytes (F68, #129).
                    if (oldNode !== undefined) {
                      versionSeen.set(args.supersedes, hashBytes(Buffer.from(renderNode(oldNode), 'utf8')))
                    }
                  } finally {
                    // #321: drain INSIDE the try, before the catch's rollback, so
                    // `dropRevertedProvenance` sees the lines it must filter. The
                    // three-way rule is `supersedeOutcome`'s (design.md row 61);
                    // this path's own `bannerLanded` trade-off is below (#144).
                    provenanceLines.push(...supersedeOutcome({ receipts, minted, newId: id, oldId: args.supersedes, type: 'supersedes' }).lines)
                  }
                  // Unchanged on this path (#144's trade-off): only a supersede
                  // that RETURNED marks the banner landed, so a throw here still
                  // lets the rollback unpublish a successor — which is the only
                  // way the ghost banner below can exist. The two lines on a
                  // deleted successor are dropped with it.
                  bannerLanded = true
                } catch (error) {
                  // Roll back while still HOLDING the successor's lock: any gated
                  // update racing for the published successor is queued on this
                  // very lock, so nothing can land on it between the reject and
                  // the removal (codex review, round 3) — and the conditional
                  // spares anything that landed BEFORE this lock was acquired.
                  dropRevertedProvenance(await rollbackSuccessor(), id, provenanceLines)
                  throw error
                }
              })
            } catch (error) {
              // Keep supersede all-or-nothing: the edge lives inside the new
              // node's __edges__/, the banner write is atomic, and a failed
              // attachment move rolls itself back onto the old node (F41, #61)
              // — so removing the just-created node undoes every partial step
              // without deleting a moved file, and a retry starts clean instead
              // of stacking successor nodes. The one residue a move failure can
              // leave is the already-written banner naming this removed
              // successor: cosmetic (a marker pointing at a ghost), reachable
              // only through a disk-level error, and strictly better than the
              // reverse order, where a banner failure would delete the
              // successor WITH the files already moved into it.
              dropRevertedProvenance(await rollbackSuccessor(), id, provenanceLines)
              throw error
            }
          }
          // Creates are gate-exempt, but seeding their landed state preserves
          // the supported same-Session create-then-refine flow.
          versionSeen.set(id, hashBytes(await fsp.readFile(path.join(root, id, 'node.md'))))
        } else {
          // Snapshot from before this call performed any asynchronous work or
          // joined the Node-lock queue (F68, #129 review fix) — captured with
          // the sync block at the top, since the #147 typed pre-checks await.
          // Two concurrent updates from one Session may share one read
          // expectation; the first writer's post-write map refresh must not
          // silently satisfy the second writer's already-formed expectation and
          // authorize an overwrite.
          const priorHash = updatePriorHash
          // F47 (#80): pass-5's tidy-up session "removed" two stored credentials
          // by rewriting their bodies in place — the one write shape that keeps
          // no history. Detection here is deliberately narrow and deterministic:
          // flag an update whose new body shares NO topic token with the prior
          // body (wholesale repurposing or blanking). The advisory is loud but
          // non-blocking — legitimate full rewrites exist, and the prompt rule
          // above ("never blank or rewrite a node to delete…") owns the intent
          // side that token overlap cannot see.
          // ponytail: token-disjointness misses a tombstone that names the fact
          // it deleted; if pass 6 sees a recurrence, the upgrade is a one-deep
          // .node.md.prev snapshot on body change, not a smarter predicate.
          // One load serves the body comparisons AND the evidence gates below
          // (codex pre-merge review of #162): a description-only update reaches
          // the gates too, so the read is no longer body-gated.
          const prior = body !== undefined || args.description !== undefined || args.attach !== undefined || appendText !== undefined
            ? await loadNode(root, id)
            : undefined
          if (body !== undefined) {
            if (prior !== undefined && prior.body.trim().length > 0) {
              // Both sides run through hanBigrams (#98's review of this check):
              // tokenize keeps an unpunctuated Chinese clause as one opaque
              // token, so a paraphrase that kept the fact but reworded every
              // clause shared no whole token and read as "nothing kept".
              // Bigrams give the comparison the same word-sized units the
              // write-time advisories use; English is byte-identical, and
              // Hangul/kana/emoji still fall through to the raw-substring
              // fallback because tokenize drops them before bigrams can help.
              //
              // A tokenless prior body must not be an unprotected one (codex
              // review of this change): fall back from topic tokens to ALL
              // tokens (a stopword-only fact still compares), and when tokenize
              // yields nothing at all, to the raw text surviving as a substring.
              const newBodyUnits = new Set(hanBigrams(tokenize(body)))
              const priorTopics = topicTokens(hanBigrams(tokenize(prior.body)))
              const priorTokens = priorTopics.size > 0 ? priorTopics : new Set(hanBigrams(tokenize(prior.body)))
              const kept = priorTokens.size > 0
                ? [...priorTokens].some((token) => newBodyUnits.has(token))
                : body.includes(prior.body.trim())
              if (!kept) replacedBody = prior.body.length
              // The lossy-shrink case F47 cannot see (F52, #88): the revision
              // keeps SOME prior text — so the wholesale check above stays
              // silent — but drops a meaningful chunk. 420002 s10 rewrote a
              // 371-char node down to 288, erasing two dated facts while the
              // description kept asserting one of them. Measured in the #98
              // unit/coverage machinery: `descriptionUnits` over the prior body
              // (latin/digit tokens + Han character positions), covered through
              // the new body's bigram set. Thresholds and their reasoning live
              // on the LOSSY_* constants above. coveredUnits' two-evidence gate
              // is harmless here: any body clearing LOSSY_MIN_UNITS with real
              // coverage shares far more than two pieces of evidence, and when
              // it does not, firing is the right answer anyway — the shrink is
              // already proven by the char gate.
              if (replacedBody === undefined) {
                const priorUnits = descriptionUnits(prior.body)
                if (priorUnits.size >= LOSSY_MIN_UNITS && body.length < prior.body.length * LOSSY_SHRINK_RATIO
                  && priorUnits.size - coveredUnits(priorUnits, newBodyUnits) >= priorUnits.size * LOSSY_DROPPED_FRACTION) {
                  droppedBody = prior.body.length - body.length
                }
              }
              // The blind-rewrite guard (F62, #107). Both checks above ask what
              // the new body KEPT; this one asks whether the writer ever looked
              // at what it was replacing. 420002 s7 swapped a fee schedule out
              // of an unread node at 1496 → 1456 chars — a content swap no size
              // heuristic can see. Session state, not content: it fires ALONGSIDE
              // replaced_body/dropped_body (a blind rewrite that is also lossy
              // is two separate things gone wrong), and neither suppresses the
              // other. Advisory only, like every sibling — the write landed.
              //
              // `updateNode` has exactly one write shape, a full-body replace,
              // so there is no append for the API to exempt. An append is
              // recognized by EVIDENCE instead: a new body that still opens or
              // closes with the prior one, verbatim, demonstrably dropped
              // nothing and cannot have been written from recollection. Anchored
              // at a boundary rather than by bare `includes` (codex review): a
              // two-word prior body would otherwise be "kept" by any replacement
              // that happens to contain those words. A body-identical write
              // moved nothing at all and is silent for the same reason. The
              // enclosing guard keeps a stub fill silent too — an empty prior
              // body has no facts to lose, and placeholder-then-fill is a
              // pattern to encourage, not to nag.
              //
              // The RAW argument counts as evidence beside the normalized one
              // (F63, #108): a legacy node stored with literal `\n` escapes,
              // handed back exactly as it reads on disk, is a writer holding the
              // body — the unescaping happens after that, and must not turn the
              // proof into a flag.
              const priorText = prior.body.trim()
              const carriesPrior = (text) => text.trim().startsWith(priorText) || text.trim().endsWith(priorText)
              if (!seenBodies.has(id) && body.trim() !== priorText && !carriesPrior(body) && !carriesPrior(args.body)) {
                blindRewrite = prior.body.length
              }
              // The provenance sibling (F55, #91). Every check above measures the
              // body in aggregate — chars, vocabulary, whether it was read — and
              // all three are blind to the loss that costs the most per
              // character: a rewrite that keeps the prose and drops the ids. They
              // are the first thing a from-the-gist rewrite discards (an opaque
              // string has no gist), and the last thing that can be recovered,
              // since only the source conversation ever held them. 420002 s7's
              // fee-schedule swap and replay v3's zero-of-six worker ids are the
              // same shape.
              //
              // Fires only when the revision drops ALL of them — the same
              // keep-nothing posture as F47, and the shape the evidence actually
              // shows (a rewrite either carries the id block forward or forgets
              // it wholesale). A partial drop is an accepted miss: the writer
              // that kept one id was looking at the ids, and a nag there would
              // land on every legitimate split of one node into two.
              //
              // Orthogonal to its siblings, like `blind_rewrite`: a rewrite that
              // is lossy AND loses its ids is two things gone wrong, and the char
              // count never says which strings went. Advisory only — the write
              // landed, and this is the one moment the ids are still in context.
              // Retention is TOKEN membership, never `body.includes` (codex
              // review of #118): an id that survives only as a substring of a
              // longer run is not that id. `300417582904613376` reappearing as
              // `3004175829046133769` is the corrupted-artifact-id failure the
              // dossier evidence names — a key that no longer resolves — and a
              // substring test would call it kept and stay silent on exactly the
              // case worth flagging. Tokenizing both sides applies the same
              // boundaries to both.
              //
              // Both sides are prepared identically before tokenizing:
              // `normalizeBody` because a pre-F63 node stored with literal `\n`
              // escapes glues an id to the escape (`\n300442018876145664`) and
              // would drop it from the prior set — the same raw-vs-repaired
              // asymmetry `blind_rewrite` handles above — and
              // `withoutBookkeeping` because a supersede banner's ULID is the
              // framework's own, never the writer's provenance.
              // `body` arrived through normalizeBody already and must not make a
              // second pass — unescaping is not idempotent — so only the raw
              // prior body is repaired here.
              const provenance = (text) => idTokens(withoutBookkeeping(text))
              const priorIds = provenance(normalizeBody(prior.body))
              if (priorIds.length > 0) {
                const kept = new Set(provenance(body))
                const gone = priorIds.filter((token) => !kept.has(token))
                if (gone.length === priorIds.length) droppedIds = gone.slice(0, DROPPED_IDS_CAP)
              }
            }
            // Stale-description detection (F52, #88): a body revision that
            // leaves `description` untouched keeps the retrieval surface
            // asserting whatever it said before. "Untouched" includes a
            // verbatim echo of the existing description (codex review of
            // #100): passing the old line back changes nothing on the surface
            // this nudge guards, and an echo must not silence it. Two
            // triggers, both requiring the body to have actually changed:
            //   - a placeholder-marked description ("检索中"/"待确认"-class,
            //     see PLACEHOLDER_MARKERS) over any substantive body write.
            //     Deliberately repeats on EVERY such update until the
            //     description is refreshed — persistent pressure is the point
            //     (the eval's 待确认 marker survived 13 steps because nothing
            //     kept asking), the echo rule above is what keeps a lazy echo
            //     from silencing it, and the render phrases it as a
            //     conditional so it stays truthful when the update did NOT
            //     resolve the pending item;
            //   - a substantial change: the length moved past
            //     STALE_DESCRIPTION_DELTA, or the replaced/dropped advisories
            //     above already established the content moved out from under
            //     the description. Accepted miss: a big same-length rewrite
            //     that keeps enough vocabulary to dodge all three — silence is
            //     the cheaper failure for a nudge that would otherwise fire on
            //     every session's write-back.
            const descriptionUntouched = args.description === undefined || args.description.trim() === prior?.description.trim()
            if (prior !== undefined && descriptionUntouched && body.trim() !== prior.body.trim()) {
              const pendingDescription = hasPlaceholder(prior.description) && body.trim().length > 0
              const substantial = replacedBody !== undefined || droppedBody !== undefined
                || Math.abs(body.length - prior.body.length) >= STALE_DESCRIPTION_DELTA
              if (pendingDescription || substantial) staleDescription = prior.description
            }
          }
          // The evidence gates (F71, #157; F72, #152) on the update path: only
          // what the prior node did not already carry is new this write. The
          // prior side is unescaped like F55's, so a legacy body's glued lines
          // still vouch for the assertions they carry; `body` already made its
          // one normalizeBody pass above. The DESCRIPTION is scanned with the
          // body against the prior description (codex pre-merge review of
          // #162) — it is the graph's primary retrieval surface, and a
          // description-only update was otherwise a clean bypass here exactly as
          // it was on the create path.
          // `attach` joins the trigger as well as the text (F71.1, #167): an
          // attach-only update carries a whole new payload and used to scan
          // nothing at all. Attachment content is new to this call by
          // construction, so it rides the new side only — `priorScanned` stays
          // the node's own prior description and body.
          // An `append` rides the new side too (F89, #219): the appended line is
          // the whole of what this call adds, and an uncited assistant-behaviour
          // claim appended is the same claim F71 exists to catch.
          if (body !== undefined || args.description !== undefined || args.attach !== undefined || appendText !== undefined) {
            const scanned = [args.description, body, appendText, args.attach?.content].filter((part) => part !== undefined).join('\n')
            const priorScanned = [prior?.description ?? '', prior === undefined ? '' : normalizeBody(prior.body)].join('\n')
            // The turn rides the update path too (F71.2, #167) — round 13's
            // quote-satisfied repair WAS an update, written one call after the
            // advisory it answered.
            unsourcedAssertions = unsourcedAssertionLines(scanned, priorScanned, promptingTurn(exec) ?? '')
            mintedPrecision = mintedPrecisionLines(scanned, priorScanned)
          }
          // The labeled-figure contradiction REJECT (F76, #173) — see
          // contradictedFigures above for the full rationale. Update path only
          // (a create has no prior to contradict), prior side prepared exactly
          // as F55's (normalizeBody so a legacy body's glued figures still
          // count, withoutBookkeeping so a supersede banner is never a
          // baseline), claim side the issue's evidence: the new body and the
          // attachment payload. The description deliberately does not join the
          // claim side — it summarizes the body being checked here, and
          // widening waits for evidence, the way the unit set does. The throw
          // happens BEFORE the node lock, so nothing was written — unlike every
          // advisory sibling, which reports on a write that already landed.
          // A writer that never read the node gets the F68 read-gate's message
          // from inside the lock, not this one (opus pre-merge review of #173):
          // this error names the stored figure, and naming it to a caller the
          // read gate is about to turn away would leak the very content that
          // gate withholds — so `priorHash` gates the check. A read that went
          // stale while this call waited is accepted the other way around: the
          // contradiction fires first against current disk content, and the
          // stale-write gate still owns the retry.
          // An `append` is a claim like any other (F89, #219) — but it stays
          // behind `priorHash` with its siblings: on an exempt type the gate
          // never turns an unread appender away, so the leak argument does not
          // hold there, and widening waits for the replay to show a contradicting
          // append (ADR-0014 names that risk as unbounded).
          if (priorHash !== undefined && prior !== undefined && prior.body.trim().length > 0 && (body !== undefined || appendText !== undefined || args.attach !== undefined)) {
            const claims = [body, appendText, args.attach?.content].filter((part) => part !== undefined).join('\n')
            const contradicted = contradictedFigures(withoutBookkeeping(normalizeBody(prior.body)), claims)
            if (contradicted.length > 0) {
              const named = contradicted.map(({ label, prior: held, next }) => `${label}: the node holds ${held}, this write says ${next}`).join('; ')
              // Audited (#245): reachable only with a current read expectation,
              // before the node lock and before any write — the same prefix the
              // ordinary update path takes. No graph content has been modified
              // (the existing `.locks/` coordination of a sibling path is the
              // documented exclusion; a lock-release failure is still unknown).
              throw auditedRefusal('update_contradicted_figure', `memory_write: contradicted figure — ${named} — and the write never names the stored value. Nothing was written. If the figure genuinely changed, restate the correction explicitly in the body (「${contradicted[0].prior} → ${contradicted[0].next}」) so the superseded value stays on record; if it did not, keep the stored figure — a generated report's number never outranks what the node already carries.`)
            }
          }
          // The disk read, comparison and update belong inside the SAME per-Node
          // lock: only that makes compare-then-rename race-free under ADR-0013.
          // `priorHash` deliberately does not: it is this call's pre-wait
          // expectation, captured above. There is no force path; other
          // filesystem errors propagate unchanged and stay unknown.
          description = (await withNodeLocks(root, [id], async () => {
            // A vanished target is the fourth audited refusal (#245): the ONLY
            // I/O error this branch certifies is the ENOENT of this exact update
            // read, so the original Error object (message, class, code) is
            // rethrown untouched and merely branded. Any other read error
            // (EACCES, EIO, …) propagates with no proof at all.
            let currentRaw
            try {
              currentRaw = await fsp.readFile(path.join(root, id, 'node.md'))
            } catch (error) {
              if (error?.code === 'ENOENT') throw brandRefusal('update_target_missing', error)
              throw error
            }
            const currentHash = hashBytes(currentRaw)
            // An `append` on an APPEND_EXEMPT_TYPES node skips BOTH gates (F89,
            // #219; ADR-0014) — see that constant for why each protects a
            // replace and neither protects an append. The type is read off the
            // bytes just hashed, under this lock, so a retype racing this call
            // cannot widen the exemption; every other write shape, and an
            // append on any other type, meets the gates unchanged.
            const current = appendText === undefined ? undefined : parseNode(currentRaw.toString('utf8'))
            const appendExempt = current !== undefined && APPEND_EXEMPT_TYPES.includes(current.type)
            if (!appendExempt && priorHash === undefined) {
              // Audited (#245): inside the same node lock the write takes, after
              // exactly one readFile and before any content is modified.
              throw auditedRefusal('update_unread', `memory_write: ${id} has not been read this session — memory_read it before updating`)
            }
            if (!appendExempt && priorHash !== currentHash) {
              // The hub hint (#145) rides only THIS reject: an id-update is the
              // one write shape whose retry a create-with-link can replace. A
              // stale supersede has no such out — its whole point is the old
              // node — so those two sites keep the plain message.
              // Audited (#245): same lock, same single read, still before any
              // modification. The hint is advisory text, not a second gate — but
              // a FAILED hint lookup means this audited prefix did not complete,
              // and the approved design explicitly does not certify that. Same
              // message either way; only the branding is withheld.
              const hint = await hubContentionHint(id)
              const message = `memory_write: ${id} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying${hint.text}`
              if (!hint.read) throw new Error(message)
              throw auditedRefusal('update_stale', message)
            }
            let nextBody = args.body
            if (current !== undefined) {
              // The plugin joins (ADR-0014): the stored body verbatim, one blank
              // line, the appended text — both sides trimmed, and an empty body
              // means the append IS the body. The writer cannot be asked for the
              // separator, since the point of the route is that it is not
              // looking at the body. The stored side is NOT normalizeBody'd: an
              // append changes no stored character, a legacy escaped body
              // included. Decoded exactly once, like `body`, by two routes
              // (terra review of 73b020c): the join carries the once-normalized
              // text, and updateNode's own pass over it is a no-op because the
              // separator is a real newline — that function's exit condition.
              // An EMPTY body has no separator to exit on, so there the RAW
              // argument goes to updateNode and it performs the one decode
              // itself; handing it the normalized text let a doubly-escaped
              // `\\n` lose its second layer to the second pass.
              const stored = current.body.trim()
              const added = appendText.trim()
              nextBody = stored.length === 0 ? args.append.trim() : `${stored}\n\n${added}`
              // The restatement check (F89, #219), scored where the body is.
              // Skipped for a text too short to judge — turnCoverage vouches
              // 1.0 under ATTACH_TRACE_MIN_TOKENS, which here would read as a
              // total restatement — and for the sanctioned no-change line,
              // whose second instance restates the first by mandate.
              if (stored.length > 0 && !NO_CHANGE_LINE_RE.test(added) && traceTokens(added).size >= ATTACH_TRACE_MIN_TOKENS) {
                const coverage = turnCoverage(added, stored)
                if (coverage > APPEND_RESTATED_COVERAGE) restatedAppend = Math.round(coverage * 100)
              }
            }
            // A frozen full-body retry that passed F88.4 gets the framework's
            // own lines put back (F88.5, #219; terra review of 426933d, twice
            // independently). The comparison strips bookkeeping from BOTH sides
            // because the writer read the node BEFORE F88.3's correction landed
            // on it and cannot be asked to reproduce a line it never saw — and
            // for the same reason the line must be restored here rather than
            // demanded there: before F88.4 a >200-char body on a frozen node
            // was refused outright, so a retry could delete nothing; after it,
            // a body that keeps the prose and omits the correction is accepted,
            // and `body` replaces — the freeze fix would undo its sibling guard
            // in the same turn, leaving the node promising a file that was
            // never stored. Scoped to this path on purpose: on an ordinary
            // write the writer READ the banner it omits (F55 relies on a
            // faithful revision keeping it), and splicing lines into every
            // write would change updateNode's one-shape contract. Only what can
            // be restored safely: top banners (`Superseded by`, `Merged into`)
            // go back on top in their stored order, where supersededBy's
            // BANNER_SCAN_LINES window reads them; the F88.3 correction goes
            // back at the bottom, where F88.3 put it. A `Merged from … :`
            // divider is NOT restored — it heads an absorbed block mid-body,
            // its position is gone with the rewrite, and a header appended over
            // nothing would misdescribe the node; the divider is left to the
            // general case this change does not own. Built from the normalized
            // `body`, and updateNode's pass over it is a no-op — the restored
            // separators are real newlines — so the writer's text is decoded
            // exactly once either way; an untouched body still goes raw.
            if (frozenRetry === true && body !== undefined) {
              const kept = new Set(body.split('\n').map((line) => line.trim()))
              const stored = parseNode(currentRaw.toString('utf8')).body.split('\n').map((line) => line.trim())
              const tops = stored.filter((line) => /^(?:Superseded by|Merged into) /.test(line) && BOOKKEEPING_LINE_RE.test(line) && !kept.has(line))
              const corrections = stored.filter((line) => UNWRITTEN_ATTACHMENT_LINE_RE.test(line) && !kept.has(line))
              if (tops.length > 0 || corrections.length > 0) {
                nextBody = [...(tops.length > 0 ? [tops.join('\n')] : []), body.trim(), ...corrections].join('\n\n')
              }
            }
            // #247, authoritative: an unseen overwrite must leave this node
            // exactly as it was — no body landed, no `.node.md.prev` burned, no
            // attachment replaced, no observation written. It runs under the lock
            // that publishes the body and the file together, so a peer cannot
            // slot a different file between this check and the attach below.
            // Audited (`attach_overwrite_unseen`): the lock body has read the
            // node and this file and written nothing yet — `updateNode` is the
            // first mutation, below.
            if (args.attach !== undefined) {
              attachVerdict = await refuseUnseenAttachmentOverwrite('memory_write', id, args.attach.filename, Buffer.from(args.attach.content, 'utf8'), exec, refuseUnseenOverwrite)
              attachSnapshot = !attachVerdict.preserved
            }
            const next = await updateNode(root, id, { description: args.description, body: nextBody, type: args.type })
            // #317: an update logs only when the BODY or the DESCRIPTION moved —
            // the same comparison updateNode just made, against the node as it
            // stood under this lock. An unchanged echo, a links-only call and a
            // type-only call change nothing a reader would call content, and a
            // no-op never gets a line. The bytes are already in memory, so this
            // parse costs nothing beyond what updateNode itself did.
            const beforeNow = parseNode(currentRaw.toString('utf8'))
            if (next.description !== beforeNow.description || next.body !== beforeNow.body) {
              provenanceLines.push({ id, op: 'update' })
            }
            if (current !== undefined) {
              // From here `body` is the joined text AS PERSISTED — read back off
              // updateNode's return, so body_chars can never disagree with disk
              // (terra review of 73b020c). long_body, node_size, the F73 shape
              // check, the F61 sweep and the F79 observation ratio all measure
              // what the full write this append replaces would have, so
              // downstream an append is indistinguishable from it (ADR-0014: no
              // new size mechanism).
              body = next.body
              bodyChars = next.body.length
            }
            // Refresh this Session's expectation only when it was current a
            // moment ago. Every gated write is, so this changes nothing for
            // them; an exempt append (F89) that arrived unread or stale is not,
            // and seeding it here would let the appender's NEXT call — a full
            // `body` replace of text it has still never seen — through both
            // gates. Found by the F89 gate test: the exemption is append-only,
            // and it must not leak into the write shape the gates exist for.
            if (priorHash === currentHash) versionSeen.set(id, hashBytes(await fsp.readFile(path.join(root, id, 'node.md'))))
            // The inline attachment (F74, #163) publishes inside THIS critical
            // section, after the body and before the lock is released, so a
            // peer's write can never land between the two halves of one call.
            // Body first, file second, on purpose: a failed attach leaves a body
            // naming a file that a retry can still store, while attaching first
            // would let a failed body write leave a REPLACED attachment whose
            // prior content is gone for good.
            await inlineAttach()
            // The auto-observation (F79, #180) publishes in the SAME section as
            // the body it is the raw material for, so a peer can never pair its
            // gist with this turn's observation. Only when this call stored new
            // gist text (body or description) — a links-/type-only update
            // distilled nothing this turn. Dedup on the stable name: an identical
            // re-observed page is left as-is rather than rewritten. Best-effort
            // like inlineAttach — a failed capture leaves the body standing.
            const observationUpdate = observationPayload(Math.max(body !== undefined ? body.length : 0, args.description !== undefined ? args.description.length : 0))
            if (observationUpdate !== undefined) {
              try {
                let prior
                try { prior = await fsp.readFile(path.join(root, id, OBSERVATION_FILE), 'utf8') } catch { /* none yet */ }
                if (prior === observationUpdate.content) {
                  observation = { file: OBSERVATION_FILE, bytes: Buffer.byteLength(observationUpdate.content, 'utf8'), status: 'unchanged' }
                } else {
                  // #247 (review finding 1): the autosave stays UNGATED — F79/#180
                  // makes this file the framework's own wholesale capture, and
                  // gating it would drop raw material the gist was distilled from
                  // — but it inherits the same per-Session snapshot anchor. Without
                  // it, a later Session's first changed capture overwrote
                  // `.observation.txt.prev` with the page from before that Session
                  // (correct) and its SECOND changed capture overwrote that copy
                  // with its own first page, losing the observation the copy
                  // exists to keep.
                  const bytes = Buffer.from(observationUpdate.content, 'utf8')
                  const evidence = await inspectFileBytes(path.join(root, id, OBSERVATION_FILE))
                  const entry = evidence.state === 'ok'
                    ? sessionState(sessionKeyOf(exec)).filesSeen.get(fileIdentityKey(id, evidence.dev, evidence.ino))
                    : undefined
                  const existed = evidence.state !== 'missing'
                  // Already preserved only when this Session wrote the bytes now on
                  // disk and owes no copy — it holds the copy from before its own
                  // first overwrite, or it created the file — the same rule, and
                  // the same identity, as every other route.
                  const preservedBefore = evidence.state === 'ok' && entry !== undefined && entry.preserved === true && entry.sha === hashBytes(evidence.bytes)
                  const identical = evidence.state === 'ok' && evidence.bytes.equals(bytes)
                  observation = await attach(root, id, OBSERVATION_FILE, observationUpdate.content, { snapshot: !preservedBefore })
                  // #317: a CHANGED capture is a real file mutation even when the
                  // body it was distilled from did not change, so it gets its own
                  // attach line. The `unchanged` branch above skips it on purpose;
                  // a failed capture lands in the catch below and adds none.
                  provenanceLines.push({ id, op: 'attach', file: OBSERVATION_FILE })
                  await recordFileWritten(exec, id, OBSERVATION_FILE, bytes, preservedAfterWrite({ existed, preservedBefore, identical }))
                }
              } catch (error) {
                // Degrade: the body update stands and the observation is
                // best-effort. But not SILENTLY (#255): this catch used to hide
                // every failure — an ENAMETOOLONG or ENOSPC capture vanished with
                // no trace — so log it the way the advisory journal reports its
                // own append failure, and let the write return normally.
                //
                // The log itself is best-effort (#255 review 1): `updateNode` has
                // ALREADY committed by the time we get here, so a harness whose
                // stderr sink throws must not turn a landed write into a thrown
                // error — the wrapper would latch its write fence on an unaudited
                // failure. Same posture, same nesting as `journalAdvisories`.
                try {
                  process.stderr.write(`memory-graph: could not auto-capture ${OBSERVATION_FILE} on ${id} — ${error.message} (#255). The write itself landed.\n`)
                } catch { /* no channel left to report on, and the write is safe either way */ }
              }
            }
            return next
          })).description
        }
        const links = []
        // The peers whose OWN degree a link in this call grew (F70, codex round
        // 3): plain links and `relates-to` land a symlink in the peer's
        // __edges__/; a directed typed link lives only on this node, so counting
        // its target would render "this link pushed <peer>" about a peer nothing
        // pushed. Only `created` grows anything — `exists` changed no edge (its
        // hub was flagged when the edge was born; the one miss is a legacy
        // half-edge completion, caught at the hub's next write like the
        // traversal-wired edges memory_read creates).
        const grewPeer = new Set()
        for (const to of args.links ?? []) {
          // #317: the receipt is what THIS call actually created, so a half-edge
          // repair (`addEdge` reports 'exists') is logged and another writer's
          // edge is not. #321: declared before the try and drained in that
          // iteration's `finally`, so a link that throws AFTER landing a half
          // still logs what is on disk (the failure rule), while a link that
          // returned keeps the unchanged success fan-out. `status`/`grewPeer`/
          // `ownEdgeTargets` stay success-path only — a failed link is not a
          // link the call created.
          const minted = []
          let landed = false
          try {
            const status = await addEdge(root, id, to, { minted })
            landed = true
            if (status === 'created') grewPeer.add(to)
            // Own only what this call CREATED (codex review of #147): an edge
            // that already existed on a just-published successor is another
            // Session's reference to it, and the rollback must spare it.
            if (status === 'created') ownEdgeTargets.add(to)
            links.push({ to, status })
          } catch {
            links.push({ to, status: 'failed' })
          } finally {
            provenanceLines.push(...(landed ? edgeReceiptLines(minted) : edgeFailureLines(minted)))
          }
        }
        // Typed edges (F3, #12) are processed exactly like plain links but carry a
        // relationship type into addEdge; each result is reported in the same
        // `links` list so the render and output shape stay uniform.
        const typedSupersedeLanded = new Set()
        for (const { id: to, type } of args.typed_links ?? []) {
          // An incoming `supersedes` edge and the "Superseded by …" banner are
          // ONE invariant, whichever verb spells it (#147): landing the edge
          // without the banner leaves a zombie node asserting a stale decision
          // as current on every discovery surface (the MAP marker and the rank
          // penalty both read the banner, not the edge). So this path banners
          // the target exactly like `supersedes:` above — same two-Node lock,
          // same authoritative version-gate re-check (#143), same conditional
          // successor rollback (#144). A self-addressed or malformed target
          // skips to the plain path below, where addEdge's own guards report it
          // as a failed link, as they always have.
          if (type === 'supersedes' && to !== id && ULID_RE.test(to)) {
            if (typedSupersedeLanded.has(to)) {
              // A duplicate entry for a target this call already bannered: the
              // edge is in place, and the gate must not stale-reject the call's
              // own banner against the expectation captured before it landed.
              links.push({ to, status: 'exists' })
              continue
            }
            // Set just before a version-gate throw, so the catch below can tell
            // the hard reject from an ordinary per-link failure.
            let gateRejected = false
            // #321: the receipts of this pair's `addEdge`/`supersede`,
            // translated in an inner `finally` INSIDE this try so the catch's
            // `dropRevertedProvenance` sees the lines a rollback must filter.
            const minted = []
            const receipts = []
            try {
              const status = await withNodeLocks(root, [id, to], async () => {
                try {
                  // Authoritative gate re-check under the two-Node lock (#143):
                  // against the expectation captured before this call created or
                  // updated anything and joined the lock queue — never a re-read
                  // of the shared map.
                  let oldRaw
                  try {
                    oldRaw = await fsp.readFile(path.join(root, to, 'node.md'))
                  } catch (error) {
                    if (error.code !== 'ENOENT') throw error
                    // Nonexistent target: fall through to addEdge, which names
                    // the failure the way every other bad link id is named.
                  }
                  if (oldRaw !== undefined) {
                    const prior = typedSupersedePrior.get(to)
                    if (prior === undefined) {
                      gateRejected = true
                      throw new Error(`memory_write: ${to} has not been read this session — memory_read it before superseding it`)
                    }
                    if (prior !== hashBytes(oldRaw)) {
                      gateRejected = true
                      throw new Error(`memory_write: ${to} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`)
                    }
                  }
                  try {
                    const landed = await addEdge(root, id, to, { type, minted })
                    const { oldNode } = await supersede(root, to, id, undefined, receipts)
                    // Hash the exact Node this call wrote (F68, #129), so the
                    // banner does not stale-reject this Session's next write.
                    if (oldNode !== undefined) {
                      versionSeen.set(to, hashBytes(Buffer.from(renderNode(oldNode), 'utf8')))
                    }
                    return landed
                  } finally {
                    // #321: one representation per mutation (review of
                    // #319, item 4) — the pair, never an edge line for it. The
                    // three-way rule is `supersedeOutcome`'s (design.md row 61).
                    // A landed banner ALSO makes the successor load-bearing
                    // from this instant, so a later gate reject cannot unpublish
                    // it; that flag stays local to this path.
                    const outcome = supersedeOutcome({ receipts, minted, newId: id, oldId: to, type })
                    if (outcome.banner) bannerLanded = true
                    provenanceLines.push(...outcome.lines)
                  }
                } catch (error) {
                  // Roll back while still HOLDING the successor's lock (#144).
                  // Only a GATE reject unpublishes the create: an ordinary
                  // failed typed link never has (the write stands and the link
                  // reports 'failed'), and once any banner names this successor
                  // it is load-bearing — removing it would orphan the banner.
                  if (gateRejected && created && !bannerLanded && rollbackSuccessor !== undefined) {
                    dropRevertedProvenance(await rollbackSuccessor(), id, provenanceLines)
                  }
                  throw error
                }
              })
              // Own only a CREATED edge (codex review of #147) — an 'exists'
              // here is either this call's own earlier plain link (already
              // owned) or another Session's reference, which the rollback must
              // spare. Moot once bannerLanded below blocks rollback anyway,
              // but the allowlist stays honest.
              if (status === 'created') ownEdgeTargets.add(to)
              typedSupersedeLanded.add(to)
              // A RETURNED supersede (including 'already') leaves a banner on
              // disk, so the successor is load-bearing. The banner receipt
              // already set this inside the locked section (#321); repeating it
              // here keeps the returned path exactly as it behaved before.
              bannerLanded = true
              links.push({ to, status })
            } catch (error) {
              // A version-gate reject is the whole call's typed rejection — the
              // same hard stop the `supersedes:` path throws (#143), never a
              // silent 'failed' row the writer reads past. On the update path
              // the `id` update above already landed under its own gate; that
              // partial is reachable only through the last-millisecond race the
              // unlocked pre-check cannot close — the same accepted ceiling as
              // #144's, and the landed half was itself a gated, informed write.
              if (gateRejected) throw error
              links.push({ to, status: 'failed' })
            }
            continue
          }
          const minted = []
          let status
          let landed = false
          try {
            const owners = edgeSidecarOwners(id, to, type)
            // `landed` flips the moment `addEdge` returns — inside the lock — so a
            // lock-release throw after a complete edge keeps the success fan-out.
            const link = async () => {
              const result = await addEdge(root, id, to, { type, minted })
              landed = true
              return result
            }
            status = owners.length === 0 ? await link() : await withNodeLocks(root, owners, link)
            // Only the symmetric type grows the peer (see grewPeer above).
            if (status === 'created' && type === 'relates-to') grewPeer.add(to)
            // Own only what this call CREATED (codex review of #147), so the
            // rollback allowlist never claims another Session's reference.
            if (status === 'created') ownEdgeTargets.add(to)
            links.push({ to, status })
          } catch {
            links.push({ to, status: 'failed' })
          } finally {
            // #317: the receipt names what this call actually changed — a
            // half-edge repair reports 'exists' but is still a real transition,
            // a retype changes only the owner's `.edge-types` slot, and the
            // line carries the type so a reader can tell a plain link from a
            // typed one. An identical repeated typed link mints nothing.
            // #321: a link that THREW after landing a half or a slot logs the
            // failure rule instead (halves untyped, slots as they landed),
            // because the type may never have reached disk; the success
            // fan-out is untouched.
            provenanceLines.push(...(landed ? edgeReceiptLines(minted, type) : edgeFailureLines(minted)))
          }
        }
        // The write landed — count it for the zero-write exit check (F46, #75).
        // Only reached past every throw above, so a rejected call never counts.
        writes += 1
        // The model authored this body, so it has seen it as surely as a read
        // would have shown it (F62, #107). Only a call that SUPPLIED a body
        // counts — a links-only or description-only write leaves the body as
        // unseen as it found it.
        if (body !== undefined) seenBodies.add(id)
        // The tier-1 granularity check (F70, #149), on the node as this write
        // left it: the body just supplied, and one readdir of __edges__ now that
        // every link above has landed. Size fires only when THIS call supplied a
        // body — a links-only update moved nothing into it — but degree is
        // checked on every write shape, because links are exactly how a hub
        // accretes. Advisory only, like every sibling: a legitimate big node
        // exists, and only the writer can tell it from a junk drawer.
        const nodeSize = body !== undefined && body.length > NODE_SIZE_CAP ? body.length : undefined
        let nodeDegree
        try {
          const degree = (await outEdges(root, id)).length
          if (degree > NODE_DEGREE_CAP) nodeDegree = degree
        } catch { /* one stat, best-effort — the write landed */ }
        // The peer's half of the degree check (codex round 2 on #149): a plain
        // edge is symmetric, so linking TO a node grows its degree without it
        // ever being the written node — which is exactly how the audit's hub
        // accreted. Only the peers this call actually grew are statted
        // (`grewPeer` above), so the cost stays one readdir per new symmetric
        // edge and the advisory never claims a push that did not happen.
        const hubLinks = []
        grewPeer.delete(id)
        for (const to of grewPeer) {
          try {
            const degree = (await outEdges(root, to)).length
            if (degree > NODE_DEGREE_CAP) hubLinks.push({ id: to, degree })
          } catch { /* best-effort, like the stat above */ }
        }
        // The close-out sweep (F61, #106), run against the work-state scan as it
        // stood BEFORE this write — the banner's own cached one, so the sweep
        // costs nothing extra in the ordinary flow. What the write just changed
        // is accounted for by hand instead: the node itself and anything it
        // superseded are no longer open, and a work-state node this call created
        // is not in the pre-write list at all.
        //
        // Only a write that put CONTENT in the graph can have resolved anything.
        // A links-only or type-only update delivers no result; neither does
        // BLANKING a body (`body: ''` on an existing node), which is why an
        // update has to carry text — its unchanged description would otherwise
        // be scored as though it had just been delivered. A create is content
        // either way: its description alone can be the whole answer.
        const delivered = created || (body !== undefined && body.trim().length > 0)
        const stalePending = delivered ? stalePendingMatches([id, args.supersedes, ...typedSupersedeLanded], `${description}\n${body ?? ''}`) : []
        // The graph changed, so the cached index is stale regardless of its age.
        cached = { at: 0, text: '' }
        cachedHandoffs = { at: 0, text: '' }
        cachedWorkState = { at: 0, nodes: [] }
        // #263: a successful content mutation also drops the run's frozen prompt
        // render, so the next assembly shows the new graph. This is the ONLY
        // drop path on purpose: access bookkeeping (`memory_read`'s touchRead) and
        // a traversal read's edge wiring are discovery effects, not content
        // changes, and must not re-render the prompt mid-run. A read-authority
        // wrapper registers no handler here at all, so this is the defensive half
        // for a deployment that enables the snapshot where writes can happen.
        dropSnapshot()
        await refreshIndex()
        // `superseded` is present only when this write replaced an earlier node.
        // `long_body` only when THIS call passed an oversized body — an update
        // that leaves the body alone is not the moment to nag about it.
        const longBody = (body ?? '').length > LONG_BODY_CHARS ? body.length : undefined
        // The shape trigger (F73, #159), beside the size trigger it backstops.
        // Same gate as long_body: only when THIS call supplied the body — an
        // update that left the body alone recited nothing.
        const deliverable = body === undefined ? undefined : deliverableShape(body)
        // The detail tier's name (F82, #191), read off the attachment that
        // actually LANDED — the create path's own `{file, bytes, status}` and the
        // update path's `attach()` return carry the same field, so both routes
        // and memory_attach judge the identical string. A failed attach stored no
        // file and gets no naming advice; the F79 auto-capture is exempt by name.
        const genericFilename = attached === undefined ? undefined : genericAttachmentName(attached.file)
        // The auto-observation (F79, #180) was already captured inside the
        // create/update critical section above — one published state, node and
        // raw observation together. ponytail: the fixed filename dedups a
        // re-observed page by overwrite; the only file it could not tell from its
        // own used to be an agent-authored attachment under that same name, which
        // is now refused by the tools' `semantic` hook (#255), so the collision is
        // legacy-only: a pre-#255 file of that name is overwritten as the
        // framework's own, with `.observation.txt.prev` the copy that outlives it.
        const result = { id, created, description, links, similar, link_candidates: linkCandidates, ...(superseded ? { superseded } : {}), ...(attached === undefined ? {} : { attached }), ...(attachFailed === undefined ? {} : { attach_failed: attachFailed }), ...(genericFilename === undefined ? {} : { generic_filename: genericFilename }), ...(observation === undefined ? {} : { observation }), ...(longBody === undefined ? {} : { long_body: longBody }), ...(deliverable === undefined ? {} : { verbatim_deliverable: deliverable }), ...(nodeSize === undefined ? {} : { node_size: nodeSize }), ...(nodeDegree === undefined ? {} : { node_degree: nodeDegree }), ...(hubLinks.length === 0 ? {} : { hub_links: hubLinks }), ...(blindRewrite === undefined ? {} : { blind_rewrite: blindRewrite }), ...(bodyChars === undefined ? {} : { body_chars: bodyChars }), ...(restatedAppend === undefined ? {} : { restated_append: restatedAppend }), ...(replacedBody === undefined ? {} : { replaced_body: replacedBody }), ...(droppedBody === undefined ? {} : { dropped_body: droppedBody }), ...(droppedIds === undefined ? {} : { dropped_ids: droppedIds }), ...(staleDescription === undefined ? {} : { stale_description: staleDescription }), ...(unsourcedAssertions.length === 0 ? {} : { unsourced_assertions: unsourcedAssertions }), ...(mintedPrecision.length === 0 ? {} : { minted_precision: mintedPrecision }), ...(stalePending.length === 0 ? {} : { stale_pending: stalePending }) }
        // The journal reads the result itself (F64, #109) — what the model is
        // shown is what gets logged, with no second computation to drift. It is
        // awaited: the line has to be on disk before the model can act on the
        // advisory, or a turn that dies mid-step loses exactly the evidence the
        // journal exists to keep.
        await journalAdvisories(result)
        // The tier-2 trigger (F70, #149), read AFTER the journal append so the
        // write that crosses the threshold is the write that says so. Depth, not
        // cron: an idle graph stays silent, and a burst surfaces on its very
        // next write. 0 disables it.
        if (maintenanceBacklog > 0) {
          const backlog = advisoryBacklog()
          if (backlog >= maintenanceBacklog) result.maintenance_due = backlog
        }
        return result
      } finally {
        // #317: the ONE flush. It runs on every exit — a normal return and a
        // throw alike — because a transition that committed can be followed by
        // a later rejection that leaves it in the graph (a late typed-supersede
        // gate reject after the id update landed). It sits here, outside every
        // lock scope, so no node lock is held while bookkeeping is written, and
        // `recordProvenance` is fail-open: it cannot throw, so the original
        // result and error (including a branded refusal) pass through untouched.
        await recordProvenance(provenanceLines, exec, provenanceTs(provenanceAt))
      }
    },
    presentCall: (args) => ({ card: 'generic', title: args.id === undefined ? 'Store a memory' : `Update memory ${args.id}`, kind: 'edit', rawInput: args }),
  }))

  // The from_path confinement, stated where the model chooses the path
  // (security review, 2026-10-19) — the refusal names the same rule.
  const fromPathRule = fromPathEnabled
    ? 'Only a regular file under this deployment\'s allowed source directories is accepted (by default the working directory and the home directory); hidden files and dot-directories (.ssh, .env, .git, …) and system paths (/etc, /proc, /dev, …) are refused.'
    : '`from_path` is disabled in this deployment — every call with it is refused; pass the text as `content`.'

  ctx.tools.register(defineTool({
    name: 'memory_attach',
    description: 'Attach a file to a memory node — the node\'s detail tier: the complete list, table, step sequence, transcript or long summary the body is only a gist over, in full. The split is by kind, not by degree: the body keeps the retrieval keys — identifiers, dates, names, this file\'s name, the conclusions — and the file keeps the bulk (rows, steps, option lists, enumerations, verbatim passages); a fact that is BOTH (a table of dates, a list of ids) stays complete in the file while the body keeps its range, its count and the load-bearing member. Restating the file\'s rows in the body buys nothing: a search row quotes the matching row back out of the file itself. Never trim the detail file down to what the body left out. The content is written into the node\'s own directory, so it travels with the node and is never orphaned. Pass either `content` (the full text, retyped) or `from_path` (an existing file on disk, COPIED into the node — use this when the bulk already exists as a file: no retyping, no paraphrase loss; the source file is only read and left exactly where and as it is, never moved, deleted or modified). ' + fromPathRule + ' `filename` must be a plain name (no path separators, no leading dot, not a reserved name); with `from_path` it defaults to the source file\'s own name. Attaching the same name again overwrites it, so pass the full replacement — and only after opening that file with memory_read_file this session (every page): replacing a file you have not read is refused. This tool only writes, and an empty overwrite is refused. Later sessions see the file listed by memory_search and memory_read and open it with memory_read_file; store the deep context here, never in a loose file elsewhere on the machine.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The 26-character id of the node to attach the file to.' },
        filename: { type: 'string', description: 'A plain file name: no path separators, no leading dot, not a reserved name (node.md, accessed.log, __edges__, MAP.md) that SAYS WHAT THE FILE CONTAINS (`magento-orders-grid-columns.md`). Required with `content`; defaults to the source basename with `from_path`. Use the deliverable\'s real name when it has one — a filename is an identifier the user will later ask by ("那份周报" resolves through `…-2025W32.md`), so a generic `attachment.md`/`notes.md` throws that handle away. Name it in the node body too, beside the artifact id it was delivered under.' },
        content: { type: 'string', description: 'The full file contents, the detail this conversation carries, organised and summarised however serves it \u2014 never a document invented because the turn merely named one: an untraceable payload is rejected and nothing is written. Exactly one of `content` and `from_path`.' },
        from_path: { type: 'string', description: 'Path of an existing file to copy into the node instead of retyping it (F30). The source is read only, never moved, deleted or modified. A leading ~ expands. ' + fromPathRule + ' Exactly one of `content` and `from_path`.' },
      },
    },
    // Audited pre-mutation refusal (#247 × #245): the attachment-overwrite
    // guard's three sites all run before this tool writes anything — the
    // content route's unlocked pre-check and its authoritative under-lock
    // re-check, and the `from_path` route's `authorize` hook (which
    // `attachFromPath` invokes on the Buffer it has read and is about to
    // publish, before the snapshot or the staged copy). `defineTool`'s scoped
    // helper is the only way to mint it.
    auditedRefusals: ['attach_overwrite_unseen'],
    // Pure argument shapes are rejected HERE, inside the trusted preparation
    // (#253) — one source of truth with memory_write's route, and provable
    // non-execution for a call that would otherwise throw from `attach` inside
    // the handler. Nothing stateful belongs in this hook: the deployment's
    // `from_path` setting and the allowed-roots/filesystem checks stay below.
    // The writer-chosen filename rules (#255: `observation.txt`, reserved
    // aliases, the byte cap) ride the same hook via `filenameViolation`.
    semantic: placeholderGuards ? (args) => [...attachArgumentViolations(args), ...placeholderAttachmentViolations('', args.filename, args.content)] : attachArgumentViolations,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'bytes', 'status'],
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          bytes: { type: 'integer' },
          status: { type: 'string', enum: ['created', 'overwritten'] },
          // Present only on a from_path attach: where the file was copied from
          // (the source stays in place, untouched).
          copied_from: { type: 'string' },
          // The generic-name advisory (F82, #191) on the standalone route —
          // same field, same meaning and same wording as on memory_write, so
          // the two routes cannot report differently on one filename (#167,
          // F78). A from_path attach is judged on the name it LANDED under,
          // which may be the source basename it defaulted to.
          generic_filename: { type: 'string' },
          // The evidence gates (F71, #157; F72, #152) on the standalone route
          // (F71.1, #167; round 13): same fields, same meaning as on
          // memory_write — see its schema for the full contract. Present only
          // when the content just attached carries flagged lines.
          unsourced_assertions: { type: 'array', items: { type: 'string' } },
          minted_precision: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.status === 'created' ? 'Attached' : 'Overwrote'} ${value.file} on ${value.id} (${value.bytes} bytes${value.copied_from ? `, copied from ${value.copied_from}` : ''}).`]
        // The detail tier's name (F82, #191), in memory_write's exact words.
        if (value.generic_filename !== undefined) {
          lines.push('', renderGenericFilename(value.generic_filename, value.id))
        }
        // The evidence gates (F71.1, #167), in memory_write's own voice — one
        // payload draws the same advisory however it was stored. Only the fix
        // mechanics differ: a body line is repaired by another memory_write,
        // an attachment line by re-attaching the full corrected file under
        // the same name (an attach with the same name overwrites).
        const assertions = value.unsourced_assertions ?? []
        if (assertions.length > 0) {
          lines.push('', `This attachment asserts what the assistant did (${assertions.length === 1 ? 'the line below' : `${assertions.length} lines below`}) without quoting a source. Nothing outside this turn can ever check such a claim, and invented searched-and-told-the-user episodes enter the graph exactly this way. If the turn in front of you states the event, put its words into the line verbatim in quotes (「…」) and re-attach the full corrected file under this same name — the quote has to cover the EVENT, not the request that preceded it, since 用户说「把报告念给我听」 evidences what was asked and nothing about what you then did; if it does not, the event is not knowledge — drop the line and re-attach:`)
          for (const line of assertions) lines.push(`  ${line}`)
        }
        const minted = value.minted_precision ?? []
        if (minted.length > 0) {
          lines.push('', `This attachment pairs a vague phrase with precision that resolves it (${minted.length === 1 ? 'the line below' : `${minted.length} lines below`}) — a relative week beside an absolute date, or a deferral beside a hard qualifier. A date or qualifier the source never stated is an inference, not the source's fact. If the turn in front of you states the precise half, put its words on the line in quotes (「…」); if you resolved or added it yourself, mark it on the same line — 推断, or for a resolved date the anchor form 「下周三, 以<anchor date>为基准」 — or drop the minted half. Then re-attach the full corrected file under this same name:`)
          for (const line of minted) lines.push(`  ${line}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    // `exec` is taken for the fidelity gates only (F71.2, #167): the prompting
    // turn is their second operand, and the standalone route has to read it
    // from the same place the write path does or the two report differently on
    // identical content — the property F78 shipped this route to hold.
    async execute(args, exec, refusal) {
      // The scoped audited-refusal helper (#245), for the overwrite guard's
      // pre-mutation refusals (`attach_overwrite_unseen`). It brands the
      // ORIGINAL error object for THIS definition/exec/invocation and returns
      // it unchanged; `undefined` when no codes were declared.
      const brandRefusal = (code, error) => (refusal === undefined ? error : refusal(code, error))
      const refuseUnseenOverwrite = (error) => brandRefusal('attach_overwrite_unseen', error)
      // Exactly one source, a `filename` with `content`, the filename rules and
      // the size cap are rejected by this tool's `semantic` preparation (#253),
      // so they never reach this handler — the same one-authority rule as
      // memory_write's. That also means a rejected name can never reach F88.3's
      // correction path (which APPENDS to node.md), which is the ordering the
      // shape check was originally placed here to guarantee. `attach` /
      // `attachFromPath` still re-run the name and byte rules, as the
      // storage-layer authority.
      let outcome
      // #317: the attach transitions this call made — one line per landed file,
      // flushed after the write commits.
      const provenanceLines = []
      const provenanceAt = Date.now()
      try {
        if (args.content !== undefined) {
          // #247: an overwrite of a file this Session never read is refused here
          // FIRST, before F88 runs — and therefore before its correction path
          // takes this node's lock (withNodeLocks is not reentrant). Keep BOTH
          // outside the lock below: F88 awaits other things and may take the lock
          // itself.
          // Audited (`attach_overwrite_unseen`): nothing has been written on this
          // route yet, and the guard itself only reads.
          const incoming = Buffer.from(args.content, 'utf8')
          await refuseUnseenAttachmentOverwrite('memory_attach', args.id, args.filename, incoming, exec, refuseUnseenOverwrite)
          // F88 (#157) on the standalone route too: round 13's fabrication took
          // exactly this path after the inline one refused it, so a check on one
          // route only is a bypass, not a precondition (the lesson #178 records
          // about F76's rejection being reachable around).
          await refuseUntraceableAttachment('memory_attach', args.content, exec, args.id, args.filename)
          // Re-check and write in ONE critical section: a peer's attach between
          // the check and this write would otherwise be overwritten unseen.
          // Audited (`attach_overwrite_unseen`): the re-check is the section's
          // first statement, so `attach` below is still this call's first write.
          const written = await withNodeLocks(root, [args.id], async () => {
            const verdict = await refuseUnseenAttachmentOverwrite('memory_attach', args.id, args.filename, incoming, exec, refuseUnseenOverwrite)
            const result = await attach(root, args.id, args.filename, args.content, { snapshot: !verdict.preserved })
            // #317: the file landed — one attach transition for this node.
            provenanceLines.push({ id: args.id, op: 'attach', file: result.file })
            await recordFileWritten(exec, args.id, args.filename, incoming, preservedAfterWrite({
              existed: verdict.state !== 'missing',
              preservedBefore: verdict.preserved,
              identical: verdict.identical,
            }))
            return result
          })
          outcome = { id: args.id, ...written }
        } else {
          if (!fromPathEnabled) {
            throw new Error('memory_attach: `from_path` is disabled in this deployment (attachFromPath: false) — nothing was read; pass the text as `content` instead')
          }
          const source = expandHome(args.from_path)
          // The name to store is derived by the SAME pure helper the trusted
          // preparation validated (`fromPathAttachmentName`), so preparation and
          // handler cannot disagree about which name lands — `path.basename` of
          // the raw argument does disagree for a trailing `.`/`..` segment
          // (review 2 of #253). `attachFromPath` re-runs the name rule itself.
          // #247: there is deliberately NO separate read of the source here. The
          // loose source is not covered by the node lock, so bytes that matched an
          // unread destination a moment ago can be different ones by the time the
          // copy is made — and an unlocked pre-check cannot close that (review
          // finding 2). The authorization therefore runs on the exact Buffer
          // `attachFromPath` has already read from its validated handle and is
          // about to publish: `authorize` is invoked after that read and before the
          // snapshot or the destination is touched.
          //
          // Audited (`attach_overwrite_unseen`): the guard runs inside graph.js's
          // own frame, so what it brands is the Error this handler's call stack
          // throws after `attachFromPath` has done nothing but READ (source bytes,
          // destination metadata) — the snapshot and the staged copy are both
          // below the hook. The branded Error is never caught or rewrapped on the
          // way out, so `defineTool` still sees this invocation's own throw.
          const written = await withNodeLocks(root, [args.id], async () => {
            let verdict = { state: 'missing', preserved: false, identical: false }
            let landedBytes
            const result = await attachFromPath(root, args.id, source, args.filename ?? fromPathAttachmentName(args.from_path), {
              allowedRoots: attachFromPathRoots,
              authorize: async ({ file, data }) => {
                verdict = await refuseUnseenAttachmentOverwrite('memory_attach', args.id, file, data, exec, refuseUnseenOverwrite)
                landedBytes = data
                return { snapshot: !verdict.preserved }
              },
            })
            // The file is on disk now, so the record describes what landed: for a
            // from_path copy those are the source's bytes, and this Session put
            // them there.
            // #317: one attach transition, named for the file that actually landed.
            provenanceLines.push({ id: args.id, op: 'attach', file: result.file })
            if (landedBytes !== undefined) {
              await recordFileWritten(exec, args.id, result.file, landedBytes, preservedAfterWrite({
                existed: verdict.state !== 'missing',
                preservedBefore: verdict.preserved,
                identical: verdict.identical,
              }))
            }
            return result
          })
          outcome = { id: args.id, ...written, copied_from: source }
        }
        // #263: the file is published, so the frozen prompt must not keep
        // claiming the graph it opened with. Both routes converge here — the
        // `content` route above and the `from_path` route above it — and only
        // AFTER a successful `attach`/`attachFromPath`, so a refused or rejected
        // call leaves the snapshot intact. `dropSnapshot` also expires the TTL
        // caches, which this path never reset before: without that, a still-fresh
        // `cached` would be re-captured verbatim and the run would freeze the
        // PRE-attach bytes for the rest of its life. Off-snapshot the call is a
        // no-op, so this path's legacy behavior is unchanged.
        dropSnapshot()
        // The evidence gates (F71, #157; F72, #152) on the standalone route —
        // the remaining ungated half of F71.1 (#167; round 13). #170 put
        // `attach.content` in front of both gates everywhere memory_write can
        // carry it, and this tool stayed the one write path with no gate at
        // all: round 13's turn 6 routed a 1,462-byte fabricated document
        // through here, unscanned, right after the inline path rejected it
        // (#171). A bypass close, not a catch — measured over all four replay
        // corpora, the route's one wild payload is report prose that draws no
        // fire — so what this buys is that the free route stops being free.
        // Same posture as the write path: the file already landed above, and
        // the gates are advisory about it. A from_path attach is scanned from
        // the file it just copied in (bounded by the attach size cap); the
        // prior side is the node's own description and body, exactly as an
        // inline attach scans on update — content already carried there is
        // history, not a new claim. The prior body is unescaped like F55's, so
        // a legacy node's glued lines still vouch for what they carry.
        let unsourcedAssertions = []
        let mintedPrecision = []
        try {
          let scanned = args.content
          if (scanned === undefined) {
            scanned = await fsp.readFile(path.join(root, args.id, outcome.file), 'utf8')
            // NUL or U+FFFD after the decode means bytes, not text — the same
            // binary signal the attachment search and summaries use (F42, #69).
            // A from_path file may legitimately be one, and running a text gate
            // over mangled bytes can only mint a nonsense advisory.
            if (/[\u0000\uFFFD]/.test(scanned)) scanned = ''
          }
          const prior = await loadNode(root, args.id)
          const priorScanned = [prior?.description ?? '', prior === undefined ? '' : normalizeBody(prior.body)].join('\n')
          unsourcedAssertions = unsourcedAssertionLines(scanned, priorScanned, promptingTurn(exec) ?? '')
          mintedPrecision = mintedPrecisionLines(scanned, priorScanned)
        } catch (error) {
          // The scan reads the landed file and the node back, and either read
          // can fail on its own. It must not unwind the attach it is advisory
          // ABOUT: the file is durably stored, so an error here would read as
          // "not stored" when it was — the exact blindness the
          // inline path's never-thrown attach_failed exists to prevent (F74,
          // #163, sonnet review of this change). Degraded, but not SILENTLY
          // (review of #176): a regression that made the gates themselves
          // throw would otherwise disable this fidelity scan invisibly, so the
          // degrade path leaves a stderr trace the way the journal reports its
          // own append failure (F64, #109) — a line for the operator, never an
          // error in the result.
          try {
            process.stderr.write(`memory-graph: could not run the fidelity gates over ${outcome.file} on ${args.id} — ${error.message} (F71.1, #167). The attachment itself landed.\n`)
          } catch { /* no channel left to report on, and the file is safe either way */ }
        }
        // The detail tier's name (F82, #191), judged on the name the file landed
        // under — for a from_path attach that is the source basename when none
        // was given, which is exactly where a stray `notes.md` walks in.
        const genericFilename = genericAttachmentName(outcome.file)
        const result = { ...outcome, ...(genericFilename === undefined ? {} : { generic_filename: genericFilename }), ...(unsourcedAssertions.length === 0 ? {} : { unsourced_assertions: unsourcedAssertions }), ...(mintedPrecision.length === 0 ? {} : { minted_precision: mintedPrecision }) }
        // Mirrored to the journal like every advisory a writer is shown (F64,
        // #109) — advisoryEntries already speaks these two kinds, and a clean
        // attach journals nothing, exactly as before.
        await journalAdvisories(result)
        return result
      } finally {
        // #317/#321: the ONE flush, on every exit — a normal return and a throw
        // alike. It sits outside every lock scope, so no node lock is held while
        // bookkeeping is written, and `recordProvenance` is fail-open: the
        // original result and error (including a branded refusal) pass through
        // untouched. Deleting the old tail flush keeps the landed file from
        // being logged twice (the input array is drained at entry).
        await recordProvenance(provenanceLines, exec, provenanceTs(provenanceAt))
      }
    },
    // The name may be defaulted from the source (F30): never title the card
    // "Attach undefined".
    presentCall: (args) => ({ card: 'generic', title: `Attach ${args.filename ?? (typeof args.from_path === 'string' ? path.basename(args.from_path) : '?')} to ${args.id}`, kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_restore',
    description: 'Restore an archived memory node back into the live graph so search and read reach it again. Archived nodes are ones maintenance moved aside for staleness; find their ids with `memory_search` and `include_archived`, then pass one here. Its edges resolve again once restored. Errors when the id is not archived — an active or unknown node has nothing to recover.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The 26-character id of an archived node.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'restored'],
        properties: {
          id: { type: 'string' },
          restored: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Restored ${value.id} — it is live in the graph again.` }],
    },
    async execute(args, exec) {
      // #317: the restore's provenance gets its own clock reading, taken
      // before the mutation so the line cannot name a later moment.
      const provenanceAt = Date.now()
      // The restore transition, pushed the moment the swap returns (#321) and
      // drained in the `finally`: the node is live on disk from there on, so a
      // later throw (the index refresh) must not lose its line.
      const provenanceLines = []
      try {
        await restoreNode(root, args.id)
        provenanceLines.push({ id: args.id, op: 'restore' })
        // The graph changed, so the cached index is stale regardless of its age.
        cached = { at: 0, text: '' }
        cachedHandoffs = { at: 0, text: '' }
        cachedWorkState = { at: 0, nodes: [] }
        // #263: a successful content mutation also drops the run's frozen prompt
        // render, so the next assembly shows the new graph. This is the ONLY
        // drop path on purpose: access bookkeeping (`memory_read`'s touchRead) and
        // a traversal read's edge wiring are discovery effects, not content
        // changes, and must not re-render the prompt mid-run. A read-authority
        // wrapper registers no handler here at all, so this is the defensive half
        // for a deployment that enables the snapshot where writes can happen.
        dropSnapshot()
        await refreshIndex()
        return { id: args.id, restored: true }
      } finally {
        // #317/#321: awaited and fail-open, so an index-refresh throw still
        // reports the restore it left live.
        await recordProvenance(provenanceLines, exec, provenanceTs(provenanceAt))
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Restore memory ${args.id}`, kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_merge',
    description: 'Merge two memory nodes that record the same fact into one (F17, #26). `keep_id` survives; `absorb_id` is folded into it and archived. The absorbed body is appended to keep under a "Merged from …" divider, keep inherits the absorbed node\'s outgoing edges, every node that pointed at the absorbed one is repointed at keep, and any attached files move into keep. Use when two nodes are genuinely the same fact — for a changed decision, prefer `supersedes` (which keeps both on record) instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keep_id', 'absorb_id'],
      properties: {
        keep_id: { type: 'string', description: 'The 26-character id of the node to keep.' },
        absorb_id: { type: 'string', description: 'The 26-character id of the node to fold in and archive.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['keep_id', 'absorb_id', 'merged', 'edges_repointed', 'files_moved'],
        properties: {
          keep_id: { type: 'string' },
          absorb_id: { type: 'string' },
          merged: { type: 'boolean' },
          edges_repointed: { type: 'integer' },
          files_moved: { type: 'integer' },
          // Present only when the absorbed block restates what the kept body
          // already says (F72, #152): up to three absorbed lines whose content
          // units the kept body covers past MERGE_RESTATED_COVERAGE, each
          // through the journal digest. Merge mechanics are untouched — the
          // append-plus-divider write and the archive are the recovery path;
          // this only asks the writer for the synthesis pass.
          restated_lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`Merged ${value.absorb_id} into ${value.keep_id} — ${value.edges_repointed} edge${value.edges_repointed === 1 ? '' : 's'} repointed, ${value.files_moved} file${value.files_moved === 1 ? '' : 's'} moved. The absorbed node was archived.`]
        // The synthesis nudge (F72, #152), in the write advisories' register:
        // the finding, then the imperative naming the next calls. It orders
        // the read first — the merged body may never have been shown this
        // turn, and a from-memory rewrite is exactly the F62 failure.
        const restated = value.restated_lines ?? []
        if (restated.length > 0) {
          lines.push('', `The merged body now states the same fact twice: ${restated.length === 1 ? 'the absorbed line below restates' : `${restated.length} absorbed lines below restate`} what the kept body already says. memory_read ${value.keep_id}, then rewrite its body into ONE statement of each fact with memory_write passing that id, keeping one provenance line ("Merged from ${value.absorb_id} on <date>.") — the absorbed original stays readable in the archive, so the synthesis loses nothing:`)
          for (const line of restated) lines.push(`  ${line}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const { seenBodies, versionSeen } = sessionState(sessionKeyOf(exec))
      // #317: one clock reading for the two lines this merge writes.
      const provenanceAt = Date.now()
      // #321: mergeNodes' receipts, translated to lines in the `finally` below —
      // so a merge that throws after keep's note landed still reports `merge`,
      // and one that throws between the two reports exactly what is on disk.
      const receipts = []
      try {
        const { keepNode, keptBody, absorbedBody, ...result } = await mergeNodes(root, args.keep_id, args.absorb_id, undefined, receipts)
        // The kept node's body just grew by the absorbed one's, which this turn
        // may never have been shown — so whatever it had read stops being the
        // current body (F62, #107). Only after the merge SUCCEEDS: mergeNodes
        // validates before it mutates (missing, archived, or self-merge all
        // throw untouched), and forgetting on a rejected call would make the
        // next honest rewrite of a node this turn did read fire a false alarm.
        // Supersede needs no such reset: it only prepends a banner the write
        // result itself announces, leaving every fact the reader saw in place.
        seenBodies.delete(args.keep_id)
        // Merge's own writes are protected by mergeNodes' complete lock set. Hash the
        // exact kept Node mergeNodes wrote, not a later unlocked disk read that
        // could capture somebody else's intervening bytes (F68, #129). Refresh
        // only after success so a rejected merge leaves any prior read valid.
        versionSeen.set(args.keep_id, hashBytes(Buffer.from(renderNode(keepNode), 'utf8')))
        // The graph changed, so the cached index is stale regardless of its age.
        cached = { at: 0, text: '' }
        cachedHandoffs = { at: 0, text: '' }
        cachedWorkState = { at: 0, nodes: [] }
        // #263: a successful content mutation also drops the run's frozen prompt
        // render, so the next assembly shows the new graph. This is the ONLY
        // drop path on purpose: access bookkeeping (`memory_read`'s touchRead) and
        // a traversal read's edge wiring are discovery effects, not content
        // changes, and must not re-render the prompt mid-run. A read-authority
        // wrapper registers no handler here at all, so this is the defensive half
        // for a deployment that enables the snapshot where writes can happen.
        dropSnapshot()
        await refreshIndex()
        // The synthesis nudge (F72, #152). The two halves come from mergeNodes
        // itself — the bodies it read under its own lock set, before the append
        // (codex pre-merge review of #162). Re-deriving the boundary by scanning
        // the merged body for the divider picked the wrong occurrence whenever
        // an absorbed body quoted a `Merged from …` header of its own, which a
        // restore-and-remerge cycle produces legitimately.
        const restated = restatedLines(absorbedBody, keptBody)
        const outcome = { ...result, ...(restated.length === 0 ? {} : { restated_lines: restated }) }
        // F64: the nudge rides the same journal as every write advisory.
        await journalAdvisories(outcome)
        return outcome
      } finally {
        // #317/#321: `merge` on keep, `merged-into` on absorb — from the
        // receipts, so a partial merge reports exactly the halves that landed:
        // `merge` alone when absorb's banner never did, the pair once it did
        // (even if archiving then failed). The edges repointed on third-party
        // nodes are deliberately NOT logged one by one (the design's table):
        // they follow from the node lines. One clock reading serves both, so a
        // pair cannot disagree about when. Awaited and fail-open.
        const provenanceLines = []
        for (const receipt of receipts) {
          if (receipt.kind === 'merge-keep') provenanceLines.push({ id: args.keep_id, op: 'merge', peer: args.absorb_id })
          else if (receipt.kind === 'merge-absorb') provenanceLines.push({ id: args.absorb_id, op: 'merged-into', peer: args.keep_id })
        }
        await recordProvenance(provenanceLines, exec, provenanceTs(provenanceAt))
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Merge memory ${args.absorb_id} into ${args.keep_id}`, kind: 'edit', rawInput: args }),
  }))
}
