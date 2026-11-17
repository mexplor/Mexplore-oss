/**
 * The plugin layer: what `apply()` registers, what each tool returns, and
 * whether the hand-written schemas survive the real registry's assertion.
 */
// The suite asserts calendar dates against fixed instants, so it pins its own
// timezone: date stamps are local now (see today()), and an unpinned runner
// would flip those assertions by its UTC offset. The local-vs-UTC behaviour of
// today() itself is covered by a dedicated test that forks with TZ set.
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ATTACH_MAX_BYTES, ATTACH_READ_BYTES, PREV_NODE_FILE, STALE_LOCK_MS, ULID_RE, addEdge, createNode, edgeTypes, outEdges, parseNode, today, weekdayName, withNodeLocks } from '../lib/graph.js'
import { apply, contradictedFigures, inject, mintedPrecisionLines, name, turnCoverage, unsourcedAssertionLines } from '../lib/index.js'
import { ToolArgsError, defineTool, restateDeclaredPropertiesRemedy, trustedPreparationFor, validate } from '../lib/tool.js'

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-plugin-')) })
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

/** A context that records what the plugin registers, standing in for Cordis. */
function fakeCtx({ withPrompt = true } = {}) {
  const tools = new Map()
  const sections = []
  const variables = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(names, callback) {
      if (names.includes('systemPrompt') && !withPrompt) return
      callback({
        systemPrompt: {
          section: (section) => { sections.push(section); return () => {} },
          variable: (variableName, provider) => { variables.set(variableName, provider); return () => {} },
        },
      })
    },
  }
  return { ctx, tools, sections, variables }
}

/** Yield once, for the tests that only need pending microtasks drained. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * The section as a harness renders it: every `{{slot}}` replaced by the value
 * its registered variable produces. #263 W2.1 moved the write-time bullets into
 * named constants behind slots, so a test that means "the model sees this
 * guidance" must read the RENDERED prompt, not the template source — the
 * template is a layout, and only the rendered text is the product surface.
 * A slot with no registered variable renders as '' (the harness contract the
 * plugin has always relied on for `memory_append_line`).
 *
 * `keep` names slots to leave UNEXPANDED, for the assertions about a slot's own
 * placement (a token that must sit directly above a sentence, a date slot whose
 * value is the machine's clock).
 */
function renderSection({ sections, variables }, { keep = [] } = {}) {
  return sections[0].text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (keep.includes(key)) return match
    const provider = variables.get(key)
    if (provider === undefined) return ''
    return typeof provider === 'function' ? provider({}) : String(provider)
  })
}

test('the plugin exports the loader-visible shape', () => {
  assert.equal(name, 'memory-graph')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers exactly the seven memory tools and one prompt section', async () => {
  const { ctx, tools, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  assert.deepEqual([...tools.keys()].sort(), ['memory_attach', 'memory_merge', 'memory_read', 'memory_read_file', 'memory_restore', 'memory_search', 'memory_write'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'memory:graph')
  assert.match(sections[0].text, /\{\{memory_index\}\}/)
  assert.ok(variables.has('memory_index'), 'the section references a variable it must also register')
  assert.equal(variables.get('memory_index')(), '(empty — nothing has been remembered yet)')
  assert.doesNotMatch(sections[0].text, /not yet read/)
})

test('the section anchors relative dates on a live date, never a literal (ledger #20)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  // A hardcoded date anywhere in the guidance is what the model copied into
  // stored bodies instead of resolving "today" — it must not come back.
  assert.doesNotMatch(sections[0].text, /\d{4}-\d{2}-\d{2}/, 'no date literal may appear in the guidance')
  assert.match(sections[0].text, /\{\{memory_today\}\}/)
  assert.ok(variables.has('memory_today'), 'the section references a variable it must also register')
  // This asserts the wiring — the section gets the graph layer's own date, not a
  // second implementation of it. That the date is the *machine's* (local, not a
  // UTC slice) is asserted in graph.test.js, which forks with TZ set.
  assert.equal(variables.get('memory_today')(), `${today()} (${weekdayName(today())})`)
})

// F80 (#184): the answer phase, not the write phase — 89 of 104 failed DEMO-V2
// answers searched once and 12 not at all, and a1b2c3d4/b2c3d4e5/c3d4e5f6 lost
// to rows that matched and were never opened. Both halves are guidance the
// search bullets must carry; the mechanical half rides the search result.
test('the section sets a search-depth floor and a follow-through-before-answering rule (F80, #184)', async () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const lines = sections[0].text.split('\n')
  const depth = lines.find((line) => line.includes('ONE search is never a miss'))
  assert.ok(depth, 'the search-depth floor is present')
  assert.match(depth, /That retry is REQUIRED before you tell the user nothing is stored/)
  // #188 shipped the miss half of follow-through ("only once the promising rows
  // have been followed through"), so this bullet carries only what that one does
  // not: the ANSWER path, and that rank is not relevance. Duplicating #188's
  // clause here would give one rule two owners that can drift apart.
  const unread = lines.find((line) => line.includes('gates a POSITIVE answer too'))
  assert.ok(unread, 'the follow-through-before-answering rule is present')
  assert.match(unread, /before you answer FROM a row/)
  assert.match(unread, /not by where they rank/)
  assert.doesNotMatch(unread, /memory_read_file/, "the miss half's tool call stays in #188's bullet, unduplicated")
  // Reading order: the depth floor states the retries #188's bullet then calls
  // "those retries", and the answer-path clause refers back to its follow-
  // through — so this bullet sits before #188's and that one after it.
  const miss = lines.findIndex((line) => line.includes('IS the answer'))
  assert.ok(lines.indexOf(depth) < miss, 'the depth floor precedes the miss verdict that cites its retries')
  assert.ok(lines.indexOf(unread) > miss, 'the answer-path clause follows the follow-through it extends')
})

// #183: on DEMO-V2, 27 of 135 failures admitted "my memory does not contain X"
// and then answered anyway from generic world knowledge about the environment —
// nearly all on questions whose gold answer was "that element does not exist".
// Two inverse cases refused an answerable question, so the rule is calibration:
// it must sit with the search bullets (answer time, not write time), forbid the
// world-knowledge bridge, name the premise-style phrasings, and still say that a
// search which DID answer gets answered.
test('the section makes a memory miss the answer, not a preamble to a guess (#183)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const lines = renderSection({ sections, variables }).split('\n')
  const bullet = lines.find((line) => line.includes('IS the answer'))
  assert.ok(bullet, 'the abstention-calibration bullet is present')
  assert.match(bullet, /Never bridge the miss/, 'the world-knowledge bridge must be named and forbidden')
  assert.match(bullet, /there is no such element/, 'premise-style questions get the no-such-element default')
  assert.match(bullet, /negative evidence/, 'retrieved negatives must outrank generic knowledge')
  assert.match(bullet, /not reflex refusal/, 'the inverse failure — refusing an answerable question — stays guarded')
  // codex review of #188: the rule declares a miss, so it must also say when a
  // miss may be declared — after the promising rows are followed through, node
  // and named attachments opened. Without the ordering it terminates retrieval
  // one step early and calls recorded data unrecorded, which is exactly the
  // attachment-retrieval failure class #182/#190 found dominating DEMO-V2. This
  // governs what counts as exhausted; #184's bullet governs how many searches.
  assert.match(bullet, /only once the promising rows have been followed through/, 'a miss is declarable only after follow-through')
  assert.match(bullet, /memory_read_file/, 'the follow-through names the tool that opens a matched file')
  assert.ok(bullet.indexOf('followed through') < bullet.indexOf('Never bridge the miss'), 'the follow-through precedes the miss verdict it gates')
  // Answer-time guidance, so it rides with the search bullets: after the
  // reword-the-missed-terms bullet, before the first write bullet.
  const at = lines.indexOf(bullet)
  assert.ok(at > lines.findIndex((line) => line.includes('Search matches words, not meaning')), 'it follows the search bullets')
  assert.ok(at < lines.findIndex((line) => line.includes('When you learn something durable')), 'it precedes the write bullets')
  // independent review of #188: the exemption bullet below tells the writer NOT to
  // store what the repository, shell, or conversation already answers, so a
  // memory miss on exactly those facts is expected — it must not read as a bar
  // on going and reading them. The prohibition is on the guess, not the lookup.
  assert.match(bullet, /the miss never bars reading it/, 'an authoritative non-memory source stays reachable after a miss')
  // The raw-filesystem twin carries the whole contract, not just its opening —
  // a partially-pinned twin can lose the premise default or the inverse guard
  // while this test stays green (independent review of #188).
  const agents = await fsp.readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  assert.match(agents, /Never bridge the miss/, 'the raw-filesystem twin states the same rule')
  assert.match(agents, /only once the promising nodes have been followed through/, 'the twin gates the miss verdict the same way')
  assert.match(agents, /there is no such element/, 'the twin keeps the premise-style default')
  assert.match(agents, /negative evidence/, 'the twin keeps the negative-evidence precedence')
  assert.match(agents, /not reflex refusal/, 'the twin keeps the inverse-refusal guard')
  assert.match(agents, /the miss never bars reading it/, 'the twin keeps the authoritative-source escape hatch')
})

// F49 (#85): the writer over-extended "retrievable elsewhere" to rules — the
// synthetic replay stored the .md output rule 3/3 sessions, the graph 0/3. The
// carve-out must live inside the exemption bullet itself: a separate bullet
// ten lines away loses to the exemption again.
test('the section stores preferences and retractions unconditionally (F49, #85)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('Do not store what the repository'))
  assert.ok(bullet, 'the do-not-store exemption bullet is still present')
  assert.match(bullet, /ALWAYS stored/, 'the preference carve-out must share the exemption bullet, not trail it')
  assert.match(bullet, /type: preference/)
  assert.match(renderSection({ sections, variables }), /retraction[\s\S]*supersedes[\s\S]*never re-merge the withdrawn version/)
})

// F50 (#86): a segment ending on an archived/elided tool result had its
// invisible payload reconstructed from world knowledge and stored as fact —
// the synthetic replay's fabricated pricing-stance node. A stored fabrication
// contradicts nothing, so no judge flags it; the rule must make the gap
// itself the thing stored.
test('the section treats invisible tool results as unknowns, never reconstructions (F50, #86)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('archived, truncated, elided'))
  assert.ok(bullet, 'the invisible-result bullet is present')
  assert.match(bullet, /UNKNOWN/, 'the unknown framing must be explicit')
  assert.match(bullet, /never a reconstruction/)
  assert.match(bullet, /cannot quote it/)
})

// F60 (#105): 4 of 39 replay turns exited without writing — the agent answered
// the absent user, or went silent, and one lost a delivered report outright.
// F50 contributed: a segment mixing visible prose with elided stubs read as
// wholly unusable. The floor must sit in the same neighbourhood as the F50
// bullet it repairs (the F49 lesson about carve-outs that trail their rule).
// F66 (#120) re-scoped the floor after QA pass 7: the unconditional version
// minted noise nodes on contentless turns (Z4/P2) and left already-stored
// turns with no sanctioned ending (DUP1/DUP2 zero-wrote → false markers).
test('the section makes an UNKNOWN the floor for a memory turn (F60, #105; F66, #120)', async () => {
  const { ctx, sections, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('ALWAYS ends in a write'))
  assert.ok(bullet, 'a bullet must own the zero-write floor')
  assert.match(bullet, /write ONE node/, 'the floor is one node, not a vague obligation')
  assert.match(bullet, /what the conversation covered and which questions it left open/)
  // The floor stays biased toward writing — the 0/28 headline must not regress.
  assert.match(bullet, /when in doubt, it does/)
  // The role-confusion shape: the agent answered the absent user instead.
  assert.match(bullet, /the user is not present to be asked/)
  // The explicit repair of F50's over-generalization.
  assert.match(bullet, /mixing visible prose with elided tool results is not unusable/)
  assert.match(bullet, /store the visible facts, store the elided parts as open questions/)
  // F66: the already-stored close is an id-write, never a restatement or silence.
  assert.match(bullet, /revise or link the covering node/)
  // The codex catch on #122: the close records the re-confirmation — it is
  // never a bare no-op write that games the marker while changing nothing.
  assert.match(bullet, /only the re-confirmation itself/)
  assert.match(bullet, /[Nn]ever a fresh node restating it/)
  assert.match(bullet, /never a bare no-op write/)
  // F66: the one sanctioned no-write ending, and the noise-node ban.
  assert.match(bullet, /pure pleasantries/)
  assert.match(bullet, /never mint a node whose only content is that there was nothing to store/)
  // It sits directly after the F50 bullet it repairs, not ten lines away.
  const lines = renderSection({ sections, variables }).split('\n')
  assert.equal(lines.indexOf(bullet) - lines.findIndex((line) => line.includes('archived, truncated, elided')), 1)
  // F66: the narration rule trails the floor it audits (the F49 placement lesson).
  const narration = lines[lines.indexOf(bullet) + 1]
  assert.match(narration, /reporting what you actually wrote/)
  assert.match(narration, /Never claim a write happened, or that none was needed/)
  // The tool description carries the floor too — the write tool is where the
  // decision "nothing to store" is actually taken.
  assert.match(tools.get('memory_write').description, /always ends in a write.*nothing certain emerged/s)
  assert.match(tools.get('memory_write').description, /revise or link the covering node by `id`/)
})

// F58 (#94): the bulk-detail bullet described the attach CONVENTION but never
// said when to reach for it — in a 39-turn replay over segments dense with
// verbatim multi-KB worker reports, memory_attach was called zero times and
// the payloads were lossily summarized or dropped. The trigger must live in
// the same bullet as the convention (the F49 lesson) and must name both input
// paths, since replay proved the inline-content path goes unused too.
// F73 (#159) redefined the trigger it asserts: at turn granularity no single
// turn reaches a size bar (largest 2,518 chars, median 467), so the bullet
// must state SHAPE — a verbatim deliverable — never "bulk".
// F82 (#191) widened the trigger once more: shape caught only deliverables,
// and adoption stayed at 0 (deliverable-shaped turns w/o attach 9/9 in v5 and
// v6). The attachment is now the node's curated DETAIL TIER — any detail
// beyond the gist — with the verbatim deliverable kept as its sharpest case,
// not a separate trigger.
test('the section tells the writer WHEN to attach, not just how (F58, #94; trigger reshaped by F73, #159; one-call path by F74, #163; detail tier by F82, #191; split by kind by F82.1, #216)', async () => {

// F82.1 (#216): the licence is a shape, not a phrasing. This catches any
// sentence that tells the writer to copy/repeat/restate the file into the
// body, UNLESS that same sentence goes on to say it buys nothing — so a
// reworded licence ("copy the attachment into the body in full whenever the
// contents must rank") cannot slip back in past a literal-string guard.
const TWIN_WRITE_LICENCE = /(cop(y|ies|ied)|repeat\w*|restat\w+|reproduc\w+|duplicat\w+)[^.]{0,100}\bbod(y|ies)\b(?![^.]*buys nothing)/i

  const { ctx, sections, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('memory_attach'))
  assert.ok(bullet, 'the detail-tier bullet is still present')
  // The tier, and which half of it each fact belongs to (F82, #191).
  assert.match(bullet, /two tiers/, 'the node is stated as two tiers, not a body plus optional extras')
  assert.match(bullet, /most succinct version/, 'the body is named as the succinct tier')
  assert.match(bullet, /curated DETAIL TIER/, 'the attachment is named as the detail tier')
  assert.match(bullet, /detail beyond the gist/, 'the trigger is detail beyond the gist')
  assert.match(bullet, /complete list.*table.*full enumeration of an interface's options.*click or step sequence/, 'the trigger names the detail kinds the enumeration corpus loses')
  // F82.1 (#216): the tier split is by KIND, not by degree. F82's blanket
  // duplication licence, paired with the true warning that a fact moved out of
  // the body stops ranking, made writing both copies in full the rational move
  // — measured on the DEMO `_m` corpus as 669 curated attachments carrying a
  // median 1981-byte file beside a 1088-byte body that restated it.
  assert.match(bullet, /split between the tiers is by KIND, not by degree/, 'the split is stated by kind, not by degree')
  assert.match(bullet, /BODY keeps the retrieval keys at full weight/, 'the body keeps the keys')
  assert.match(bullet, /FILE keeps the bulk/, 'the file keeps the bulk')
  assert.match(bullet, /Restating the file's rows in the body buys nothing/, 'the twin write is named as buying nothing')
  assert.doesNotMatch(bullet, /duplicat\w*[^.]{0,80}(expected|not waste|encouraged)/i, 'F82.1 (#216): no duplication licence, in any wording')
  assert.doesNotMatch(bullet, TWIN_WRITE_LICENCE, 'F82.1 (#216): no sentence rewards copying the file into the body')
  // The clause that protects the FILE is adjacent to the removed licence and
  // is the likeliest accidental casualty — it guards the opposite failure.
  assert.match(bullet, /never trim the detail file down to what the body left out/)
  // The ranking caveat: without it, writers move load-bearing facts out of the
  // body and recall regresses (F82 fix 3).
  assert.match(bullet, /full weight and attachments only at a fraction of it/, 'the ranking asymmetry is stated')
  assert.doesNotMatch(bullet, /stops being findable/, 'F82.1 (#216): the findability warning that licensed the twin write is gone')
  // The verbatim deliverable survives as a special case of the tier.
  assert.match(bullet, /verbatim deliverable is the sharpest case of this tier, not a separate trigger/)
  assert.match(bullet, /delivered report.*multi-row table.*recited transcript or quoted document/, 'the trigger names concrete payload kinds')
  assert.match(bullet, /however short/, 'size explicitly does not gate the trigger')
  // F88.2 (#157): the pre-write half of the traceability gate. F88 rejects a
  // composed payload at the tool boundary, but the generation is already paid
  // for by then (turn 87: 2,125 output tokens authored, then refused). The
  // only surface that can stop the drafting is the text the writer reads
  // before it writes.
  assert.match(bullet, /An attachment is CAPTURED from this exchange, never INVENTED beyond it/, 'the capture rule is stated in the section text')
  assert.match(bullet, /only NAMES an artifact/, 'the named-but-absent artifact is the case called out')
  assert.match(bullet, /REJECT a payload whose content does not trace back to this conversation/, 'the writer is told the gate exists before it drafts')
  // F88.2a (#157): the first wording overshot — in synthetic retries, the
  // writer stopped attaching turn 105's genuine AR/TNGD/PCI summary (attached
  // in both F88.1 arms) because it was the assistant's own synthesis rather
  // than text quoted from the user. The licence line runs through where the
  // FACTS come from, and the permission has to be as explicit as the bar.
  assert.match(bullet, /where the FACTS come from, not through who phrased them/, 'the line is drawn at provenance, not authorship')
  assert.match(bullet, /Organising, merging, reformatting or summarising what this exchange carries IS capture/, 'synthesis of carried content is explicitly permitted')
  assert.match(bullet, /Ordinary dialogue has no detail tier/, 'the non-goal is stated: a passing remark needs no file')
  assert.match(bullet, /`content` when the detail exists only in the conversation/, 'the inline path is named')
  assert.match(bullet, /`from_path` when it is already a file on disk/, 'the on-disk path is named')
  assert.match(bullet, /gist card/, 'the body becomes the gist card')
  assert.match(bullet, /cannot be re-served when the user asks for it back/)
  // The filename rule the advisory backs (F82 fix 2), stated where the writer
  // chooses the name rather than only after it has landed.
  assert.match(bullet, /The FILENAME says what the file contains/)
  assert.match(bullet, /magento-orders-grid-columns\.md/)
  assert.match(bullet, /never `attachment\.md`\/`notes\.md`\/`details\.md`/)
  // F74 (#163): naming the trigger was not enough — acting on it cost a second
  // memory_write plus a memory_attach, and the second call never came (0
  // attaches in 120 turns, three rounds). The bullet leads with the one-call
  // path, and the same rule reaches the surface the writer reads immediately
  // BEFORE the call: memory_write's own description.
  assert.match(bullet, /attach: \{filename, content\}/, 'the one-call path is named')
  assert.match(bullet, /ONE call/)
  const write = tools.get('memory_write')
  assert.match(write.description, /recites a verbatim deliverable/, 'the trigger is named by shape before the call, not only after it')
  assert.match(write.description, /a table, an enumeration of an artifact's items, quoted full text/)
  assert.match(write.description, /`attach: \{filename, content\}` in THIS call/)
  assert.match(write.description, /keep `body` a gist card/)
  // F82 (#191): the tier reaches the surface the writer reads immediately
  // before the call too — a description that still triggered only on a
  // verbatim deliverable would teach the narrower rule at decision time, which
  // is exactly the gap F74 shipped this sentence to close.
  assert.match(write.description, /An attachment is the node's detail tier/)
  assert.match(write.description, /detail beyond the gist — a complete list, a full option enumeration, an exact click or step sequence/)
  assert.match(write.description, /named for what it contains/)
  // F82.1 (#216): the split by kind reaches the schema copy too, and the
  // licence must not creep back in at this site either.
  assert.match(write.description, /split is by kind, not by degree/, 'the split is stated by kind, not by degree')
  assert.match(write.description, /body keeps the retrieval keys/, 'the body keeps the keys')
  assert.match(write.description, /file keeps the bulk/, 'the file keeps the bulk')
  assert.match(write.description, /restating the file's rows in the body buys nothing/i)
  assert.match(write.description, /never trim the detail file down to what the body left out/i)
  assert.doesNotMatch(write.description, /duplicat\w*[^.]{0,80}(expected|not waste|encouraged)/i, 'F82.1 (#216): no duplication licence, in any wording')
  assert.doesNotMatch(write.description, TWIN_WRITE_LICENCE, 'F82.1 (#216): no sentence rewards copying the file into the body')
  assert.doesNotMatch(write.description, /stops being findable/, 'F82.1 (#216): the findability warning that licensed the twin write is gone')
  // F82.1 (#216): memory_attach is the fourth writer-facing site — the rule
  // must not depend on which tool the writer reached for (it had no wording
  // assertion before this).
  const attach = tools.get('memory_attach')
  assert.match(attach.description, /split is by kind, not by degree/, 'the standalone attach route states the split too')
  assert.match(attach.description, /body keeps the retrieval keys/)
  assert.match(attach.description, /file keeps the bulk/)
  assert.match(attach.description, /restating the file's rows in the body buys nothing/i)
  assert.match(attach.description, /Never trim the detail file down to what the body left out/)
  assert.doesNotMatch(attach.description, /duplicat\w*[^.]{0,80}(expected|not waste|encouraged)/i, 'F82.1 (#216): no duplication licence, in any wording')
  assert.doesNotMatch(attach.description, TWIN_WRITE_LICENCE, 'F82.1 (#216): no sentence rewards copying the file into the body')
  assert.doesNotMatch(attach.description, /stops being findable/, 'F82.1 (#216): the findability warning that licensed the twin write is gone')
  // F88.2 (#157): the capture rule must reach every surface the writer reads
  // before it drafts, not only the section text — a payload composed because
  // the tool description alone said "the full detail" is billed in full before
  // the gate refuses it (codex/terra review of 48c090c).
  assert.match(write.description, /Attach the detail this exchange carries/, 'the write description states the capture rule')
  assert.match(write.description, /your own summary or reorganisation of what was said counts/, 'F88.2a: synthesis is permitted here too')
  assert.match(write.description, /an artifact the turn merely NAMES/)
  for (const [where, text] of [
    ['memory_write.attach.content', write.parameters.properties.attach.properties.content.description],
    ['memory_attach.content', attach.parameters.properties.content.description],
  ]) {
    assert.match(text, /the detail this conversation carries, organised and summarised however serves it/, `${where} states the capture rule`)
    assert.match(text, /never a document invented because the turn merely named one/, `${where} names the failure it bars`)
    assert.match(text, /untraceable payload is rejected/, `${where} says the gate will refuse it`)
  }
  // AGENTS.md's habit 4 carries the twin, as it carried F73's shape rule — and
  // now F82's tier, duplication licence, ranking caveat and filename rule.
  const agents = await fsp.readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  const habit = agents.split('\n').find((line) => line.startsWith('4. '))
  assert.match(habit, /A node has two tiers/)
  assert.match(habit, /curated detail tier/)
  assert.match(habit, /detail beyond the gist/)
  // F82.1 (#216): the shell writer's copy states the same split (ADR-0004),
  // keeps the file-protecting clause, and drops the licence.
  assert.match(habit, /split between the tiers is by kind, not by degree/, 'the split is stated by kind, not by degree')
  assert.match(habit, /body keeps the retrieval keys at full weight/, 'the body keeps the keys')
  assert.match(habit, /file keeps the bulk/, 'the file keeps the bulk')
  assert.match(habit, /Restating the file's rows in the body buys nothing/)
  assert.match(habit, /never trim it down to what the body left out/, 'F82.1 (#216): the clause protecting the FILE survives the licence removal')
  assert.doesNotMatch(habit, /duplicat\w*[^.]{0,80}(expected|not waste|encouraged)/i, 'F82.1 (#216): no duplication licence, in any wording')
  assert.doesNotMatch(habit, TWIN_WRITE_LICENCE, 'F82.1 (#216): no sentence rewards copying the file into the body')
  assert.doesNotMatch(habit, /stops being findable/, 'F82.1 (#216): the findability warning that licensed the twin write is gone')
  assert.match(habit, /weighs descriptions and bodies far above attached files/, 'the twin keeps the ranking caveat')
  assert.match(habit, /verbatim deliverable is the sharpest case of this tier, not a separate trigger/)
  assert.match(habit, /Name the file for what it contains/)
  assert.match(habit, /never `attachment\.md`\/`notes\.md`\/`details\.md`/)
  assert.match(habit, /ONE call, `memory_write` with `attach: \{filename, content\}`/)
})

// F45 (#74): the writer read the handoff bullet as "MY unfinished work in
// THIS session" and never applied it to the USER's in-flight work described
// in the conversation — session 420002 carried 12 capturable work items
// (pending reports, empty/truncated worker returns needing re-delivery,
// re-dispatched queries, unanswered questions, a cancelled task); graph v2
// stored 0/12 while the synthetic replay notes' forced tasks[].focus slot got 4. One
// replay answer even declined an empty worker return as "nothing to record"
// — exactly the judgment the section must flip.
test('the section treats in-flight work as a durable fact and demands the close-out (F45, #74)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('in-flight work'))
  assert.ok(bullet, 'a bullet must own the work-state trigger')
  // The trigger vocabulary names the shapes the eval saw the writer drop.
  assert.match(bullet, /still waiting on/, 'a task someone is owed is work state')
  assert.match(bullet, /empty or truncated and needs re-delivery/, 'a failed worker return is work state')
  assert.match(bullet, /re-dispatched query/)
  assert.match(bullet, /question left unanswered/)
  assert.match(bullet, /cancelled/)
  // The empty-return flip must be explicit — s16 declined exactly this.
  assert.match(bullet, /IS work state, never "nothing to record"/)
  // State shape and type routing: thread for ongoing state, handoff pinned.
  assert.match(bullet, /pending \/ blocked-on \/ next-step \/ owed/)
  assert.match(bullet, /`type: thread`/)
  assert.match(bullet, /reserve `handoff` for what the next session must pick up/)
  // Closing discipline reuses the existing revise mechanics — the graph must
  // never keep asserting open work after the conversation shows delivery.
  assert.match(bullet, /never asserts stale open work/)
  // The handoff state shape itself now carries what the user is owed.
  const handoff = renderSection({ sections, variables }).split('\n').find((line) => line.includes('`type: handoff`'))
  assert.ok(handoff, 'the handoff bullet is still present')
  assert.match(handoff, /what the user is still owed/)
})

// F55 (#91): replay v3's long-lived pending-retrieval ledger named ZERO of the
// six worker ids its source segments carried, the graph kept 2 of the 5+
// artifact ids the competing synthetic replay notes kept, and one delivered report lost its
// artifact id entirely. Ids are what make work state resumable and what index
// search is best at — and they are the first thing a from-the-gist rewrite
// discards, because an opaque string has no gist.
test('the section keeps identifiers in the node, verbatim and untrimmed (F55, #91)', async () => {
  const { ctx, sections, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  await settle()
  const lines = renderSection({ sections, variables }).split('\n')
  const bullet = lines.find((line) => line.includes('Identifiers are content'))
  assert.ok(bullet, 'a bullet must own the provenance rule')
  // The id kinds the replay dropped, each named so none reads as an exception.
  assert.match(bullet, /artifact id for a delivered report/)
  assert.match(bullet, /file or recording id/)
  assert.match(bullet, /task or ticket number/)
  assert.match(bullet, /deliverable's own filename/)
  // Ids are content: body verbatim, description when it is the handle.
  assert.match(bullet, /copy it into the `body` exactly as it appeared/)
  assert.match(bullet, /into the `description` when it is the natural handle/)
  // The do-not-store side — an id is exempt from "too much detail" trimming.
  assert.match(bullet, /never the "too much detail" you trim/)
  assert.match(bullet, /shortest possible form of the fact it names/)
  // F50's rule, restated where it bites: copy exactly, never reconstruct.
  assert.match(bullet, /never something to reconstruct from memory/)
  // The retrieval alias 410001 lost: "Common" was never in the PikaKYC node.
  assert.match(bullet, /Common工序拆分/, "the user's own alias is stored beside the canonical name")
  // The bullet sits with the write-time conventions, not after the read tools.
  assert.ok(lines.indexOf(bullet) < lines.findIndex((line) => line.includes('`memory_read` opens one node')),
    'the provenance rule belongs among the write conventions')
  // Work state's own clause: an id-less pending item is not resumable.
  const workState = lines.find((line) => line.includes('in-flight work'))
  assert.match(workState, /Every pending item carries its identifiers verbatim/)
  assert.match(workState, /worker id is what makes the item RESUMABLE/)
  assert.match(workState, /neither re-polled nor fetched/)
  // The clause POINTS at the rule rather than restating its list — the section
  // is a budget, and the two bullets sit next to each other.
  assert.match(workState, /\(the rule below\)/)
  assert.doesNotMatch(workState, /recording id or filename/, 'the id list lives in one bullet, not two')
  // The tool description carries the twin — a writer that never reads the
  // section still sees ids named as first-class content.
  const write = tools.get('memory_write')
  assert.match(write.description, /Identifiers are first-class content/)
  assert.match(write.description, /goes into `body` VERBATIM/)
  assert.match(write.description, /never trimmed away as detail, never reconstructed/)
  assert.match(write.description, /pending item without its worker id is not resumable/)
  // And memory_attach's `filename` treats the deliverable's name as a handle.
  const filename = tools.get('memory_attach').parameters.properties.filename.description
  assert.match(filename, /Use the deliverable's real name when it has one/)
  assert.match(filename, /beside the artifact id it was delivered under/)
})

test('a composition without the prompt registry still gets its tools', async () => {
  const { ctx, tools, sections } = fakeCtx({ withPrompt: false })
  apply(ctx, { graphRoot: root })
  await settle()
  assert.equal(tools.size, 7)
  assert.equal(sections.length, 0)
})

test('configuration is validated and defaulted, and a bad value fails loud', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, {}), /`graphRoot` is required/)
  assert.throws(() => apply(ctx, { graphRoot: root, searchLimit: 0 }), /searchLimit` must be at least 1/)
  assert.throws(() => apply(ctx, { graphRoot: root, maxIndexEntries: -1 }), /maxIndexEntries` must be a non-negative integer/)
  assert.throws(() => apply(ctx, { graphRoot: root, indexCacheMs: 1.5 }), /indexCacheMs` must be a non-negative integer/)
})

test('rankWeights config reorders the injected index and a bad value fails loud', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-rankweights-'))
  const traversed = await createNode(fresh, { description: 'reached by one traversal' })
  const direct = await createNode(fresh, { description: 'read directly several times' })
  const src = await createNode(fresh, { description: 'traffic source' })
  // One traversal onto `traversed` (dst != owner), three direct reads of `direct`.
  await fsp.mkdir(path.join(fresh, '.access'), { recursive: true })
  await fsp.appendFile(path.join(fresh, '.access', `${src}.log`), `${traversed} 2026-01-01T00:00:00Z\n`)
  for (let i = 1; i <= 3; i++) await fsp.appendFile(path.join(fresh, '.access', `${direct}.log`), `${direct} 2026-01-0${i}T00:00:00Z\n`)

  // recency 0 isolates the traversal-vs-read comparison from same-day created dates.
  const traversalHeavy = fakeCtx()
  apply(traversalHeavy.ctx, { graphRoot: fresh, rankWeights: { traversal: 100, read: 1, recency: 0 } })
  assert.equal(traversalHeavy.variables.get('memory_index')().split('\n')[0].slice(0, 26), traversed, 'a dominant traversal weight ranks the traversed node first')

  const readHeavy = fakeCtx()
  apply(readHeavy.ctx, { graphRoot: fresh, rankWeights: { traversal: 1, read: 100, recency: 0 } })
  assert.equal(readHeavy.variables.get('memory_index')().split('\n')[0].slice(0, 26), direct, 'a dominant read weight ranks the directly-read node first')

  // Bad weights fail loud at load.
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, rankWeights: { read: -1 } }), /`rankWeights.read` must be a non-negative finite number/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, rankWeights: { degree: -1 } }), /`rankWeights.degree` must be a non-negative finite number/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, rankWeights: { traversal: 'x' } }), /`rankWeights.traversal` must be a non-negative finite number/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, rankWeights: [] }), /`rankWeights` must be an object/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the index is populated on the very first assembly, with no warm-up', async () => {
  // Regression: an async-only warm-up lost the race against the first prompt
  // assembly, and a real dsh run reached the model with "(memory index not yet
  // read)" while the graph on disk already held nodes.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-cold-'))
  const seeded = await createNode(fresh, { description: 'already on disk before the plugin mounted' })
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  // Read the variable in the same tick apply() returned in — no await between.
  const index = variables.get('memory_index')()
  // The seeded node is also the graph's one orphan, so the census (F40, #60)
  // follows the index line; the index line itself must lead.
  assert.match(index, new RegExp(`^${seeded} — already on disk before the plugin mounted\n`))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an unreadable graph root degrades to a notice instead of throwing', async () => {
  const blocked = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blocked-'))
  await fsp.writeFile(path.join(blocked, 'not-a-directory'), 'x')
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: path.join(blocked, 'not-a-directory') })
  assert.match(variables.get('memory_index')(), /memory index unavailable|empty/)
  await fsp.rm(blocked, { recursive: true, force: true })
})

test('the tools write, find, and traverse memory end to end', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-e2e-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()

  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'ConfigDeck previews must run before any config change', body: 'cfg preview, demo_ready must be true' }, {})
  assert.equal(first.created, true)
  assert.match(first.id, ULID_RE)

  const second = await write.execute({ description: 'The demo repo ships the sandbox from the sample branch', links: [first.id] }, {})
  assert.deepEqual(second.links, [{ to: first.id, status: 'created' }])

  const found = await tools.get('memory_search').execute({ query: 'configdeck preview' }, {})
  assert.equal(found.total, 1)
  assert.equal(found.matches[0].id, first.id)
  assert.ok(found.matches[0].snippet.length > 0)

  const view = await tools.get('memory_read').execute({ id: second.id }, {})
  assert.deepEqual(view.edges, [{ id: first.id, description: 'ConfigDeck previews must run before any config change' }])

  // Reading through the edge must record the traversal that ranks the graph.
  await tools.get('memory_read').execute({ id: first.id, from: second.id }, {})
  const log = await fsp.readFile(path.join(fresh, '.access', `${second.id}.log`), 'utf8')
  assert.match(log, new RegExp(`^${first.id} `, 'm'))

  // A write invalidates the cached index even inside the cache window.
  assert.match(variables.get('memory_index')(), new RegExp(`^${first.id} — ConfigDeck`, 'm'))

  const updated = await write.execute({ id: first.id, body: 'revised' }, {})
  assert.equal(updated.created, false)
  assert.equal(updated.description, 'ConfigDeck previews must run before any config change')

  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a link id that cannot name a node is rejected before execution, whether malformed or merely missing', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  await settle()
  const write = tools.get('memory_write')
  // #253: shape is not state. An id that cannot name a node is refused by the
  // trusted preparation, so a receipt can prove the handler never ran.
  const malformed = { description: 'a fact with a malformed link', links: ['NOTAVALIDID'] }
  assert.ok(
    trustedPreparationFor(write)(malformed).violations.some((violation) => /`links` must contain only 26-character node ids/.test(violation)),
    'a malformed link id is an argument-shape violation',
  )
  await assert.rejects(() => write.execute(malformed, {}), ToolArgsError)
  // A well-formed id of a node that is simply not there is no longer a
  // per-link `failed` row reported AFTER the node landed — that partial latched
  // the manage fence for the rest of the delegation. It is an audited
  // pre-mutation refusal now: nothing is stored, and the model can fix the id.
  const missing = { description: 'a fact with a bad link', body: 'the fact', links: ['01J00000000000000000000001'] }
  await assert.rejects(() => write.execute(missing, {}), (error) => /cannot link — node does not exist/.test(error.message))
  assert.equal((await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).length, 0, 'nothing was stored')
})

test('creating without a description is rejected at the argument boundary before anything is written', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-no-description-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  // demo-boundary: the rejection now comes from the trusted preparation, so it is
  // provable non-execution (`ToolArgsError`), not a handler-side Error.
  await assert.rejects(
    () => tools.get('memory_write').execute({ body: 'orphan body' }, {}),
    (error) => error instanceof ToolArgsError
      // #263 A2: the rejection names the remedy, not only the requirement.
      && error.violations.some((violation) => /^requires `description` when creating a node .*pass `description` .*or pass `id` to update/.test(violation)),
  )
  assert.deepEqual(await fsp.readdir(fresh), [], 'the handler never ran')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('arguments are validated against the declared schema before execute runs', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  await settle()
  await assert.rejects(() => tools.get('memory_search').execute({}, {}), ToolArgsError)
  await assert.rejects(() => tools.get('memory_search').execute({ query: 5 }, {}), /must be string/)
  await assert.rejects(() => tools.get('memory_read').execute({ id: 'x', bogus: 1 }, {}), /not a declared property/)
  await assert.rejects(() => tools.get('memory_write').execute({ links: 'not-an-array' }, {}), /must be array/)
  await assert.rejects(() => tools.get('memory_write').execute({ links: [7] }, {}), /links\[0\] must be string/)
})

test('the validator enforces the subset the tools actually declare', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer' } },
  }
  assert.deepEqual(validate(schema, { a: 'x' }), [])
  assert.deepEqual(validate(schema, { a: 'z' }), ['arguments.a must be one of ["x","y"]'])
  assert.deepEqual(validate(schema, { n: 1 }), ['arguments.a is required'])
  assert.deepEqual(validate(schema, { a: 'x', n: 1.5 }), ['arguments.n must be integer'])
  assert.deepEqual(validate(schema, []), ['arguments must be object'])
  // #263 A2: an undeclared key names the declared set too, so the retry can
  // be corrected instead of resent; the list is bounded.
  assert.deepEqual(validate(schema, { a: 'x', zzz: 1 }), [
    'arguments.zzz is not a declared property — declared properties: a, n',
  ])
  const wide = { type: 'object', additionalProperties: false, properties: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`p${index}`, { type: 'string' }])) }
  const [bounded] = validate(wide, { bogus: 'x' })
  assert.equal(bounded, `arguments.bogus is not a declared property — declared properties: ${Array.from({ length: 12 }, (_, index) => `p${index}`).join(', ')}, and 3 more`)
  assert.equal(validate({ type: 'object', additionalProperties: false }, { bogus: 1 })[0], 'arguments.bogus is not a declared property', 'an empty schema says nothing useful')
})

// #263 A2: a caller may PUBLISH a narrower schema than the definition validates
// against (the restricted A2A wrapper strips `from_path` from memory_attach).
// The remedy is then restated against the published set — and ONLY the remedy:
// the claim, a nested path, and any other violation come back untouched, so the
// rejection stays the definition's own and keeps its non-execution proof.
test('restateDeclaredPropertiesRemedy edits only a top-level undeclared-property remedy', () => {
  const published = { id: { type: 'string' }, content: { type: 'string' }, filename: { type: 'string' } }
  assert.equal(
    restateDeclaredPropertiesRemedy('arguments.dependencies is not a declared property — declared properties: id, filename, content, from_path', published),
    'arguments.dependencies is not a declared property — declared properties: id, content, filename',
  )
  // No remedy yet (an empty schema on the publishing side): drop to the claim.
  assert.equal(
    restateDeclaredPropertiesRemedy('arguments.dependencies is not a declared property — declared properties: a, b', {}),
    'arguments.dependencies is not a declared property',
  )
  // A NESTED path is never rewritten: only top-level keys are the remedy's subject.
  const nested = 'arguments.attach.dependencies is not a declared property — declared properties: filename, content'
  assert.equal(restateDeclaredPropertiesRemedy(nested, published), nested)
  // Every other violation is returned verbatim.
  for (const other of ['arguments.attach must be object', 'arguments.id is required', 'arguments.content too large']) {
    assert.equal(restateDeclaredPropertiesRemedy(other, published), other)
  }
})

test('renderers turn each result into the text the model reads', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-render-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const stored = await tools.get('memory_write').execute({ description: 'renderable fact', body: 'the detail' }, {})
  const search = tools.get('memory_search')
  assert.match(search.output.render({}, await search.execute({ query: 'renderable' }, {}))[0].text, /1 shown — 1 match every term, 1 match at least one/)
  // A total miss still names the term that missed, so the retry is targeted.
  assert.equal(search.output.render({}, await search.execute({ query: 'zzzz' }, {}))[0].text, 'No memory matched.\nNo rows for: zzzz — reword these, not the terms that worked.')
  const read = tools.get('memory_read')
  const text = read.output.render({}, await read.execute({ id: stored.id }, {}))[0].text
  assert.match(text, /renderable fact/)
  assert.match(text, /the detail/)
  const write = tools.get('memory_write')
  assert.match(write.output.render({}, { id: stored.id, created: true, description: 'x', links: [{ to: 'a', status: 'failed' }] })[0].text, /Unlinked: a/)
  // A presenter must degrade rather than throw on arguments it cannot validate.
  assert.equal(read.presentCall({ nope: 1 }), undefined)
  assert.match(read.presentCall({ id: stored.id }).title, /Read memory/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_attach writes a file the node then advertises in read and search', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const read = tools.get('memory_read')
  const searchTool = tools.get('memory_search')

  const id = (await write.execute({ description: 'export-api thread', body: 'short body' }, {})).id

  // Happy path: content lands in the node dir and the result confirms it.
  const created = await attach.execute({ id, filename: 'thread-transcript.md', content: 'Codename Bluebird; deadline 2026-09-01\nmore detail below\n' }, {})
  assert.deepEqual(created, { id, file: 'thread-transcript.md', bytes: Buffer.byteLength('Codename Bluebird; deadline 2026-09-01\nmore detail below\n'), status: 'created' })
  assert.match(attach.output.render({}, created)[0].text, /^Attached thread-transcript\.md on .+ \(\d+ bytes\)\.$/)

  // Read-back: the file is listed with its size and first-line summary.
  const view = await read.execute({ id }, {})
  assert.deepEqual(view.files, [{ name: 'thread-transcript.md', size: created.bytes, summary: 'Codename Bluebird; deadline 2026-09-01' }])
  const readText = read.output.render({}, view)[0].text
  assert.match(readText, /Files in this node — open one with memory_read_file\(id: "01[0-9A-HJKMNP-TV-Z]{24}", file: "<name>"\):/)
  assert.match(readText, /thread-transcript\.md \(\d+ bytes\) — Codename Bluebird; deadline 2026-09-01/)

  // Search advertises the attachment count on the row.
  const hits = await searchTool.execute({ query: 'export-api thread' }, {})
  assert.deepEqual(hits.matches[0].files, ['thread-transcript.md'])
  assert.match(searchTool.output.render({}, hits)[0].text, /\[1 file\]/)

  // Overwrite is reported.
  const over = await attach.execute({ id, filename: 'thread-transcript.md', content: 'replaced' }, {})
  assert.equal(over.status, 'overwritten')
  assert.match(attach.output.render({}, over)[0].text, /^Overwrote thread-transcript\.md/)

  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the search head names the term that missed; the per-row matched echo is gone (F36, #56; F86, #201)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-matched-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  await createNode(fresh, { description: 'clickhouse transcript store', body: 'columnar' })
  const searchTool = tools.get('memory_search')

  const hits = await searchTool.execute({ query: 'clickhouse pagination resumability' }, {})
  assert.deepEqual(validate(searchTool.output.schema, hits), [])
  assert.deepEqual(hits.matches[0].matched, ['clickhouse'])
  assert.deepEqual(hits.unmatched, ['pagination', 'resumability'])
  const text = searchTool.output.render({}, hits)[0].text
  assert.match(text, /No rows for: pagination, resumability — reword these, not the terms that worked\./)
  // F86 (#201): the per-row `(matched: …)` echo is dropped to halve row size —
  // the `matched` data field stays (asserted above) but never renders.
  assert.doesNotMatch(text, /\(matched: clickhouse\)/)

  // Nothing extra to say when every term found something.
  const clean = await searchTool.execute({ query: 'clickhouse' }, {})
  assert.doesNotMatch(searchTool.output.render({}, clean)[0].text, /No rows for/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F80 (#184): on DEMO-V2, 89 of 104 failed answers made exactly one
// memory_search and 12 made none — one shallow probe decided "not in memory"
// for a 55-node graph. #169's lesson is that an advisory with no actuator is
// ignored, so the reword floor rides the search RESULT, and only the one where
// the model is about to conclude the graph is empty on the subject.
test('the turn\'s first search finding nothing carries the reword floor (F80, #184)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-floor-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  await createNode(fresh, { description: 'swatch picker interaction log', body: 'clicked Add Swatch' })
  const search = tools.get('memory_search')
  const floor = /This was your first search and it found nothing — not yet a memory miss\. Search again with different words/

  // All terms missed on the first probe: the floor rides the result.
  const miss = await search.execute({ query: 'zzznothing' }, {})
  assert.deepEqual(validate(search.output.schema, miss), [])
  assert.equal(miss.first_probe, true)
  assert.match(search.output.render({}, miss)[0].text, floor)

  // The floor is two searches, not unbounded probing — it never fires twice.
  const second = await search.execute({ query: 'zzzalsonothing' }, {})
  assert.equal(second.first_probe, undefined)
  assert.doesNotMatch(search.output.render({}, second)[0].text, floor)

  // A hit-bearing search says nothing: the model has rows to read, and the
  // read-before-answer rule is the section's, not this line's.
  const other = fakeCtx()
  apply(other.ctx, { graphRoot: fresh })
  await settle()
  const searchB = other.tools.get('memory_search')
  const hit = await searchB.execute({ query: 'swatch' }, {})
  assert.equal(hit.first_probe, undefined)
  assert.doesNotMatch(searchB.output.render({}, hit)[0].text, floor)

  // An empty query lists the whole graph, so zero rows there is an empty
  // graph, not a miss to reword around — and listing the index must not spend
  // the Session's one first probe either.
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-floor-empty-'))
  const third = fakeCtx()
  apply(third.ctx, { graphRoot: empty })
  await settle()
  const searchC = third.tools.get('memory_search')
  const all = await searchC.execute({ query: '' }, {})
  assert.equal(all.first_probe, undefined)
  assert.doesNotMatch(searchC.output.render({}, all)[0].text, floor)
  assert.equal((await searchC.execute({ query: 'zzznothing' }, {})).first_probe, true, 'the listing did not consume the first probe')

  // One instance may serve several conversations (ADR-0013): each Session
  // gets its own first probe, exactly as the read gates are scoped.
  const fourth = fakeCtx()
  apply(fourth.ctx, { graphRoot: fresh })
  await settle()
  const searchD = fourth.tools.get('memory_search')
  // The turn ordinal comes off the PUBLIC `agent.session` surface (#175), not
  // the private `agent.phase` F62 reads: `deriveMessages()` at execute time,
  // counting user-source messages the way F79 picks the prompting turn out of
  // the same history. `turns` here is how many user turns this Session has had.
  const exec = (id, turns) => ({
    agent: {
      id,
      session: {
        deriveMessages: () => [
          ...Array.from({ length: turns ?? 1 }, () => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ask' }] })),
          // Tool results are `role: 'user'` too and must not count as turns.
          { role: 'user', source: { kind: 'tool_result' }, content: [{ type: 'text', text: 'result' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        ],
      },
    },
  })
  assert.equal((await searchD.execute({ query: 'zzznothing' }, exec('session-a'))).first_probe, true)
  assert.equal((await searchD.execute({ query: 'zzznothing' }, exec('session-b'))).first_probe, true)
  assert.equal((await searchD.execute({ query: 'zzzmore' }, exec('session-a'))).first_probe, undefined)

  // A new turn re-arms the floor, and it does so from the Session's OWN
  // history — B advancing must not re-arm A mid-turn (codex P2 on #187).
  const fifth = fakeCtx()
  apply(fifth.ctx, { graphRoot: fresh })
  await settle()
  const searchE = fifth.tools.get('memory_search')
  assert.equal((await searchE.execute({ query: 'zzznothing' }, exec('a', 1))).first_probe, true)
  assert.equal((await searchE.execute({ query: 'zzzmore' }, exec('a', 1))).first_probe, undefined)
  assert.equal((await searchE.execute({ query: 'zzznothing' }, exec('b', 7))).first_probe, true, 'each Session counts its own turns')
  assert.equal((await searchE.execute({ query: 'zzzagain' }, exec('a', 1))).first_probe, undefined, 'B advancing does not re-arm A mid-turn')
  assert.equal((await searchE.execute({ query: 'zzzagain' }, exec('a', 2))).first_probe, true, 'A\'s next turn gets its own first probe')

  // Prompt assembly cannot tell which Session it is assembling for, so its
  // turn boundary must NOT touch this counter: a turn-less Session keeps its
  // one first probe (the quiet direction) instead of being re-armed by
  // whichever conversation happened to assemble (codex P2 on #187).
  const sixth = fakeCtx()
  apply(sixth.ctx, { graphRoot: fresh })
  await settle()
  const searchF = sixth.tools.get('memory_search')
  const assembleTurn = (turn) => sixth.variables.get('memory_today')({ agent: { phase: { turn } } })
  assembleTurn(1)
  assert.equal((await searchF.execute({ query: 'zzznothing' }, {})).first_probe, true)
  assert.equal((await searchF.execute({ query: 'zzzmore' }, {})).first_probe, undefined)
  assembleTurn(2)
  assert.equal((await searchF.execute({ query: 'zzzagain' }, {})).first_probe, undefined, 'assembly never re-arms a counter it cannot attribute')

  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(empty, { recursive: true, force: true })
})

test('search results carry the read-before-update marker and the write tool states the requirement (#146)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-readfirst-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  await createNode(fresh, { description: 'seeded fact the model may try to update blind', body: 'detail' })
  const search = tools.get('memory_search')

  // Every search row is an existing node, so the marker rides the result as
  // its one final line — in context at the exact moment the model decides to
  // write.
  const marker = '\nTo update any node above, memory_read it first — updates to nodes not read this session are rejected.'
  const render = async (query) => search.output.render({}, await search.execute({ query }, {}))[0].text
  assert.ok((await render('seeded')).endsWith(marker), 'the marker closes a term-query result')
  // The whole-graph listing is existing nodes too.
  assert.ok((await render('')).endsWith(marker), 'the marker closes the whole-graph listing')
  // No rows, nothing to update, no marker.
  assert.doesNotMatch(await render('zzznothing'), /memory_read it first/)

  // The write tool states the same requirement imperatively, on the tool and
  // on the `id` parameter the model fills when it chooses to update.
  const write = tools.get('memory_write')
  assert.match(write.description, /Updating REQUIRES a memory_read of that node in this same session first/)
  assert.match(write.description, /an update to an unread node is rejected/)
  assert.match(write.parameters.properties.id.description, /memory_read it this session first, or the write is rejected/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a superseded node is marked in the search row and in the injected index (F24, #44)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-superseded-e2e-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const old = (await write.execute({ description: 'pagination design: cursor expiry and count remain open', body: 'offset for now' }, {})).id
  const current = (await write.execute({ description: 'pagination design settled on cursor pagination', body: 'expiry 15m', supersedes: old }, {})).id

  const searchTool = tools.get('memory_search')
  const hits = await searchTool.execute({ query: 'pagination design' }, {})
  assert.deepEqual(validate(searchTool.output.schema, hits), [])
  assert.equal(hits.matches[0].id, current)
  assert.equal(hits.matches[1].superseded_by, current)
  const text = searchTool.output.render({}, hits)[0].text
  assert.match(text, new RegExp(`^${old} — pagination design: cursor expiry and count remain open \\[superseded by ${current}\\]`, 'm'))
  assert.ok(text.indexOf(current) < text.indexOf(old), 'the current decision is listed first')

  // The prompt index — the surface the stale description competed on in every
  // future session — carries the same marker.
  const index = variables.get('memory_index')()
  assert.match(index, new RegExp(`^${old} — .* \\[superseded by ${current}\\]$`, 'm'))
  assert.match(index, new RegExp(`^${current} — pagination design settled on cursor pagination$`, 'm'))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_search finds a fact that lives only in an attachment and says which file to open (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachsearch-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = await createNode(fresh, { description: 'pagination design', body: 'settled on cursor pagination' })
  await tools.get('memory_attach').execute({ id, filename: 'full-discussion.md', content: 'Priya argued for 10000-row pages; the counter was cursor expiry.\n' }, {})

  // A write whose vocabulary appears only inside ANOTHER node's transcript must
  // not surface that node as a duplicate or a link candidate: the advisory scan
  // is description+body only, so a three-row block stays worth reading.
  // "priya" appears ONLY in the attachment above, nowhere in that node's
  // description or body.
  const written = await tools.get('memory_write').execute({ description: 'priya onboarding checklist', body: 'laptop and vpn' }, {})
  assert.deepEqual(written.similar, [])
  assert.ok(!written.link_candidates.some((c) => c.id === id), 'an attachment-only overlap is not a link candidate')

  const hits = await tools.get('memory_search').execute({ query: 'expiry' }, {})
  assert.deepEqual(validate(tools.get('memory_search').output.schema, hits), [])
  assert.deepEqual(hits.matches[0].matched_in, ['full-discussion.md'])
  const text = tools.get('memory_search').output.render({}, hits)[0].text
  assert.match(text, /matched in full-discussion\.md — .*open the file with memory_read_file/)
  // The snippet is the body's first line, which does NOT contain the match —
  // exactly why the row has to name the file instead of inviting a guess.
  assert.match(text, /settled on cursor pagination/)
  // …and QUOTE it (F81, #182): naming the file asked for a second call the
  // measured failure never made, so the matched passage rides the same row.
  // The name is JSON-quoted on both halves, so a name carrying a quote or a
  // newline can never break the row or the call it spells out (codex #182).
  assert.match(text, /"full-discussion\.md" @ byte 0: Priya argued for 10000-row pages; the counter was cursor expiry\./)
  assert.match(text, /memory_read_file\(id: "01[0-9A-HJKMNP-TV-Z]{24}", file: "full-discussion\.md", offset: 0\)/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read_file hands an attachment back, pages it, and logs the read (F22, #42)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-readfile-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = await createNode(fresh, { description: 'pagination design discussion' })
  await tools.get('memory_attach').execute({ id, filename: 'full-discussion.md', content: 'Priya wanted 10000-row pages.\nThe counter-argument was cursor expiry.\n' }, {})
  const readFile = tools.get('memory_read_file')

  const whole = await readFile.execute({ id, file: 'full-discussion.md' }, {})
  assert.equal(whole.id, id)
  assert.match(whole.content, /Priya wanted 10000-row pages\./)
  assert.equal(whole.offset, 0)
  assert.ok(!('next_offset' in whole), 'a file that fits one window reports no continuation')
  const text = readFile.output.render({}, whole)[0].text
  assert.match(text, /full-discussion\.md on .+ \(\d+ bytes\):/)
  assert.match(text, /counter-argument was cursor expiry/)

  // The node view names the tool that opens its files, so the agent never has
  // to guess at the content (the failure this finding is about).
  const view = await tools.get('memory_read').execute({ id }, {})
  assert.match(tools.get('memory_read').output.render({}, view)[0].text, /memory_read_file\(id: "/)

  // Reading a file is a use of the memory, logged like a direct node read.
  const log = await fsp.readFile(path.join(fresh, '.access', `${id}.log`), 'utf8')
  assert.ok(log.split('\n').filter((line) => line.startsWith(id)).length >= 2, 'both the node read and the file read are logged')

  // A window boundary reports where to resume, and the render says so.
  const page = await readFile.execute({ id, file: 'full-discussion.md', offset: 30 }, {})
  assert.equal(page.offset, 30)
  assert.match(page.content, /^The counter-argument/)

  // The real 50k default window: a bigger attachment pages, the render says
  // where to resume with an inclusive byte range, and the result satisfies the
  // declared output schema.
  const big = 'x'.repeat(ATTACH_READ_BYTES + 1234)
  await tools.get('memory_attach').execute({ id, filename: 'transcript.md', content: big }, {})
  const first = await readFile.execute({ id, file: 'transcript.md' }, {})
  assert.equal(first.bytes, ATTACH_READ_BYTES)
  assert.equal(first.next_offset, ATTACH_READ_BYTES)
  assert.deepEqual(validate(readFile.output.schema, first), [])
  assert.match(readFile.output.render({}, first)[0].text, new RegExp(`bytes 0–${ATTACH_READ_BYTES - 1} of ${big.length}`))
  assert.match(readFile.output.render({}, first)[0].text, /\[1234 more bytes — call memory_read_file again with offset: 50000\]/)
  const rest = await readFile.execute({ id, file: 'transcript.md', offset: first.next_offset }, {})
  assert.deepEqual(validate(readFile.output.schema, rest), [])
  assert.equal(first.content + rest.content, big, 'the pages rejoin into the stored file')

  await assert.rejects(() => readFile.execute({ id, file: 'nope.md' }, {}), /no such file on node/)
  await assert.rejects(() => readFile.execute({ id, file: 'node.md' }, {}), /reserved/)
  await assert.rejects(() => readFile.execute({ id, file: 'x.md', offset: -1 }, {}), /offset must be a non-negative integer/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_attach rejects reserved and traversal names and a missing node', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-reject-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = (await tools.get('memory_write').execute({ description: 'reject cases' }, {})).id
  const attach = tools.get('memory_attach')
  await assert.rejects(() => attach.execute({ id, filename: 'node.md', content: 'x' }, {}), /reserved/)
  await assert.rejects(() => attach.execute({ id, filename: '__edges__', content: 'x' }, {}), /reserved/)
  await assert.rejects(() => attach.execute({ id, filename: '../escape', content: 'x' }, {}), /path separators/)
  await assert.rejects(() => attach.execute({ id, filename: '.hidden', content: 'x' }, {}), /start with a dot/)
  await assert.rejects(() => attach.execute({ id: '01J00000000000000000000001', filename: 'ok.md', content: 'x' }, {}), /node does not exist/)
  // The node accreted no stray files from the rejected calls.
  const view = await tools.get('memory_read').execute({ id }, {})
  assert.deepEqual(view.files, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('every declared schema passes the real registry assertion', async (t) => {
  let dshTools
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const entry = path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    await fsp.access(entry)
    dshTools = await import(pathToFileURL(entry).href)
  } catch {
    t.skip('the dsh installation is not reachable from here')
    return
  }
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  await settle()
  for (const definition of tools.values()) {
    dshTools.assertSupportedJsonSchema(definition.parameters)
    dshTools.assertSupportedJsonSchema(definition.output.schema)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('a direct read (no `from`) records a self-access and wires no edge', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-directread-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = (await tools.get('memory_write').execute({ description: 'read me directly' }, {})).id
  await tools.get('memory_read').execute({ id }, {})
  const log = await fsp.readFile(path.join(fresh, '.access', `${id}.log`), 'utf8')
  assert.match(log, new RegExp(`^${id} \\d{4}-\\d{2}-\\d{2}T`, 'm'), 'the direct read logged a self-access line')
  await assert.rejects(fsp.access(path.join(fresh, id, 'accessed.log')), 'nothing was written inside the node dir (F57, #93)')
  await assert.rejects(fsp.readlink(path.join(fresh, id, '__edges__', id)), 'no self-edge was created')
  // a second direct read counts again, so ranking sees repeated use
  await tools.get('memory_read').execute({ id }, {})
  assert.equal((await fsp.readFile(path.join(fresh, '.access', `${id}.log`), 'utf8')).trimEnd().split('\n').length, 2)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an update stamps `updated` and memory_read surfaces it only once set', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-updated-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const id = (await write.execute({ description: 'evolving fact', body: 'v1' }, {})).id
  const before = read.output.render({}, await read.execute({ id }, {}))[0].text
  assert.doesNotMatch(before, /updated:/, 'a never-revised node shows no updated line')
  await write.execute({ id, body: 'v2' }, {})
  const after = read.output.render({}, await read.execute({ id }, {}))[0].text
  assert.match(after, /\nupdated: \d{4}-\d{2}-\d{2}/, 'a revised node shows an updated line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_write stores a `type`, memory_read surfaces it, and an invalid one is rejected', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-type-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const stored = await write.execute({ description: 'user prefers uv for Python', body: 'always uv, never pip', type: 'preference' }, {})
  assert.equal(stored.created, true)
  // the type is written to disk and surfaced by memory_read's render
  assert.match(await fsp.readFile(path.join(fresh, stored.id, 'node.md'), 'utf8'), /^type: preference$/m)
  const view = await read.execute({ id: stored.id }, {})
  assert.equal(view.type, 'preference')
  assert.match(read.output.render({}, view)[0].text, /^type: preference$/m)
  // an update can change the type
  await write.execute({ id: stored.id, type: 'identity' }, {})
  assert.equal((await read.execute({ id: stored.id }, {})).type, 'identity')
  // an empty string clears a misclassified node back to untyped
  await write.execute({ id: stored.id, type: '' }, {})
  assert.equal((await read.execute({ id: stored.id }, {})).type, '')
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, stored.id, 'node.md'), 'utf8'), /^type:/m)
  // an untyped node shows no type line
  const bare = await write.execute({ description: 'a fact with no kind' }, {})
  assert.doesNotMatch(read.output.render({}, await read.execute({ id: bare.id }, {}))[0].text, /^type:/m)
  // an out-of-enum type is rejected loudly, before anything is written
  await assert.rejects(() => write.execute({ description: 'bad', type: 'bogus' }, {}), ToolArgsError)
  await assert.rejects(() => write.execute({ description: 'bad', type: 'bogus' }, {}), /must be one of/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('creating a near-duplicate surfaces it as `similar` but still stores the node', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-similar-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'ClickHouse chosen for transcript storage over Postgres', body: 'analytical joins' }, {})
  const second = await write.execute({ description: 'ClickHouse selected for transcript storage instead of Postgres', body: 'analytical joins' }, {})
  // Advisory, never blocking: the duplicate is still created …
  assert.equal(second.created, true)
  assert.match(second.id, ULID_RE)
  // … and the prior node is flagged as a possible duplicate.
  assert.deepEqual(second.similar.map((m) => m.id), [first.id])
  assert.ok(second.similar[0].score > 0)
  // The render carries the read-first, revise-instead-of-duplicate imperative
  // (F51, #87 adopted the issue's wording over "possible duplicate(s)").
  assert.match(write.output.render({}, second)[0].text, /Similar node exists — read it first \(memory_read\); revise or link instead of duplicating/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a near-duplicate Chinese description fires `similar` naming the existing node (F51, #87)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-similarcjk-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The 410001 D1 shape from the synthetic replay v2: one node revised at s2,
  // then s4 wrote the same fact list again in different phrasing. tokenize()
  // keeps an unpunctuated Han run as one clause token (even glued to latin —
  // "kyc分为l0" is ONE token), so before Han bigrams these two descriptions
  // shared almost no whole tokens and the guard stayed silent.
  const first = await write.execute({
    description: 'NOVA组织架构与风控演练：2+A+B模式，KYC分为L1/L2/L4三层，Morgan 2030-04-15加入，招募5名演练人员',
    body: '组织设计会议纪要',
  }, {})
  // No memory_search happened between the two writes — the guard runs inside
  // memory_write itself, so a writer that skipped search still gets it.
  const second = await write.execute({
    description: 'NOVA采用2+A+B组织架构；KYC等级分层L1/L2/L4；Morgan于2030-04-15加入，需招募5名演练人员',
    body: '同一事实的复述',
  }, {})
  assert.equal(second.created, true, 'advisory, never blocking')
  assert.ok(second.similar.map((m) => m.id).includes(first.id), 'the existing node is named as similar')
  const text = write.output.render({}, second)[0].text
  assert.match(text, /read (it|them) first \(memory_read\); revise or link instead of duplicating/)
  assert.ok(text.includes(first.id), 'the rendered advisory names the node to read')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a distinct-topic Chinese create stays quiet despite shared latin letters (F51, #87)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-distinctcjk-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The known-good distinct pair from 420002: KYC等级 tiers vs the PikaKYC
  // product. "kyc" must not leak out of "pikakyc" — the verdict compares
  // whole tokens, and a latin run is never split.
  const clip = await write.execute({ description: 'PikaKYC产品的集成方案与接入流程', body: '对接排期待定' }, {})
  const tiers = await write.execute({ description: 'KYC等级体系：L1/L2/L4各等级的限额与演练要求', body: '来自风控评审' }, {})
  assert.deepEqual(tiers.similar, [], 'distinct topics do not flag each other')
  assert.ok(!tiers.similar.some((m) => m.id === clip.id))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('one shared two-character word is not a duplicate, a verbatim short description is (F51, #98 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-minevidence-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // One shared bigram (会议) covers both characters of a two-character word,
  // so 会议安排 after 会议纪要 scored 2 of 4 and cleared the half threshold —
  // and "revise THAT node" on a genuinely distinct fact invites a destructive
  // rewrite. The minimum-evidence gate (two distinct shared bigrams or
  // latin-token matches) keeps single-word overlap out of the verdict.
  const minutes = await write.execute({ description: '会议纪要', body: '2025-09-24 例会' }, {})
  const schedule = await write.execute({ description: '会议安排', body: '下周排期' }, {})
  assert.deepEqual(schedule.similar, [], 'one generic shared word is not duplication')
  // A true short duplicate still fires: 统一定价 restated inside 统一定价方案
  // shares three distinct bigrams, clearing the evidence floor.
  const pricing = await write.execute({ description: '统一定价方案', body: '按TPV分档' }, {})
  const restated = await write.execute({ description: '统一定价', body: '同一方案的复述' }, {})
  assert.ok(restated.similar.map((m) => m.id).includes(pricing.id), 'a restated short fact still flags')
  assert.ok(!restated.similar.map((m) => m.id).includes(minutes.id))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an unrelated create yields no `similar` matches', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-unrelated-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  await write.execute({ description: 'Prefer tabs over spaces in Go source files', body: 'gofmt enforces it' }, {})
  const other = await write.execute({ description: 'Staging database credentials rotate every Monday', body: 'ask ops for the new secret' }, {})
  assert.deepEqual(other.similar, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('link_candidates fires only when something clears the relevance floor (F26, #46)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-linkfloor-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The graph the round-4 trace had: one heavyweight decision node whose
  // vocabulary substring-matched almost anything.
  const decision = await write.execute({
    description: 'Reverted to Postgres with Timescale because ClickHouse operational cost exceeded dashboard benefits',
    body: 'the second store was not worth what it cost to run',
  }, {})

  // Three unrelated housekeeping notes. Each used to draw that node as a
  // candidate; none shares a topic word with it.
  for (const note of [
    { description: 'Guest wifi password is hunter2', body: 'rotates every quarter' },
    { description: 'Office locker code 4417', body: 'ground floor, by the lifts' },
    { description: 'TLS certificate rotation date 2026-11-02', body: 'set a reminder a week before' },
  ]) {
    const written = await write.execute(note, {})
    assert.deepEqual(written.link_candidates, [], `"${note.description}" drew a junk candidate`)
    // Nothing to say means the block is absent from the render entirely.
    assert.doesNotMatch(write.output.render({}, written)[0].text, /Related nodes/)
  }

  // A genuinely related write still gets the advisory — the floor filters
  // noise, it does not silence the feature.
  const related = await write.execute({ description: 'Timescale retention policy for dashboard rollups', body: '90 days' }, {})
  assert.deepEqual(related.link_candidates.map((m) => m.id), [decision.id])
  assert.match(write.output.render({}, related)[0].text, /Related nodes/)

  // A description with nothing but stopwords has no topic to match on.
  const vague = await write.execute({ description: 'It is what it was', body: 'and so on' }, {})
  assert.deepEqual(vague.link_candidates, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('shared function words are not a duplicate, and a domain word that looks like one still links (F26, #46)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-topicfloor-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // Shared function words are not the same fact. These two descriptions
  // overlap on five of seven tokens — but every one of them is a stopword, and
  // a duplicate verdict is the one advisory that invites a destructive update.
  await write.execute({ description: 'It has to be in the vault' }, {})
  const auditor = await write.execute({ description: 'It has to be with the auditor' }, {})
  assert.deepEqual(auditor.similar, [], 'stopword overlap alone is not duplication')

  // Words a general stopword list would swallow but a developer's graph means:
  // CAN bus, TypeScript `any`, SQL USE. The shared one still clears the floor.
  const bus = await write.execute({ description: 'CAN bus decoder endianness' }, {})
  const timing = await write.execute({ description: 'CAN arbitration timing on the test rig' }, {})
  assert.ok(timing.link_candidates.map((m) => m.id).includes(bus.id), '"can" is a topic word here, not a stopword')

  // A single CJK character is a word; the latin single-character rule must not
  // discard it.
  const cjk = await write.execute({ description: '数据库 迁移 计划' }, {})
  const cjk2 = await write.execute({ description: '数据库 备份 策略' }, {})
  assert.ok(cjk2.link_candidates.map((m) => m.id).includes(cjk.id), 'a shared CJK token clears the floor')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a bare number is not a topic, but an alphanumeric token still is (F44, #72)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-baredigits-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The pass-4 repro verbatim: tokenize() splits both ISO dates on the hyphen,
  // so the only whole token these two notes share is the year — and F11 puts
  // the current year into nearly every note, so a year must not be a topic.
  const rollup = await write.execute({
    description: 'The nightly rollup job overran its maintenance window on 2026-08-03',
    body: 'took 41 minutes against a 30 minute window',
  }, {})
  const cert = await write.execute({
    description: 'Edge proxy certificate rotates on 2026-12-12',
    body: 'The edge proxy certificate rotation is scheduled for December 12, 2026.',
  }, {})
  assert.deepEqual(cert.link_candidates, [], 'a shared bare year is not relatedness')

  // Accepted cost of the letter rule, on record: two notes about the SAME
  // date no longer relate on the date alone either.
  const sameDay = await write.execute({ description: 'Datacenter failover drill runs on 2026-08-03', body: 'ops calendar' }, {})
  assert.ok(!sameDay.link_candidates.map((m) => m.id).includes(rollup.id), 'a shared full date is spent along with the year')

  // Control: an alphanumeric token has a letter, so it is still a topic —
  // the rule kills numbers, not measurements or service names.
  const budget = await write.execute({ description: 'Ingest queue p95 budget is 300ms', body: 'agreed with the platform team' }, {})
  const alert = await write.execute({ description: 'Pager alert pinned to p95 across the fleet' }, {})
  assert.ok(alert.link_candidates.map((m) => m.id).includes(budget.id), '"p95" clears the floor on its letter')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the description convention’s framing verbs are not a topic (F44, #72)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-framingverbs-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The section illustrates a decision description with "Chose Postgres over
  // DynamoDB because …", and the agent copies the illustration — so the verb
  // opens most decision nodes and names none of them. In pass 4 two unrelated
  // decisions drew each other on that one shared token. Every verb in
  // FRAMING_VERBS is checked, so dropping one from the set fails here.
  for (const verb of ['Chose', 'Picked', 'Decided']) {
    await write.execute({ description: `${verb} Parquet for cold exports because Athena reads it natively`, body: 'lifecycle moves them to Glacier' }, {})
    const limits = await write.execute({ description: `${verb} per-tenant rate limits because one tenant starved the queue`, body: 'enforced at the gateway' }, {})
    assert.deepEqual(limits.link_candidates, [], `the shared framing verb "${verb}" is not relatedness`)
  }

  // `note` is deliberately NOT in the set, though it frames a description the
  // same way: it is also a product name (this repo's own Plaud Note) and half
  // of "release notes", and suppressing a real candidate is the worse failure.
  // `note` is the ONLY token these two share, so adding it to FRAMING_VERBS
  // fails here.
  const noteA = await write.execute({ description: 'Note app export format is markdown', body: 'one file per entry' }, {})
  const noteB = await write.execute({ description: 'Sales team lives inside the note product' }, {})
  assert.ok(noteB.link_candidates.map((m) => m.id).includes(noteA.id), '"note" is a topic here, not framing')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the link floor’s stricter token set never reaches the duplicate verdict (F44, #72)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dupdenominator-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // A duplicate verdict asks whether a candidate carries HALF the new
  // description's tokens, so every token removed from that set shrinks its
  // denominator and makes "update this instead" — the one advisory that
  // invites a destructive rewrite — easier to trigger. Were the floor's
  // stricter set shared with it, "Chose Redis because latency" would reduce to
  // {redis, latency} and a mere storage note would clear half of it.
  const guide = await write.execute({ description: 'Redis deployment guide', body: 'how the cluster is provisioned' }, {})
  const decision = await write.execute({ description: 'Chose Redis because latency', body: 'p99 read path' }, {})
  assert.ok(!decision.similar.map((m) => m.id).includes(guide.id), 'one shared word is not a duplicate')
  assert.ok(decision.link_candidates.map((m) => m.id).includes(guide.id), 'it is still a link candidate')

  // Same shape with a bare number: dropping `2026` from the duplicate side
  // would leave {standup} against a node that carries it.
  const standup = await write.execute({ description: 'Standup notes archive', body: 'kept per quarter' }, {})
  const dated = await write.execute({ description: 'Standup 2026-08-21', body: 'shipped the floor fix' }, {})
  assert.ok(!dated.similar.map((m) => m.id).includes(standup.id), 'a bare year still counts against the duplicate denominator')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a body mentioning an unrelated memory does not flag it as `similar`', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-bodymention-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const prior = await write.execute({ description: 'Postgres transcript storage decision', body: 'relational joins' }, {})
  // The new node's DESCRIPTION shares nothing with the prior one; only its
  // body mentions the prior vocabulary. That must suggest a link, never a
  // duplicate — a duplicate verdict invites a destructive update.
  const vacation = await write.execute({ description: 'Vacation itinerary for Kyoto week', body: 'check Postgres transcript storage runbook before leaving' }, {})
  assert.deepEqual(vacation.similar, [])
  assert.ok(vacation.link_candidates.map((m) => m.id).includes(prior.id), 'the mentioned node is still a link candidate')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a likely duplicate is never also suggested as a link candidate', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dupnotlink-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'ClickHouse chosen for transcript storage over Postgres' }, {})
  const second = await write.execute({ description: 'ClickHouse selected for transcript storage instead of Postgres' }, {})
  assert.deepEqual(second.similar.map((m) => m.id), [first.id])
  assert.ok(!second.link_candidates.map((m) => m.id).includes(first.id), 'update-instead and link-to are contradictory advice')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('`link_candidates` list related nodes but exclude self and already-linked ones', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-candidates-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const a = await write.execute({ description: 'Postgres chosen for transcript storage' }, {})
  const b = await write.execute({ description: 'Postgres connection pool tuning guide' }, {})
  // C relates to both A and B, but is written already linked to A.
  const c = await write.execute({ description: 'Postgres migration plan for transcript storage', links: [a.id] }, {})
  const candidateIds = c.link_candidates.map((m) => m.id)
  assert.ok(candidateIds.includes(b.id), 'the unlinked related node is a candidate')
  assert.ok(!candidateIds.includes(a.id), 'an already-linked node is not re-suggested')
  assert.ok(!candidateIds.includes(c.id), 'the new node never suggests itself')
  assert.ok(candidateIds.length <= 3, 'candidates are capped at three')
  // Still non-blocking: C exists and its declared link landed.
  assert.equal(c.created, true)
  assert.deepEqual(c.links, [{ to: a.id, status: 'created' }])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a description with no searchable tokens flags nothing and still stores', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-notokens-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  await write.execute({ description: 'Postgres chosen for transcript storage', body: 'analytical joins' }, {})
  // Emoji-only description tokenizes to nothing: a zero threshold must not flag
  // the whole graph, and an all-token-less scan must not list arbitrary nodes.
  const emoji = await write.execute({ description: '🚀🚀🚀' }, {})
  assert.equal(emoji.created, true)
  assert.deepEqual(emoji.similar, [])
  assert.deepEqual(emoji.link_candidates, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the update path skips the scan and returns empty advisories', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-updatescan-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  await write.execute({ description: 'ClickHouse chosen for transcript storage over Postgres' }, {})
  const target = await write.execute({ description: 'ClickHouse selected for transcript storage instead of Postgres' }, {})
  const updated = await write.execute({ id: target.id, body: 'revised body' }, {})
  assert.equal(updated.created, false)
  assert.deepEqual(updated.similar, [])
  assert.deepEqual(updated.link_candidates, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an escaped replay of a stored body is a no-op, advisories included (F63, #108)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-escaped-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const target = await write.execute({ description: '导出慢的客户反馈', body: '原话："导出很慢"\n\n- 最卡的是导出这一步' }, {})
  const stored = await fsp.readFile(path.join(fresh, target.id, 'node.md'), 'utf8')
  // The same body sent back escaped: the write must land on identical bytes,
  // and the advisories — which measure what is persisted, not the argument —
  // must stay silent rather than report a shrink or a stale description.
  const replay = await write.execute({ id: target.id, body: '原话："导出很慢"\\n\\n- 最卡的是导出这一步' }, {})
  assert.equal(replay.created, false)
  assert.equal(replay.dropped_body, undefined)
  assert.equal(replay.replaced_body, undefined)
  assert.equal(replay.stale_description, undefined)
  assert.equal(await fsp.readFile(path.join(fresh, target.id, 'node.md'), 'utf8'), stored, 'an escaped replay changes nothing on disk')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a traversal between unconnected nodes wires the edge and logs it', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-wire-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const a = (await write.execute({ description: 'node a' }, {})).id
  const b = (await write.execute({ description: 'node b' }, {})).id
  await tools.get('memory_read').execute({ id: b, from: a }, {})
  const link = path.join(fresh, a, '__edges__', b)
  assert.equal(await fsp.readlink(link), `../../${b}`, 'traversal created the edge')
  // The wired edge is symmetric (F54, #90): the traversal is association
  // evidence for both nodes, so the pair lands in one call.
  assert.equal(await fsp.readlink(path.join(fresh, b, '__edges__', a)), `../../${a}`, 'as one logical edge, both symlinks')
  assert.match(await fsp.readFile(path.join(fresh, '.access', `${a}.log`), 'utf8'), new RegExp(`^${b} `), 'and logged the touch')
  // a bogus `from` must not wire anything or fail the read
  const view = await tools.get('memory_read').execute({ id: b, from: 'Z'.repeat(26) }, {})
  assert.equal(view.id, b)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_search surfaces archived nodes only under the flag, and memory_restore brings one back', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-restore-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const searchTool = tools.get('memory_search')
  const read = tools.get('memory_read')
  const restore = tools.get('memory_restore')

  const gone = await write.execute({ description: 'archived deploy runbook', body: 'the ship steps' }, {})
  // Archive it the way graph-maintain --apply does: mv into .archive/.
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, gone.id), path.join(fresh, '.archive', gone.id))

  // Default search misses it; reading it errors cleanly (restore is the path).
  assert.equal((await searchTool.execute({ query: 'deploy runbook' }, {})).total, 0)
  await assert.rejects(() => read.execute({ id: gone.id }, {}), /does not exist/)

  // include_archived finds and flags it, and the render marks the row.
  const archived = await searchTool.execute({ query: 'deploy runbook', include_archived: true }, {})
  assert.equal(archived.total, 1)
  assert.equal(archived.matches[0].id, gone.id)
  assert.equal(archived.matches[0].archived, true)
  assert.match(searchTool.output.render({}, archived)[0].text, /\[archived\]/)

  // Restore roundtrip: default search finds it again; the render confirms.
  const restored = await restore.execute({ id: gone.id }, {})
  assert.deepEqual(restored, { id: gone.id, restored: true })
  assert.match(restore.output.render({}, restored)[0].text, /Restored/)
  assert.equal((await searchTool.execute({ query: 'deploy runbook' }, {})).total, 1)

  // Restoring an id that is no longer archived errors.
  await assert.rejects(() => restore.execute({ id: gone.id }, {}), /not archived/)
  // A non-ULID id is rejected by the guard before any path forms.
  await assert.rejects(() => restore.execute({ id: '../evil' }, {}), /invalid node id/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('supersede creates the successor, links it to the old node, and banners the old body', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')

  const old = await write.execute({ description: 'Chose Postgres for transcripts', body: 'relational joins for diarization\nteam knows SQL', type: 'decision' }, {})
  const dayOfWrite = today()
  const next = await write.execute({ description: 'Chose ClickHouse for transcripts', body: 'analytical scans win', type: 'decision', supersedes: old.id }, {})

  // The new node was created and its supersede outcome is reported.
  assert.equal(next.created, true)
  assert.match(next.id, ULID_RE)
  assert.deepEqual(next.superseded, { id: old.id, status: 'banner-added', files_moved: 0 })
  assert.match(write.output.render({}, next)[0].text, new RegExp(`Superseded ${old.id} — banner added`))

  // A plain edge new -> old exists.
  assert.equal(await fsp.readlink(path.join(fresh, next.id, '__edges__', old.id)), `../../${old.id}`)

  // The old node carries a dated banner above its intact original body …
  const view = await read.execute({ id: old.id }, {})
  // The day is sampled around the write rather than after it: a run that crosses
  // local midnight mid-test would otherwise fail on correct code.
  const stamp = view.updated
  assert.ok([dayOfWrite, today()].includes(stamp), `stamp ${stamp} is the day the supersede ran`)
  assert.equal(view.body, `Superseded by ${next.id} on ${stamp}.\n\nrelational joins for diarization\nteam knows SQL`)
  // … its `updated:` matches the banner date, and its description is untouched.
  assert.equal(view.description, 'Chose Postgres for transcripts')
  // The superseded node never surfaces as advice — "update this instead" or
  // "link to it" would fight the supersession it is part of.
  assert.ok(!next.similar.some((s) => s.id === old.id), 'superseded node absent from similar')
  assert.ok(!next.link_candidates.some((c) => c.id === old.id), 'superseded node absent from link candidates')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('supersede moves the old node\'s attachments to the successor and the write result says so (F41, #61)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-files-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const attachTool = tools.get('memory_attach')
  const readFile = tools.get('memory_read_file')
  const searchTool = tools.get('memory_search')

  const old = await write.execute({ description: 'export paging decision, first cut' }, {})
  await attachTool.execute({ id: old.id, filename: 'full-discussion.md', content: 'zqxstranded — the dissent lives only in this file' }, {})
  const next = await write.execute({ description: 'export paging decision, revised', supersedes: old.id }, {})
  assert.deepEqual(next.superseded, { id: old.id, status: 'banner-added', files_moved: 1 })
  assert.match(write.output.render({}, next)[0].text, /Superseded .* Its 1 attached file moved to this node\./)

  // The chain the feature exists for: the file is found and read on the LIVE
  // head, not stranded behind the deranked [superseded by …] node.
  const hits = await searchTool.execute({ query: 'zqxstranded' }, {})
  assert.equal(hits.matches[0].id, next.id)
  assert.deepEqual(hits.matches[0].matched_in, ['full-discussion.md'])
  const back = await readFile.execute({ id: next.id, file: 'full-discussion.md' }, {})
  assert.match(back.content, /the dissent lives only in this file/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an in-place rewrite that keeps nothing of the prior body is flagged loudly (F47, #80)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-rewrite-guard-'))
  const { ctx, tools, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The prompt side owns intent: the section forbids delete-by-rewrite.
  assert.match(renderSection({ sections, variables }), /never blank or rewrite a node to delete/)

  // Wholesale repurposing: the new body shares no topic token with the prior.
  const node = await write.execute({ description: 'guest wifi access', body: 'The guest wifi password is cedarloop-88', type: 'trivia' }, {})
  assert.equal(node.replaced_body, undefined, 'the create path never carries the flag')
  const purged = await write.execute({ id: node.id, body: 'Cleared out during a routine sweep.' }, {})
  assert.equal(purged.replaced_body, 'The guest wifi password is cedarloop-88'.length)
  assert.match(write.output.render({}, purged)[0].text, /REPLACED the node's entire prior body \(39 chars/)
  assert.match(write.output.render({}, purged)[0].text, /NEW node with supersedes/)

  // Blanking fires too, and stopword padding cannot dodge the check.
  const gate = await write.execute({ description: 'dock gate code', body: 'gate code 5150 for the loading dock' }, {})
  const blanked = await write.execute({ id: gate.id, body: '' }, {})
  assert.equal(blanked.replaced_body, 'gate code 5150 for the loading dock'.length)
  const pad = await write.execute({ description: 'padded victim', body: 'raft consensus notes' }, {})
  const padded = await write.execute({ id: pad.id, body: 'it was and then there' }, {})
  assert.equal(padded.replaced_body, 'raft consensus notes'.length)

  // A revision that keeps ANY topic token of the prior body stays silent —
  // thread advances and rephrasings must not be nagged (the F8 write-back
  // convention routes through exactly this shape).
  const thread = await write.execute({ description: 'relevance tuning thread', body: 'Open questions: title boost, synonym expansion' }, {})
  const advanced = await write.execute({ id: thread.id, body: 'Title boost settled at 2x; synonym expansion still open.' }, {})
  assert.equal(advanced.replaced_body, undefined)
  // A tokenless prior body is still protected (codex review): an emoji or
  // Hangul body that vanishes wholesale flags via the raw-substring fallback,
  // while a rewrite that keeps the raw text stays silent.
  const emojiNode = await write.execute({ description: 'emoji body host', body: '🚀 🎉' }, {})
  const overwrote = await write.execute({ id: emojiNode.id, body: 'launch retro notes' }, {})
  assert.equal(overwrote.replaced_body, '🚀 🎉'.length)
  const hangul = await write.execute({ description: 'hangul body host', body: '배포는 금요일 오후 금지' }, {})
  const hangulGone = await write.execute({ id: hangul.id, body: 'freeze policy moved' }, {})
  assert.equal(hangulGone.replaced_body, '배포는 금요일 오후 금지'.length)
  const emojiKept = await write.execute({ description: 'emoji keeper', body: '🚀 🎉' }, {})
  const annotated = await write.execute({ id: emojiKept.id, body: 'launch went well 🚀 🎉 keep shipping' }, {})
  assert.equal(annotated.replaced_body, undefined)

  // #98 review follow-up: the kept-check compares Han text in bigram units,
  // so a Chinese paraphrase of the SAME fact no longer reads as "nothing
  // kept" — while a genuine wholesale repurpose still flags.
  const backup = await write.execute({ description: '数据库备份节奏', body: '数据库备份策略:每天凌晨两点执行一次全量备份。' }, {})
  const reworded = await write.execute({ id: backup.id, description: '数据库备份节奏', body: '备份策略调整:全量备份保持每天凌晨执行,另加中午一次增量备份。' }, {})
  assert.equal(reworded.replaced_body, undefined, 'a Chinese paraphrase sharing bigrams is not a wholesale replacement')
  const gateZh = await write.execute({ description: '门禁密码', body: '门禁密码是8899' }, {})
  const purgedZh = await write.execute({ id: gateZh.id, description: '门禁密码', body: '例行清理,内容已移除。' }, {})
  assert.equal(purgedZh.replaced_body, '门禁密码是8899'.length, 'a Chinese repurpose sharing nothing still flags')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F59 (#103): ledger #33's losses went through exactly this call shape —
// memory_write with `id` + `body` — and left nothing to restore from. The
// snapshot is the graph layer's job; end-to-end this asserts the registered
// tool leaves it behind and that the advisory surface it backstops is
// untouched by it.
test('an in-place body rewrite through memory_write leaves the .node.md.prev snapshot; advisories unchanged (F59, #103)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-snapshot-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const node = await write.execute({ description: 'guest wifi access', body: 'The guest wifi password is cedarloop-88' }, {})
  await assert.rejects(fsp.lstat(path.join(fresh, node.id, PREV_NODE_FILE)), 'a create leaves no snapshot')
  const prior = await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')
  const purged = await write.execute({ id: node.id, body: 'Cleared out during a routine sweep.' }, {})
  // The F47 advisory still fires exactly as before — the snapshot backstops
  // it, it never replaces or silences it.
  assert.equal(purged.replaced_body, 'The guest wifi password is cedarloop-88'.length)
  assert.equal(purged.dropped_body, undefined, 'the advisories stay mutually exclusive')
  assert.equal(await fsp.readFile(path.join(fresh, node.id, PREV_NODE_FILE), 'utf8'), prior, 'the destroyed body is recoverable from the snapshot')
  // The node view never advertises the snapshot as an attachment.
  assert.deepEqual((await tools.get('memory_read').execute({ id: node.id }, {})).files, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('concurrent memory_write updates serialize into one complete node.md (F68, #126)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-write-lock-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const node = await write.execute({ description: 'concurrent update target', body: 'initial body' }, {})
  const bodies = [
    'first complete concurrent body\nwith its own second line',
    'second complete concurrent body\nwith a different second line',
  ]
  const settled = await Promise.allSettled(bodies.map((body) => write.execute({ id: node.id, body }, {})))
  assert.ok(settled.some((result) => result.status === 'fulfilled'), 'one complete update lands')
  const raw = await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')
  const parsed = parseNode(raw)
  assert.equal(parsed.description, 'concurrent update target')
  assert.ok(bodies.includes(parsed.body), `unexpected mixed body: ${JSON.stringify(parsed.body)}`)
  assert.match(raw, /^---\ndescription: concurrent update target\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read waits for the same Node lock and proceeds after its writer releases it (F68, #126)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-lock-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = await createNode(fresh, { description: 'locked read target', body: 'complete body' })
  const lockDir = path.join(fresh, '.locks', `${id}.lock`)
  await fsp.mkdir(lockDir, { recursive: true })
  const pending = tools.get('memory_read').execute({ id }, {})
  const early = await Promise.race([
    pending.then(() => 'read'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 75)),
  ])
  await fsp.rmdir(lockDir)
  const view = await pending
  assert.equal(early, 'blocked', 'the read must wait while the writer owns the Node lock')
  assert.equal(view.body, 'complete body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read_file steals and releases a stale Node lock (F68, #126)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-file-stale-lock-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const id = await createNode(fresh, { description: 'stale reader target' })
  await tools.get('memory_attach').execute({ id, filename: 'notes.md', content: 'complete attachment' }, {})
  const lockDir = path.join(fresh, '.locks', `${id}.lock`)
  await fsp.mkdir(lockDir, { recursive: true })
  const stale = new Date(Date.now() - STALE_LOCK_MS - 1_000)
  await fsp.utimes(lockDir, stale, stale)
  const result = await tools.get('memory_read_file').execute({ id, file: 'notes.md' }, {})
  assert.equal(result.content, 'complete attachment')
  await assert.rejects(fsp.access(lockDir), 'the replacement read lock is released')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a lossy shrink fires the dropped-portion advisory; expansions and trims stay silent (F52, #88)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lossy-shrink-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The 420002 s10 shape: a Chinese node rewritten shorter, keeping most of
  // the text but dropping a dated-facts block — under the wholesale F47
  // check (plenty kept), and exactly the miss this advisory exists for.
  const s10Prior = [
    '2030-02-04 与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '2030-02-08 预算结论:参与者名单已sign up,但costing没有sign up,练习额度缺口约240万美金,账目由虚构协调员单独核算,发票样例需逐项复核,结算规则另存表格。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const s10Next = [
    '与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const node = await write.execute({ description: '160-HC演练进展:costing额度未sign up,缺口约240万美金', body: s10Prior, type: 'thread' }, {})
  assert.equal(node.dropped_body, undefined, 'the create path never carries the flag')
  const shrunk = await write.execute({ id: node.id, body: s10Next }, {})
  assert.equal(shrunk.replaced_body, undefined, 'most of the body was kept — not a wholesale replacement')
  assert.equal(shrunk.dropped_body, s10Prior.length - s10Next.length)
  const rendered = write.output.render({}, shrunk)[0].text
  assert.match(rendered, /dropped a ~\d+-char portion/)
  assert.match(rendered, /Restore any dropped fact with memory_write/)
  assert.match(rendered, /supersedes/)
  // The description still asserts the dropped costing fact and no new one was
  // supplied, so the stale-description nudge rides along.
  assert.equal(shrunk.stale_description, '160-HC演练进展:costing额度未sign up,缺口约240万美金')

  // Known-good silents: verified expansions must not be nagged. 430003 s5's
  // 452→939 grow-and-rework, and 420002 s3's 149→944 stub fill.
  const s5Prior = 'KORVAL数据质量问题:用户询问识别错误率的构成,初步判断与NER环节相关,已抽样复核了三个批次的输出,错误主要集中在实体边界与人名混淆,细节待进一步核实,本周内跟进并同步结论。'
  const s5Next = [
    'KORVAL数据质量问题结论:识别错误率为2.75%,构成上主要来自NER与ER环节。',
    '抽样复核三个批次输出的结果:实体边界切分错误占大头,人名混淆次之,另有少量类型标注不一致。',
    '已与算法团队确认修复方案:先修实体边界规则,再补人名消歧词表,预计两周内上线,上线后再抽样验证一次错误率。',
    '同时保留原始抽样记录,便于上线后的对照复核,相关批次编号已登记在案。',
  ].join('\n')
  const grown = await write.execute({ description: 'KORVAL识别错误率结论:2.75%,主要来自NER/ER', body: s5Prior }, {})
  const expanded = await write.execute({ id: grown.id, description: 'KORVAL识别错误率结论:2.75%,主要来自NER/ER', body: s5Next }, {})
  assert.equal(expanded.dropped_body, undefined, 'a rework that GROWS the body is never a lossy shrink')
  const s3Prior = '会议纪要线程:2030-04-12 LAB额度演练,具体内容待检索确认,涉及样例规则与课程安排。'
  const filled = await write.execute({ description: 'LAB额度演练纪要', body: s3Prior }, {})
  const fill = await write.execute({ id: filled.id, description: 'LAB额度演练纪要:分层额度定稿,课程样例按轮次奖励', body: `${s3Prior.replace('具体内容待检索确认,', '')}\n${s5Next}` }, {})
  assert.equal(fill.dropped_body, undefined, 'filling a stub is never a lossy shrink')

  // A tightening trim under the shrink gate stays silent too.
  const trimmed = await write.execute({ id: grown.id, description: 'KORVAL识别错误率结论:2.75%,主要来自NER/ER', body: s5Next.replace('相关批次编号已登记在案。', '') }, {})
  assert.equal(trimmed.dropped_body, undefined, 'losing a few chars is a trim, not a lossy rewrite')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F62 (#107): the loss class no size heuristic can see. 420002 s7 replaced a
// fee schedule in a node it had not read that turn — 1496 → 1456 chars, so F47
// and F52 both stayed silent while the tier numbers and the labor-day rates
// went away. The guard is about PROCESS: did the writer ever look?

/**
 * A second plugin instance over the same graph root. Historical tests use this
 * as a fresh turn because dsh replay runs one process per turn; for F68 each
 * `apply()` is unconditionally a fresh Session with an empty version map.
 */
async function nextTurn(dir, config = {}) {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: dir, ...config })
  await settle()
  return tools
}

test('real dsh agent ids isolate conversations and preserve same-conversation writes (F69, #137)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-agent-id-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const dshExec = (callId, name, sessionId) => ({
    callId,
    name,
    arguments: {},
    agent: { id: sessionId, session: {} },
    signal: new AbortController().signal,
  })
  const node = await write.execute(
    { description: 'F69 dsh agent id gate', body: 'original body' },
    dshExec('call-1', 'memory_write', 'session-a'),
  )

  await read.execute({ id: node.id }, dshExec('call-2', 'memory_read', 'session-a'))
  await assert.rejects(
    () => write.execute(
      { id: node.id, body: 'must not land from session B' },
      dshExec('call-3', 'memory_write', 'session-b'),
    ),
    /has not been read this session/,
  )
  const updated = await write.execute(
    { id: node.id, body: 'informed update from session A' },
    dshExec('call-4', 'memory_write', 'session-a'),
  )
  assert.equal(updated.created, false)
  assert.equal((await read.execute(
    { id: node.id },
    dshExec('call-5', 'memory_read', 'session-a'),
  )).body, 'informed update from session A')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('two conversations through one plugin instance cannot satisfy each other\'s read-before-write gate (F69, #137)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-gate-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const execA = { sessionId: 'conversation-A' }
  const execB = { sessionId: 'conversation-B' }
  const node = await write.execute({ description: 'F69 isolated version gate', body: 'original body' }, execA)

  await read.execute({ id: node.id }, execA)
  await assert.rejects(
    () => write.execute({ id: node.id, body: 'must not land from B' }, execB),
    /has not been read this session/,
  )
  const updated = await write.execute({ id: node.id, body: 'informed update from A' }, execA)
  assert.equal(updated.created, false)
  assert.equal((await read.execute({ id: node.id }, execA)).body, 'informed update from A')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('two conversations through one plugin instance retain independent stale-write versions (F69, #137)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-stale-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const execA = { conversationId: 'conversation-A' }
  const execB = { conversationId: 'conversation-B' }
  const node = await write.execute({ description: 'F69 isolated stale versions', body: 'version zero' }, execA)

  await read.execute({ id: node.id }, execA)
  await read.execute({ id: node.id }, execB)
  await write.execute({ id: node.id, body: 'version from B' }, execB)
  await assert.rejects(
    () => write.execute({ id: node.id, body: 'version from A' }, execA),
    /changed since it was read — a Stale Write/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('blind-rewrite knowledge is isolated per conversation in one plugin instance (F69, #137 × F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-blind-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const execA = { session: { id: 'conversation-A' } }
  const execB = { session: { id: 'conversation-B' } }
  const prior = 'The loading dock gate code is 4417; the spare key is by the side door.'
  const node = await write.execute({ description: 'F69 isolated body knowledge', body: prior }, execA)
  await tools.get('memory_attach').execute({ id: node.id, filename: 'details.md', content: 'attachment-only context' }, execA)

  await read.execute({ id: node.id }, execA)
  // This satisfies B's F68 gate without showing B the node body (the existing
  // memory_read_file/F62 contract), so A's full read must not vouch for B.
  await tools.get('memory_read_file').execute({ id: node.id, file: 'details.md' }, execB)
  const blind = await write.execute({ id: node.id, body: 'Facilities now owns every access detail.' }, execB)
  assert.equal(blind.blind_rewrite, prior.length)

  // A re-reads the competing version for F68 and sees that whole body for F62.
  await read.execute({ id: node.id }, execA)
  const informed = await write.execute({ id: node.id, body: 'Facilities owns access details; ask the duty manager.' }, execA)
  assert.equal(informed.blind_rewrite, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the default singleton execution key is stable and distinct from a real identity (F69, #137)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-default-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const named = { sessionId: 'named-conversation' }

  const defaultNode = await write.execute({ description: 'F69 default-key node', body: 'default body' })
  await read.execute({ id: defaultNode.id }, {})
  await assert.rejects(
    () => write.execute({ id: defaultNode.id, body: 'named must read first' }, named),
    /has not been read this session/,
  )
  assert.equal((await write.execute({ id: defaultNode.id, body: 'default update' })).created, false,
    'omitted and empty exec contexts share the default singleton')

  const namedNode = await write.execute({ description: 'F69 named-key node', body: 'named body' }, named)
  await read.execute({ id: namedNode.id }, named)
  await assert.rejects(
    () => write.execute({ id: namedNode.id, body: 'default must read first' }, {}),
    /has not been read this session/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('sessionKey config overrides identity and undefined results fall through to built-ins (F69, #137)', async () => {
  for (const bad of ['customField', 42, null, {}]) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, sessionKey: bad }), /`sessionKey` must be a function/)
  }

  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-resolver-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, sessionKey: (exec) => exec?.customField })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const customA = { customField: 'custom-A', sessionId: 'shared-built-in' }
  const customB = { customField: 'custom-B', sessionId: 'shared-built-in' }
  const node = await write.execute({ description: 'F69 custom resolver node', body: 'custom body' }, customA)
  await read.execute({ id: node.id }, customA)
  await assert.rejects(
    () => write.execute({ id: node.id, body: 'custom B must read first' }, customB),
    /has not been read this session/,
  )
  assert.equal((await write.execute({ id: node.id, body: 'custom A update' }, customA)).created, false)

  // Both calls leave customField undefined, but they retain their distinct
  // built-in sessionIds instead of collapsing onto one undefined key.
  const fallbackA = { sessionId: 'fallback-A' }
  const fallbackB = { sessionId: 'fallback-B' }
  await read.execute({ id: node.id }, fallbackA)
  await assert.rejects(
    () => write.execute({ id: node.id, body: 'fallback B must read first' }, fallbackB),
    /has not been read this session/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('least-recently-used session eviction forces a re-read (F69, #137)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f69-eviction-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const first = { sessionId: 'session-000' }
  const node = await write.execute({ description: 'F69 eviction target', body: 'original body' }, first)
  await read.execute({ id: node.id }, first)

  // The store holds 100 Sessions. Touching 100 different identities after the
  // first one creates entry 101 and evicts that least-recently-used state.
  for (let i = 1; i <= 100; i++) {
    await read.execute({ id: node.id }, { sessionId: `session-${String(i).padStart(3, '0')}` })
  }
  await assert.rejects(
    () => write.execute({ id: node.id, body: 'must re-read after eviction' }, first),
    (error) => {
      assert.match(error.message, /has not been read this session/)
      assert.doesNotMatch(error.message, /changed since it was read/)
      return true
    },
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_write rejects an update to a node never read this Session (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-unread-'))
  const creator = await nextTurn(fresh)
  const node = await creator.get('memory_write').execute({ description: 'version gate unread case', body: 'original body' }, {})
  const file = path.join(fresh, node.id, 'node.md')
  const before = await fsp.readFile(file)

  // A new plugin instance is a new Session. Its empty map makes this a hard
  // read-first reject, not F62's advisory on a write that already landed.
  const writer = await nextTurn(fresh)
  await assert.rejects(
    () => writer.get('memory_write').execute({ id: node.id, body: 'must not land' }, {}),
    (error) => {
      assert.match(error.message, new RegExp(node.id))
      assert.match(error.message, /has not been read this session/)
      assert.match(error.message, /memory_read it before updating/)
      return true
    },
  )
  assert.deepEqual(await fsp.readFile(file), before, 'a read-first rejection is byte-for-byte a no-op')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a Stale Write rejects, then re-read and retry succeeds (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-stale-'))
  const creator = await nextTurn(fresh)
  const node = await creator.get('memory_write').execute({ description: 'version gate stale case', body: 'version zero' }, {})
  const sessionA = await nextTurn(fresh)
  const sessionB = await nextTurn(fresh)
  await sessionA.get('memory_read').execute({ id: node.id }, {})
  await sessionB.get('memory_read').execute({ id: node.id }, {})
  await sessionB.get('memory_write').execute({ id: node.id, body: 'version from B' }, {})

  await assert.rejects(
    () => sessionA.get('memory_write').execute({ id: node.id, body: 'version from A' }, {}),
    (error) => {
      assert.match(error.message, /changed since it was read — a Stale Write/)
      assert.match(error.message, /memory_read it again to re-read and reconcile/)
      assert.doesNotMatch(error.message, /has not been read this session/)
      return true
    },
  )
  assert.equal((await sessionA.get('memory_read').execute({ id: node.id }, {})).body, 'version from B', 'the re-read observes the competing write')
  const retried = await sessionA.get('memory_write').execute({ id: node.id, body: 'version from A' }, {})
  assert.equal(retried.created, false)
  assert.equal((await sessionA.get('memory_read').execute({ id: node.id }, {})).body, 'version from A')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #145: the reject-retry tax concentrates on hubs — the eval's organic
// collisions all hit one high-degree node both streams kept appending to. A
// Stale Write on a hub therefore carries the way OUT of the loop: an edit
// that ADDS a fact can become a create-with-link, which is gate-exempt and
// cannot collide. Low-degree rejects keep the plain message — there the
// retry is cheap and the diversion would just shard ordinary nodes.
test('a Stale Write on a high-degree hub steers additions to a child node (#145)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-hub-stale-'))
  const creator = await nextTurn(fresh)
  const hub = await creator.get('memory_write').execute({ description: 'business overview hub', body: 'the overview' }, {})
  for (let i = 0; i < 13; i++) await creator.get('memory_write').execute({ description: `hub peer fact number ${i}`, links: [hub.id] }, {})
  const sessionA = await nextTurn(fresh)
  const sessionB = await nextTurn(fresh)
  await sessionA.get('memory_read').execute({ id: hub.id }, {})
  await sessionB.get('memory_read').execute({ id: hub.id }, {})
  await sessionB.get('memory_write').execute({ id: hub.id, body: 'the overview, updated by B' }, {})

  await assert.rejects(
    () => sessionA.get('memory_write').execute({ id: hub.id, body: 'the overview, plus a fact from A' }, {}),
    (error) => {
      // The reconcile instruction stays — revisions of the hub's own content
      // still need it — and the hint rides after it, naming the degree and
      // the exact safe shape.
      assert.match(error.message, /changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying\./)
      assert.match(error.message, /high-traffic hub \(13 edges\)/)
      assert.match(error.message, new RegExp(`NEW node created with links: \\["${hub.id}"\\]`))
      return true
    },
  )
  // Taking the hint needs no re-read of the hub: the create is gate-exempt,
  // lands linked, and never collides with B's write.
  const child = await sessionA.get('memory_write').execute({ description: 'the fact A was adding', links: [hub.id] }, {})
  assert.equal(child.created, true)
  assert.deepEqual(child.links, [{ to: hub.id, status: 'created' }])
  assert.equal((await sessionA.get('memory_read').execute({ id: hub.id }, {})).body, 'the overview, updated by B', 'B\'s write is untouched')

  // A stale reject on an ordinary low-degree node keeps the plain message.
  const plain = await creator.get('memory_write').execute({ description: 'ordinary contended note', body: 'first version' }, {})
  const sessionC = await nextTurn(fresh)
  const sessionD = await nextTurn(fresh)
  await sessionC.get('memory_read').execute({ id: plain.id }, {})
  await sessionD.get('memory_read').execute({ id: plain.id }, {})
  await sessionD.get('memory_write').execute({ id: plain.id, body: 'second version' }, {})
  await assert.rejects(
    () => sessionC.get('memory_write').execute({ id: plain.id, body: 'third version' }, {}),
    (error) => {
      assert.equal(error.message, `memory_write: ${plain.id} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`)
      return true
    },
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read records an unchanged version and the update lands normally (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-read-'))
  const creator = await nextTurn(fresh)
  const node = await creator.get('memory_write').execute({ description: 'version gate ordinary update', body: 'old detail' }, {})
  const writer = await nextTurn(fresh)
  await writer.get('memory_read').execute({ id: node.id }, {})
  const updated = await writer.get('memory_write').execute({ id: node.id, body: 'new detail' }, {})

  assert.deepEqual(validate(writer.get('memory_write').output.schema, updated), [], 'the successful result keeps the existing tool shape')
  assert.equal(updated.created, false)
  assert.equal(updated.blind_rewrite, undefined, 'memory_read still satisfies the independent F62 guard')
  assert.equal(parseNode(await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')).body, 'new detail')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read_file records a version without satisfying the body-read advisory (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-read-file-'))
  const creator = await nextTurn(fresh)
  const prior = 'The gate code is 4417 and the spare key is by the side door.'
  const node = await creator.get('memory_write').execute({ description: 'gate code location', body: prior }, {})
  await creator.get('memory_attach').execute({ id: node.id, filename: 'details.md', content: 'attachment detail' }, {})
  const writer = await nextTurn(fresh)

  // Attachment reads are an explicit F68 version path but remain outside
  // seenBodies, so F62 can still diagnose the body rewrite that now lands.
  await writer.get('memory_read_file').execute({ id: node.id, file: 'details.md' }, {})
  const updated = await writer.get('memory_write').execute({ id: node.id, body: 'Facilities now owns all access details.' }, {})
  assert.equal(updated.blind_rewrite, prior.length)
  assert.equal(parseNode(await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')).body, 'Facilities now owns all access details.')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_search snippets do not satisfy the version gate (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-search-'))
  const creator = await nextTurn(fresh)
  const node = await creator.get('memory_write').execute({ description: 'Frankfurt version-gate search target', body: 'private full body' }, {})
  const writer = await nextTurn(fresh)
  const hits = await writer.get('memory_search').execute({ query: 'Frankfurt version-gate' }, {})
  assert.equal(hits.matches[0].id, node.id)

  // The row exposed only its bounded snippet, never the full body bytes whose
  // hash could vouch for an overwrite.
  await assert.rejects(
    () => writer.get('memory_write').execute({ id: node.id, body: 'search-only rewrite' }, {}),
    /has not been read this session — memory_read it before updating/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('two Sessions racing from one read version land exactly one update (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-race-'))
  const creator = await nextTurn(fresh)
  const node = await creator.get('memory_write').execute({ description: 'version gate race target', body: 'shared starting version' }, {})
  const sessions = [await nextTurn(fresh), await nextTurn(fresh)]
  await Promise.all(sessions.map((tools) => tools.get('memory_read').execute({ id: node.id }, {})))
  const bodies = ['racing update A', 'racing update B']

  // Both calls begin together with the same observed hash. The lock must cover
  // compare and update, so the second entrant sees the first entrant's bytes.
  const settled = await Promise.allSettled(sessions.map((tools, index) => tools.get('memory_write').execute({ id: node.id, body: bodies[index] }, {})))
  const fulfilled = settled.map((result, index) => ({ result, index })).filter(({ result }) => result.status === 'fulfilled')
  const rejected = settled.map((result, index) => ({ result, index })).filter(({ result }) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].result.reason.message, /changed since it was read — a Stale Write/)
  const finalBody = parseNode(await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')).body
  assert.equal(finalBody, bodies[fulfilled[0].index], 'disk contains the fulfilled update')
  assert.notEqual(finalBody, bodies[rejected[0].index], 'the rejected update never lands')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('one Session racing two tool calls from one read version lands exactly one update (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-same-session-race-'))
  const session = await nextTurn(fresh)
  const node = await session.get('memory_write').execute({ description: 'same Session version gate race target', body: 'shared starting version' }, {})
  await session.get('memory_read').execute({ id: node.id }, {})
  const bodies = ['same-Session racing update A', 'same-Session racing update B']

  // One Session can issue two tool calls in parallel after one shared read.
  // Each call must retain that original expectation while waiting for the
  // lock; the first call's map refresh cannot authorize the second overwrite.
  const settled = await Promise.allSettled(bodies.map((body) => session.get('memory_write').execute({ id: node.id, body }, {})))
  const fulfilled = settled.map((result, index) => ({ result, index })).filter(({ result }) => result.status === 'fulfilled')
  const rejected = settled.map((result, index) => ({ result, index })).filter(({ result }) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(
    rejected[0].result.reason.message,
    `memory_write: ${node.id} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`,
  )
  const finalBody = parseNode(await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')).body
  assert.equal(finalBody, bodies[fulfilled[0].index], 'disk contains the fulfilled update')
  assert.notEqual(finalBody, bodies[rejected[0].index], 'the rejected update never lands')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('concurrent supersedes: one banner lands, the loser stale-rejects, every lock releases (F68, #130 × #143)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-lock-'))
  const old = await createNode(fresh, { description: 'decision superseded concurrently', body: 'original rationale stays intact' })
  const sessions = [await nextTurn(fresh), await nextTurn(fresh)]
  // Both Sessions read the same version, so both hold a live expectation —
  // the race is then decided by the gate, not by banner stacking (#143).
  for (const tools of sessions) await tools.get('memory_read').execute({ id: old }, {})

  let signalHeld
  let release
  const held = new Promise((resolve) => { signalHeld = resolve })
  const released = new Promise((resolve) => { release = resolve })
  const blocker = withNodeLocks(fresh, [old], async () => {
    signalHeld()
    await released
  })
  await held
  const writes = sessions.map((tools, index) => tools.get('memory_write').execute({
    description: `concurrent successor ${index + 1}`,
    body: `successor rationale ${index + 1}`,
    supersedes: old,
  }, {}))
  await settle()
  release()
  await blocker
  const settled = await Promise.allSettled(writes)
  const landed = settled.filter((result) => result.status === 'fulfilled')
  const rejected = settled.filter((result) => result.status === 'rejected')
  assert.equal(landed.length, 1, 'exactly one supersede wins the race')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /changed since it was read — a Stale Write/)

  const raw = await fsp.readFile(path.join(fresh, old, 'node.md'), 'utf8')
  const parsed = parseNode(raw)
  assert.equal(parsed.body.split('\n').filter((line) => line.startsWith(`Superseded by ${landed[0].value.id} on `)).length, 1)
  assert.equal(parsed.body.split('\n').filter((line) => line.startsWith('Superseded by ')).length, 1, 'the losing supersede left no banner')
  assert.match(parsed.body, /original rationale stays intact/)
  assert.match(raw, /^---\ndescription: decision superseded concurrently\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n/)
  // The loser's create must have rolled back: only old + winner remain.
  const dirs = (await fsp.readdir(fresh)).filter((name) => !name.startsWith('.') && name !== 'MAP.md')
  assert.deepEqual(dirs.sort(), [old, landed[0].value.id].sort())
  assert.deepEqual(await fsp.readdir(path.join(fresh, '.locks')), [], 'all supersede locks were released')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('concurrent typed_links to different peers preserve both sidecar lines (F68, #130)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-sidecar-lock-'))
  const ids = await Promise.all([
    createNode(fresh, { description: 'sidecar endpoint one' }),
    createNode(fresh, { description: 'sidecar endpoint two' }),
    createNode(fresh, { description: 'sidecar endpoint three' }),
  ])
  const [hub, peerA, peerB] = ids.sort()
  const sessions = [await nextTurn(fresh), await nextTurn(fresh)]
  await Promise.all(sessions.map((tools) => tools.get('memory_read').execute({ id: hub }, {})))

  const sidecar = path.join(fresh, hub, '__edges__', '.edge-types')
  const lockDir = path.join(fresh, '.locks', `${hub}.lock`)
  const realReadFile = fsp.readFile
  const realMkdir = fsp.mkdir
  let sidecarReads = 0
  let releaseFirst
  let signalFirstRead
  let signalUnlockedRead
  let signalContended
  const firstRead = new Promise((resolve) => { signalFirstRead = resolve })
  const releaseRead = new Promise((resolve) => { releaseFirst = resolve })
  const unlockedRead = new Promise((resolve) => { signalUnlockedRead = resolve })
  const contended = new Promise((resolve) => { signalContended = resolve })
  fsp.readFile = async (...args) => {
    if (args[0] === sidecar) {
      sidecarReads++
      if (sidecarReads === 1) {
        signalFirstRead()
        await releaseRead
      } else if (sidecarReads === 2) {
        signalUnlockedRead('unlocked')
      }
    }
    return realReadFile.apply(fsp, args)
  }
  fsp.mkdir = async (...args) => {
    if (args[0] === lockDir) {
      try {
        await fsp.access(lockDir)
        signalContended('locked')
      } catch {
        // This is the first acquisition, not a waiter.
      }
    }
    return realMkdir.apply(fsp, args)
  }

  let writes
  try {
    const first = sessions[0].get('memory_write').execute({ id: hub, typed_links: [{ id: peerA, type: 'relates-to' }] }, {})
    await firstRead
    const second = sessions[1].get('memory_write').execute({ id: hub, typed_links: [{ id: peerB, type: 'relates-to' }] }, {})
    const mode = await Promise.race([contended, unlockedRead])
    releaseFirst()
    writes = await Promise.all([first, second])
    assert.equal(mode, 'locked', 'the second sidecar RMW waits instead of reading the first writer\'s pre-rename state')
  } finally {
    releaseFirst?.()
    fsp.readFile = realReadFile
    fsp.mkdir = realMkdir
  }
  assert.equal(writes.length, 2)
  assert.deepEqual(
    [...(await edgeTypes(fresh, hub)).entries()],
    [[peerA, 'relates-to'], [peerB, 'relates-to']],
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the version gate exposes no model-supplied parameter (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-schema-'))
  const tools = await nextTurn(fresh)
  assert.deepEqual(
    Object.keys(tools.get('memory_write').parameters.properties).sort(),
    ['attach', 'body', 'description', 'id', 'links', 'supersedes', 'type', 'typed_links'],
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('supersede refreshes existing version knowledge without inventing a read (F68, #129)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-version-supersede-'))
  const informed = await nextTurn(fresh)
  const old = await informed.get('memory_write').execute({ description: 'old decision with known version', body: 'first rationale' }, {})
  await informed.get('memory_write').execute({ description: 'new decision replacing known version', body: 'new rationale', supersedes: old.id }, {})

  // This Session already knew old (from creating it), so its own banner write
  // refreshes that entry and does not make the next ordinary update look stale.
  const revised = await informed.get('memory_write').execute({ id: old.id, description: 'old decision retained as superseded history' }, {})
  assert.equal(revised.created, false)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the banner prepend passes the version gate: unread and stale supersedes hard-reject (#143)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-gate-'))
  const creator = await nextTurn(fresh)
  const unseen = await creator.get('memory_write').execute({ description: 'old decision unseen by superseding Session', body: 'other rationale' }, {})

  // Unread: superseding a Node this Session never read is stamping content it
  // never saw current — the same reject as an unread `id` update (#125 story 4).
  const informed = await nextTurn(fresh)
  await assert.rejects(
    () => informed.get('memory_write').execute({ description: 'replacement for unseen decision', body: 'settled elsewhere', supersedes: unseen.id }, {}),
    /has not been read this session — memory_read it before superseding/,
  )
  // The rejected create must have rolled back: no successor node, no banner.
  const dirs = (await fsp.readdir(fresh)).filter((name) => !name.startsWith('.') && name !== 'MAP.md')
  assert.deepEqual(dirs, [unseen.id])
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, unseen.id, 'node.md'), 'utf8'), /Superseded by/)

  // Stale: the Session read it, a competitor revised it, the supersede must
  // reject as a Stale Write so the re-read shows the competing content (#125 story 8).
  await informed.get('memory_read').execute({ id: unseen.id }, {})
  await creator.get('memory_write').execute({ id: unseen.id, body: 'revised by the competing Session' }, {})
  await assert.rejects(
    () => informed.get('memory_write').execute({ description: 'stale replacement', body: 'raced', supersedes: unseen.id }, {}),
    /changed since it was read — a Stale Write/,
  )
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, unseen.id, 'node.md'), 'utf8'), /Superseded by/)

  // Current: after re-reading, the same supersede lands and banners the old node.
  await informed.get('memory_read').execute({ id: unseen.id }, {})
  const next = await informed.get('memory_write').execute({ description: 'reconciled replacement', body: 'reconciled', supersedes: unseen.id }, {})
  assert.equal(next.created, true)
  assert.match(await fsp.readFile(path.join(fresh, unseen.id, 'node.md'), 'utf8'), /Superseded by/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('two supersedes from one read expectation: the first landing must not vouch for the second (#143, codex P1)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-double-'))
  const tools = await nextTurn(fresh)
  const other = await nextTurn(fresh)
  const old = await other.get('memory_write').execute({ description: 'decision superseded twice', body: 'one rationale' }, {})
  await tools.get('memory_read').execute({ id: old.id }, {})

  // Same Session, one read, two supersedes launched together: the first
  // refreshes the shared version map when it lands, and that refresh must not
  // authorize the second — its expectation predates the first's banner.
  const settled = await Promise.allSettled([
    tools.get('memory_write').execute({ description: 'first successor', body: 'a', supersedes: old.id }, {}),
    tools.get('memory_write').execute({ description: 'second successor', body: 'b', supersedes: old.id }, {}),
  ])
  const landed = settled.filter((result) => result.status === 'fulfilled')
  const rejected = settled.filter((result) => result.status === 'rejected')
  assert.equal(landed.length, 1, 'exactly one supersede from the shared expectation lands')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /a Stale Write/)
  const banner = (await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'))
    .split('\n').filter((line) => line.startsWith('Superseded by '))
  assert.equal(banner.length, 1, 'the old node carries exactly one banner')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed_links supersede banners the target and marks it on every discovery surface (#147)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-typed-supersede-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')

  // The run-113709 shape: the successor already exists and claims to replace
  // the old decision; a follow-up write records the relationship as a
  // typed_link instead of the `supersedes` argument. Before #147 the edge
  // landed but the banner and the MAP marker did not, leaving two live,
  // mutually contradictory "latest" decisions.
  const old = await write.execute({ description: '开户排期定在10月中旬', body: '此节点替代旧 Q4 排期目标,作为当前最新决定' }, {})
  await tools.get('memory_attach').execute({ id: old.id, filename: 'schedule-notes.md', content: 'zqxfollows — the detail must follow the live head' }, {})
  const successor = await write.execute({ description: '开户排期改到2027年1月', body: '新排期已确认' }, {})
  const followUp = await write.execute({ id: successor.id, typed_links: [{ id: old.id, type: 'supersedes' }] }, {})
  assert.deepEqual(followUp.links, [{ to: old.id, status: 'created' }])

  // The old node carries the banner above its intact body, dated like the
  // primary path's.
  const view = await read.execute({ id: old.id }, {})
  assert.match(view.body, new RegExp(`^Superseded by ${successor.id} on \\d{4}-\\d{2}-\\d{2}\\.\\n\\n此节点替代旧 Q4 排期目标`))
  // The relationship reads back typed, from the successor's side.
  assert.deepEqual((await read.execute({ id: successor.id }, {})).edges, [{ id: old.id, description: '开户排期定在10月中旬', type: 'supersedes' }])

  // Both discovery surfaces mark exactly one live schedule decision: the
  // search row and the injected index (the plugin's MAP surface) deprecate
  // the old node.
  const hits = await tools.get('memory_search').execute({ query: '开户排期' }, {})
  assert.equal(hits.matches.find((m) => m.id === old.id).superseded_by, successor.id)
  assert.equal(hits.matches.find((m) => m.id === successor.id).superseded_by, undefined)
  assert.match(variables.get('memory_index')(), new RegExp(`^${old.id} — .* \\[superseded by ${successor.id}\\]$`, 'm'))
  // Attachments follow the live head, exactly as the `supersedes:` path moves them.
  assert.equal((await tools.get('memory_search').execute({ query: 'zqxfollows' }, {})).matches[0].id, successor.id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed_links supersede passes the version gate on create: unread and stale hard-reject with no successor (#147)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-typed-supersede-gate-'))
  const creator = await nextTurn(fresh)
  const old = await creator.get('memory_write').execute({ description: 'old decision unseen by typed superseding Session', body: 'other rationale' }, {})

  // Unread: the same reject as the `supersedes:` argument (#143) — and no
  // partial state, because the check runs before the successor is created.
  const informed = await nextTurn(fresh)
  await assert.rejects(
    () => informed.get('memory_write').execute({ description: 'typed replacement', body: 'settled elsewhere', typed_links: [{ id: old.id, type: 'supersedes' }] }, {}),
    /has not been read this session — memory_read it before superseding/,
  )
  const afterUnread = (await fsp.readdir(fresh)).filter((name) => !name.startsWith('.') && name !== 'MAP.md')
  assert.deepEqual(afterUnread, [old.id], 'the rejected create left no successor node')
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), /Superseded by/)

  // Stale: read, then a competitor revises the target — reject, still no
  // successor, no edge, no banner.
  await informed.get('memory_read').execute({ id: old.id }, {})
  await creator.get('memory_write').execute({ id: old.id, body: 'revised by the competing Session' }, {})
  await assert.rejects(
    () => informed.get('memory_write').execute({ description: 'stale typed replacement', body: 'raced', typed_links: [{ id: old.id, type: 'supersedes' }] }, {}),
    /changed since it was read — a Stale Write/,
  )
  const afterStale = (await fsp.readdir(fresh)).filter((name) => !name.startsWith('.') && name !== 'MAP.md')
  assert.deepEqual(afterStale, [old.id])
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), /Superseded by/)

  // Current: after re-reading, the same call lands — successor, edge, banner.
  await informed.get('memory_read').execute({ id: old.id }, {})
  const next = await informed.get('memory_write').execute({ description: 'reconciled typed replacement', body: 'reconciled', typed_links: [{ id: old.id, type: 'supersedes' }] }, {})
  assert.equal(next.created, true)
  assert.deepEqual(next.links, [{ to: old.id, status: 'created' }])
  assert.match(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), new RegExp(`Superseded by ${next.id} on `))
  assert.deepEqual(await fsp.readdir(path.join(fresh, '.locks')), [], 'every gate lock was released')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed_links supersede passes the version gate on update: rejects leave the pre-existing node intact (#147)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-typed-supersede-update-gate-'))
  const creator = await nextTurn(fresh)
  const old = await creator.get('memory_write').execute({ description: 'old decision for the update-path gate', body: 'original rationale' }, {})

  // The informed Session owns the successor (created it, so its own update
  // gate is satisfied) but never read the node it names in typed_links.
  const informed = await nextTurn(fresh)
  const successor = await informed.get('memory_write').execute({ description: 'live successor node', body: 'claims to replace the old decision' }, {})
  await assert.rejects(
    () => informed.get('memory_write').execute({ id: successor.id, typed_links: [{ id: old.id, type: 'supersedes' }] }, {}),
    /has not been read this session — memory_read it before superseding/,
  )
  // No partial state: the target is unbannered, the successor keeps its
  // content and gained no edge — and, unlike a rejected create, it is NOT
  // rolled back: it existed before this call.
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), /Superseded by/)
  const view = await informed.get('memory_read').execute({ id: successor.id }, {})
  assert.equal(view.body, 'claims to replace the old decision')
  assert.deepEqual(view.edges, [])

  // Stale: read it, lose a race to the competing Session, reject again.
  await informed.get('memory_read').execute({ id: old.id }, {})
  await creator.get('memory_write').execute({ id: old.id, body: 'revised by the competing Session' }, {})
  await assert.rejects(
    () => informed.get('memory_write').execute({ id: successor.id, typed_links: [{ id: old.id, type: 'supersedes' }] }, {}),
    /changed since it was read — a Stale Write/,
  )
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), /Superseded by/)
  assert.deepEqual((await informed.get('memory_read').execute({ id: successor.id }, {})).edges, [])

  // Reconciled: re-read, retry, and the invariant lands whole — edge + banner.
  await informed.get('memory_read').execute({ id: old.id }, {})
  const retried = await informed.get('memory_write').execute({ id: successor.id, typed_links: [{ id: old.id, type: 'supersedes' }] }, {})
  assert.deepEqual(retried.links, [{ to: old.id, status: 'created' }])
  assert.match(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), new RegExp(`Superseded by ${successor.id} on `))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('two update+typed-supersede calls from one read expectation land exactly once (#147, codex round 1)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-typed-supersede-race-'))
  const other = await nextTurn(fresh)
  const old = await other.get('memory_write').execute({ description: 'decision raced through typed links', body: 'one rationale' }, {})
  const tools = await nextTurn(fresh)
  const successor = await tools.get('memory_write').execute({ description: 'successor updated twice at once', body: 'base' }, {})
  await tools.get('memory_read').execute({ id: old.id }, {})

  // Same Session, one read each of the successor and the target, two calls
  // launched together, each carrying an `id` update AND a typed supersede.
  // The #147 pre-checks await, so each call's update expectation must have
  // been captured BEFORE them (the #129 discipline): the first landing must
  // not refresh the shared map into vouching for the second.
  const bodies = ['first revision', 'second revision']
  const settled = await Promise.allSettled(bodies.map((text) =>
    tools.get('memory_write').execute({ id: successor.id, body: text, typed_links: [{ id: old.id, type: 'supersedes' }] }, {})))
  const landed = settled.filter((result) => result.status === 'fulfilled')
  const rejected = settled.filter((result) => result.status === 'rejected')
  assert.equal(landed.length, 1, 'exactly one call from the shared expectation lands')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /a Stale Write/)
  // The winner landed whole — update, edge, banner — and the loser left no
  // second banner and no half-applied update: the body on disk is the
  // FULFILLED call's, never the rejected one's (codex, #147 round 2).
  const banners = (await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'))
    .split('\n').filter((line) => line.startsWith(`Superseded by ${successor.id} on `))
  assert.equal(banners.length, 1, 'the old node carries exactly one banner')
  const winner = settled.findIndex((result) => result.status === 'fulfilled')
  assert.equal(parseNode(await fsp.readFile(path.join(fresh, successor.id, 'node.md'), 'utf8')).body, bodies[winner])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an unread replacement hard-rejects while gate-satisfying reads preserve F62 behavior (F68, #129 × F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-rewrite-'))
  // Turn one stores the fee schedule. A create can never be a blind rewrite —
  // there is no prior body to have skipped reading.
  const first = await nextTurn(fresh)
  const schedule = [
    '4-12 演练方案:分层额度,240亿以内千三,超出部分减三成,再往上一档减四成。',
    '练习预算:LAB每人日650美金,DEMO每人日250美金,第一年整体约120-180万。',
    '演练场地只做实报实销,LAB三年合计约540+万美金,模拟订阅额度仍在讨论。',
  ].join('\n')
  const node = await first.get('memory_write').execute({ description: '4-12 课程演练方案:分层额度+练习预算+LAB三年合计', body: schedule, type: 'thread' }, {})
  assert.equal(node.blind_rewrite, undefined, 'a create has no prior body to be blind about')

  // Turn two tries to rewrite it from its recollection of the description
  // line: F68 now blocks this before F62's after-the-fact advisory is needed.
  const second = await nextTurn(fresh)
  const swapped = [
    '4-12 演练方案:整体采用分层额度方式,规模越大额度越低,具体档位按课程约定执行。',
    '练习投入按人日记录,第一年整体演练规模与上次试验同一量级,细节以课程记录为准。',
    '演练场地实报实销,LAB周期三年,模拟订阅额度仍在课程讨论过程中,尚未最终确认定档。',
  ].join('\n')
  assert.ok(Math.abs(swapped.length - schedule.length) <= 4, 'the swap is near-identical in length, like the replay it comes from')
  await assert.rejects(
    () => second.get('memory_write').execute({ id: node.id, description: '4-12 课程演练方案:分层额度+练习预算+LAB三年合计', body: swapped }, {}),
    new RegExp(`memory_write: ${node.id} has not been read this session — memory_read it before updating`),
  )
  assert.equal((await second.get('memory_read').execute({ id: node.id }, {})).body, schedule, 'the rejected blind rewrite changes nothing')

  // Turn three reads first — the same replace, now an informed one. The new
  // body keeps NO run of the old one, so only the read can be silencing it.
  const third = await nextTurn(fresh)
  await third.get('memory_read').execute({ id: node.id }, {})
  const informed = await third.get('memory_write').execute({ id: node.id, body: '演练方案最终版:分层额度与练习预算均已确认,模拟订阅按季计,三年合计另行登记。' }, {})
  assert.equal(informed.blind_rewrite, undefined, 'a read this turn is what the guard asks for')
  // And the read has to have SHOWN the body: past the view's truncation point
  // it rendered a prefix, which says nothing about the tail a rewrite destroys.
  const huge = await third.get('memory_write').execute({ description: 'the full onboarding transcript', body: `${'x'.repeat(50001)}\nthe gate code is 4417` }, {})
  const fourth = await nextTurn(fresh)
  const view = fourth.get('memory_read').output.render({}, await fourth.get('memory_read').execute({ id: huge.id }, {}))[0].text
  assert.match(view, /body truncated: \d+ more chars/, 'the view showed a prefix, not the body')
  const afterPrefix = await fourth.get('memory_write').execute({ id: huge.id, body: 'the onboarding transcript, summarized: badge pickup, then the tour.' }, {})
  assert.ok(afterPrefix.blind_rewrite > 50000, 'a truncated read is not a read of the body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('similar surfaces a Node another plugin instance created after this one warmed up (F68, #128)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-live-similar-'))
  const sessionA = await nextTurn(fresh)
  await sessionA.get('memory_search').execute({ query: 'warmup sentinel' }, {})
  const sessionB = await nextTurn(fresh)
  const first = await sessionB.get('memory_write').execute({ description: 'ClickHouse chosen for transcript storage over Postgres', body: 'analytical joins' }, {})

  const second = await sessionA.get('memory_write').execute({ description: 'ClickHouse selected for transcript storage instead of Postgres', body: 'analytical joins' }, {})
  assert.ok(second.similar.map((m) => m.id).includes(first.id))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('link_candidates surfaces a Node another plugin instance created after this one warmed up (F68, #128)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-live-links-'))
  const sessionA = await nextTurn(fresh)
  await sessionA.get('memory_search').execute({ query: 'warmup sentinel' }, {})
  const sessionB = await nextTurn(fresh)
  const decision = await sessionB.get('memory_write').execute({
    description: 'Reverted to Postgres with Timescale because ClickHouse operational cost exceeded dashboard benefits',
    body: 'the second store was not worth what it cost to run',
  }, {})

  const related = await sessionA.get('memory_write').execute({ description: 'Timescale retention policy for dashboard rollups', body: '90 days' }, {})
  assert.ok(related.link_candidates.map((m) => m.id).includes(decision.id))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the blind-rewrite guard stays silent on every write that destroys nothing (F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-silent-'))
  const setup = await nextTurn(fresh)
  const body = 'The Frankfurt ingest cluster drains through the November maintenance window; the replay backlog runs overnight against the same nodes.'
  const node = await setup.get('memory_write').execute({ description: 'Frankfurt ingest cluster drains in the November window', body, type: 'decision' }, {})
  await setup.get('memory_attach').execute({ id: node.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})

  // A description-only or type-only revision leaves the body untouched, and
  // updateNode never rewrites a body it was not given.
  const turn = await nextTurn(fresh)
  const write = turn.get('memory_write')
  await turn.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const described = await write.execute({ id: node.id, description: 'Frankfurt ingest cluster drains in the November maintenance window' }, {})
  assert.equal(described.blind_rewrite, undefined, 'a description-only update replaces no body')
  const retyped = await write.execute({ id: node.id, type: 'journal' }, {})
  assert.equal(retyped.blind_rewrite, undefined, 'a type-only update replaces no body')
  const wired = await write.execute({ id: node.id, links: [] }, {})
  assert.equal(wired.blind_rewrite, undefined, 'a links-only update replaces no body')

  // A body-identical rewrite moved nothing; a verbatim-carrying append proves
  // the writer HAD the prior text, which is what the guard is really asking.
  const identical = await nextTurn(fresh)
  await identical.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const echoed = await identical.get('memory_write').execute({ id: node.id, body }, {})
  assert.equal(echoed.blind_rewrite, undefined, 'rewriting a body to itself destroys nothing')
  const appending = await nextTurn(fresh)
  await appending.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const appended = await appending.get('memory_write').execute({ id: node.id, body: `${body}\n2026-08-25 the window is confirmed for the 14th.` }, {})
  assert.equal(appended.blind_rewrite, undefined, 'a body still carrying the prior one verbatim cannot have been written from recollection')

  // The evidence is anchored at a boundary, not a bare substring (codex review):
  // a two-word prior body must not be "kept" by any replacement that happens to
  // mention those words in passing.
  const terse = await setup.get('memory_write').execute({ description: 'the deploy target', body: 'ship to fra-1' }, {})
  await setup.get('memory_attach').execute({ id: terse.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  const quoting = await nextTurn(fresh)
  await quoting.get('memory_read_file').execute({ id: terse.id, file: 'version-gate.txt' }, {})
  const mentioned = await quoting.get('memory_write').execute({ id: terse.id, body: 'The runbook says to ship to fra-1 only after the canary clears, which changes the on-call rotation.' }, {})
  assert.equal(mentioned.blind_rewrite, 'ship to fra-1'.length, 'a prior body buried mid-sentence is not evidence the writer had it')

  // A stub fill has no facts to lose — placeholder-then-fill is a pattern to
  // encourage, and the empty prior body keeps it silent.
  const stub = await setup.get('memory_write').execute({ description: 'LAB额度演练纪要(待检索)', body: '', type: 'thread' }, {})
  await setup.get('memory_attach').execute({ id: stub.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  const filling = await nextTurn(fresh)
  await filling.get('memory_read_file').execute({ id: stub.id, file: 'version-gate.txt' }, {})
  const filled = await filling.get('memory_write').execute({ id: stub.id, description: 'LAB额度演练纪要:分层额度定稿', body: '分层额度定稿,课程样例按轮次奖励。' }, {})
  assert.equal(filled.blind_rewrite, undefined, 'an empty prior body has nothing to be blind about')

  // Opening an ATTACHMENT is not reading the body: memory_attach exists to move
  // bulk detail OUT of the body, so a file says nothing about what the body
  // still holds. Deliberate — the file read is the moment a writer knows least.
  const attaching = await nextTurn(fresh)
  await attaching.get('memory_attach').execute({ id: node.id, filename: 'window.md', content: 'the full maintenance calendar' }, {})
  const stored = (await setup.get('memory_read').execute({ id: node.id }, {})).body
  const reader = await nextTurn(fresh)
  await reader.get('memory_read_file').execute({ id: node.id, file: 'window.md' }, {})
  const afterFile = await reader.get('memory_write').execute({ id: node.id, body: 'Frankfurt drains sometime in the autumn window.' }, {})
  assert.equal(afterFile.blind_rewrite, stored.length, 'memory_read_file is not a body read')
  // Nor is a search row: it carries a description line, never the body.
  const searcher = await nextTurn(fresh)
  await searcher.get('memory_search').execute({ query: 'Frankfurt ingest cluster' }, {})
  await searcher.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const afterSearch = await searcher.get('memory_write').execute({ id: node.id, body: 'Frankfurt drains at some point before winter.' }, {})
  assert.equal(afterSearch.blind_rewrite, 'Frankfurt drains sometime in the autumn window.'.length, 'a search row is a description, not a body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('what counts as having seen a body: legacy escapes yes, a merge no (F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-seen-'))
  const setup = await nextTurn(fresh)

  // A pre-F63 node stored its body with literal `\n` escapes. Handing that body
  // back exactly as it reads on disk is a writer holding the text — the
  // unescape happens after, and must not turn the proof into a flag.
  const legacy = await setup.get('memory_write').execute({ description: 'the release checklist', body: 'placeholder' }, {})
  const nodeFile = path.join(fresh, legacy.id, 'node.md')
  const escaped = 'tag the release\\nrun the smoke suite\\nannounce in #ship'
  await fsp.writeFile(nodeFile, (await fsp.readFile(nodeFile, 'utf8')).replace('placeholder', escaped))
  await setup.get('memory_attach').execute({ id: legacy.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  const replaying = await nextTurn(fresh)
  await replaying.get('memory_read_file').execute({ id: legacy.id, file: 'version-gate.txt' }, {})
  const replayed = await replaying.get('memory_write').execute({ id: legacy.id, body: escaped }, {})
  assert.equal(replayed.blind_rewrite, undefined, 'the raw argument is evidence too — the writer had the stored text')

  // A merge pours the absorbed node's body into the kept one. Whatever this
  // turn had read of the kept node is no longer its body, so membership drops.
  const turn = await nextTurn(fresh)
  const keep = await setup.get('memory_write').execute({ description: 'the Oslo contract renewal', body: 'Renews each March; 30-day notice.' }, {})
  const absorb = await setup.get('memory_write').execute({ description: 'Oslo contract notice period', body: 'Notice must be faxed, not emailed.' }, {})
  await turn.get('memory_read').execute({ id: keep.id }, {})
  await turn.get('memory_merge').execute({ keep_id: keep.id, absorb_id: absorb.id }, {})
  const afterMerge = await turn.get('memory_write').execute({ id: keep.id, body: 'The Oslo contract renews every March.' }, {})
  assert.ok(afterMerge.blind_rewrite > 0, 'the read predates the merged-in text, so it no longer vouches for the body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the loop turn is the boundary, and a mid-turn reassembly is not (F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-turns-'))
  // `dsh web` calls apply() once and serves many conversations from it, so the
  // guard cannot key on the process. Nor on the render: dsh assembles the
  // system prompt once per STEP (`preStep` inside `turn()`'s step loop), and a
  // read and the write it informs sit in different steps of one turn. The
  // assemble context (`{agent, scope, signal}`) carries the loop, whose
  // `phase.turn` moves once per turn — that is the signal.
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const assemble = (turn) => variables.get('memory_today')({ agent: { phase: { turn } }, scope: {}, signal: undefined })

  // Turn 4, step 1: the model stores a node and reads it back.
  assemble(4)
  const node = await write.execute({ description: 'the loading dock gate code', body: 'The gate code is 4417; the lockbox by the side door holds the spare.' }, {})
  await tools.get('memory_read').execute({ id: node.id }, {})
  // Turn 4, step 2 — the loop reassembles before the next model call. The turn
  // has not moved, so the read still vouches for the write that follows it.
  assemble(4)
  const informed = await write.execute({ id: node.id, body: 'Gate code 4417. Spare key: lockbox, side door. Facilities rotates it each quarter.' }, {})
  assert.equal(informed.blind_rewrite, undefined, 'a step boundary is not a turn boundary')

  // Turn 5: the same process, a conversation whose model has never been shown
  // this body. The counter moved, so the tracking starts empty.
  assemble(5)
  const blind = await write.execute({ id: node.id, body: 'Access details are handled by facilities; ask them.' }, {})
  assert.equal(blind.blind_rewrite, 'Gate code 4417. Spare key: lockbox, side door. Facilities rotates it each quarter.'.length,
    'the previous turn\'s read does not vouch for this turn\'s rewrite')

  // A runtime that exposes no turn counter falls back to process scope: a
  // missed reset only goes quiet, where a spurious one would accuse a writer
  // that read the node a step ago.
  await tools.get('memory_read').execute({ id: node.id }, {})
  assert.equal(variables.get('memory_today')(), `${today()} (${weekdayName(today())})`, 'the variable still answers without a context')
  variables.get('memory_today')({ agent: {}, scope: {} })
  const unkeyed = await write.execute({ id: node.id, body: 'Facilities owns the gate code now; ask them for it.' }, {})
  assert.equal(unkeyed.blind_rewrite, undefined, 'no counter, no reset — the read still stands')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a merge that never happened does not un-read the node (F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-merge-fail-'))
  const turn = await nextTurn(fresh)
  const write = turn.get('memory_write')
  const keep = await write.execute({ description: 'the Oslo contract renewal', body: 'Renews each March; 30 days notice, faxed.' }, {})
  const other = await nextTurn(fresh)
  await other.get('memory_read').execute({ id: keep.id }, {})
  // mergeNodes validates before it mutates, so a rejected merge leaves the body
  // exactly as the read showed it — membership must survive the rejection.
  await assert.rejects(() => other.get('memory_merge').execute({ keep_id: keep.id, absorb_id: '01J00000000000000000000001' }, {}), /does not exist/)
  const revised = await other.get('memory_write').execute({ id: keep.id, body: 'Renews every March. Notice period: 30 days, by fax.' }, {})
  assert.equal(revised.blind_rewrite, undefined, 'a merge that threw changed no body, so the read still stands')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a blind rewrite that is also lossy fires both advisories (F62, #107 × F52, #88)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-blind-lossy-'))
  // 420002 s13: an unprompted −40% compression of a node the turn's segment
  // never mentioned. Two separate things went wrong — nobody looked, and facts
  // were dropped — so both advisories speak; neither suppresses the other.
  const setup = await nextTurn(fresh)
  const prior = [
    '2030-02-04 与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '2030-02-08 预算结论:参与者名单已sign up,但costing没有sign up,练习额度缺口约240万美金,账目由虚构协调员单独核算,发票样例需逐项复核,结算规则另存表格。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const next = [
    '与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const node = await setup.get('memory_write').execute({ description: '160-HC演练进展:costing额度未sign up,缺口约240万美金', body: prior, type: 'thread' }, {})
  await setup.get('memory_attach').execute({ id: node.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  const turn = await nextTurn(fresh)
  await turn.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const shrunk = await turn.get('memory_write').execute({ id: node.id, body: next }, {})
  assert.equal(shrunk.blind_rewrite, prior.length, 'the process advisory fires on its own terms')
  assert.equal(shrunk.dropped_body, prior.length - next.length, 'the content advisory is untouched by it')
  assert.equal(shrunk.stale_description, '160-HC演练进展:costing额度未sign up,缺口约240万美金')
  // The render puts the process first: it explains how the other two happened.
  const rendered = turn.get('memory_write').output.render({}, shrunk)[0].text
  assert.ok(rendered.indexOf('have not read this turn') < rendered.indexOf('dropped a ~'))
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F55 (#91): the loss that costs the most per character. Every other guard
// measures a body in aggregate; none of them can see a revision that keeps the
// prose and drops the ids. Replay v3: a pending-retrieval ledger named zero of
// the six worker ids its segments carried, and 2 of 5+ artifact ids survived.

test('a revision that drops every identifier draws the provenance advisory (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dropped-ids-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The ledger shape: worker ids beside pending items, artifact ids beside the
  // reports already delivered.
  const ledger = [
    '- W41周报 已交付,artifact_id=300417582904613376,文件名 物流业务与仓储会议纪要报告-2025W41.md',
    '- W42周报 已交付,artifact_id=300419226633409280',
    '- NFC场次 录音 file_id=c7a910eb 待复核',
    '- 按摩场次 录音 file_id=4e8b17c3 待复核',
  ].join('\n')
  const node = await write.execute({ description: '周报交付与录音复核清单', body: ledger, type: 'thread' }, {})
  assert.equal(node.dropped_ids, undefined, 'a create has no prior body to lose ids from')

  // The rewrite reads as a faithful tidy-up — and every retrieval key is gone.
  const tidied = [
    '- W41周报已交付,文件已归档。',
    '- W42周报已交付。',
    '- NFC场次与按摩场次的录音仍待复核,已通知负责人。',
  ].join('\n')
  const lost = await write.execute({ id: node.id, body: tidied }, {})
  assert.deepEqual(lost.dropped_ids, ['300417582904613376', '300419226633409280', 'c7a910eb', '4e8b17c3'],
    'the ids are reported verbatim, in the order the prior body carried them')
  const rendered = write.output.render({}, lost)[0].text
  // "including" and not a bare list: the payload is capped, so the render must
  // not assert a complete manifest.
  assert.match(rendered, /dropped every identifier the prior body carried, including /)
  assert.match(rendered, /300417582904613376, 300419226633409280, c7a910eb, 4e8b17c3/)
  assert.match(rendered, /dropped every identifier the prior body carried, including .+\. Put them back with memory_write passing this id/)
  assert.match(rendered, /Put them back with memory_write passing this id/)
  // Advisory only, always: the write landed exactly as asked.
  assert.equal((await tools.get('memory_read').execute({ id: node.id }, {})).body, tidied)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the provenance advisory stays silent unless ALL the ids went (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-kept-ids-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // A body with no ids at all can lose none.
  const plain = await write.execute({ description: 'the ingest path dropped Redis over latency spikes', body: 'Tail latency at p99 was the deciding factor.' }, {})
  const reworded = await write.execute({ id: plain.id, body: 'The p99 tail latency was what decided it, and nothing else came close.' }, {})
  assert.equal(reworded.dropped_ids, undefined, 'no ids in the prior body, nothing to drop')

  // A partial drop is an accepted miss — a writer that kept one id was looking
  // at the ids, and nagging here would fire on every legitimate node split.
  const two = await write.execute({ description: '两份报告的交付记录', body: 'W41 artifact_id=300417582904613376; W42 artifact_id=300419226633409280' }, {})
  const split = await write.execute({ id: two.id, body: 'W41 已交付,artifact_id=300417582904613376。W42 的记录移到了新节点。' }, {})
  assert.equal(split.dropped_ids, undefined, 'one id kept is not a wholesale loss of provenance')

  // An id that merely MOVED within the body is kept, wherever it now sits.
  const moved = await write.execute({ id: two.id, body: '交付记录:300419226633409280 与 300417582904613376 均已归档。' }, {})
  assert.equal(moved.dropped_ids, undefined, 'position is not provenance — presence is')

  // But retention is TOKEN membership, not substring presence: a key that no
  // longer resolves is not the key. Both ids come back with a digit appended —
  // the corrupted-artifact-id shape the synthetic replay notes evidence names — so both are
  // gone, and the advisory reports the originals it was asked to protect.
  const corrupted = await write.execute({ id: two.id, body: 'W41 artifact_id=3004175829046133769;W42 artifact_id=3004192266334092801' }, {})
  assert.deepEqual(corrupted.dropped_ids, ['300419226633409280', '300417582904613376'],
    'an id surviving only as a substring of a longer run is not that id')

  // Not every long token is an id, and under "all dropped" a single false
  // positive in an id-free body is enough to fire the whole loud paragraph. The
  // corpus is Chinese meeting notes, so the numbers that actually appear there
  // are the ones to keep out: an 8-digit date, a 10-digit budget figure, an
  // 11-digit mobile number, and English that happens to be spellable in hex.
  const noise = await write.execute({
    description: '预算口径与会议日期',
    body: '会议日期 20300417,本次演练目标 9000000 元,示例人Alex手机 00000000000,方案被 defaced 的说法不成立。',
  }, {})
  const rewritten = await write.execute({ id: noise.id, body: '会议已改期,预算口径仍在对齐中。' }, {})
  assert.equal(rewritten.dropped_ids, undefined, 'dates, money, phone numbers and hex-spellable English are not identifiers')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the provenance advisory names at most five dropped ids (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-cap-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The six worker ids replay v3's segments carried and its ledger did not.
  const workers = ['d5b204fa', 'a1b2c3d4', 'c0ffee12', 'b2c3d4e5', 'c3d4e5f6', 'd4e5f6a7']
  const node = await write.execute({
    description: '检索任务分派清单',
    body: workers.map((id, n) => `- 任务${n + 1} worker_id=${id} 结果未返回`).join('\n'),
  }, {})
  const lost = await write.execute({ id: node.id, body: '六个检索任务均已重新分派,结果仍未返回。' }, {})
  assert.equal(lost.dropped_ids.length, 5, 'the advisory is a nudge, not a manifest')
  assert.deepEqual(lost.dropped_ids, workers.slice(0, 5))
  const rendered = write.output.render({}, lost)[0].text
  assert.match(rendered, /d5b204fa, a1b2c3d4, c0ffee12, b2c3d4e5, c3d4e5f6/)
  assert.doesNotMatch(rendered, /d4e5f6a7/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the provenance advisory covers UUIDs, ULIDs and uppercase hex (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-shapes-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // A UUID must survive as ONE token. Split into its groups it would render as
  // "550e8400, 446655440000" — an instruction the writer cannot act on, and the
  // two 4-char middles fall under the plain floor entirely.
  const cited = await write.execute({ description: '录音待复核', body: '录音 id 550e8400-e29b-41d4-a716-446655440000 待复核。' }, {})
  const lost = await write.execute({ id: cited.id, body: '录音已复核完毕。' }, {})
  assert.deepEqual(lost.dropped_ids, ['550e8400-e29b-41d4-a716-446655440000'], 'a UUID is one identifier, not two fragments')
  assert.doesNotMatch(write.output.render({}, lost)[0].text, /550e8400,/)

  // A labelled filename keeps the UUID resolvable, and a kept UUID is silent.
  const labelled = await write.execute({ description: '会议录音文件', body: '文件 recording-550e8400-e29b-41d4-a716-446655440000.wav 已归档。' }, {})
  const kept = await write.execute({ id: labelled.id, body: '文件 recording-550e8400-e29b-41d4-a716-446655440000.wav 已转入长期存储。' }, {})
  assert.equal(kept.dropped_ids, undefined, 'the UUID is still there, so nothing was dropped')

  // The third shape: a body citing another node by its ULID, plus uppercase hex.
  const ulid = (await write.execute({ description: '被引用的节点' }, {})).id
  assert.match(ulid, ULID_RE)
  const cites = await write.execute({ description: '交接说明', body: `延续 ${ulid} 的结论,录音 file_id=D5B204FA。` }, {})
  const dropped = await write.execute({ id: cites.id, body: '延续先前节点的结论,录音已复核。' }, {})
  assert.deepEqual(dropped.dropped_ids, [ulid, 'D5B204FA'], 'a cited node id and an uppercase hex id are both identifiers')

  // Ids glued to Chinese text still tokenize — CJK is a boundary, and CJK
  // bodies are the corpus this feature was built for.
  const glued = await write.execute({ description: '编号与录音', body: '编号300442018876145664号,录音c7a910eb待复核' }, {})
  const smoothed = await write.execute({ id: glued.id, body: '编号与录音均已登记。' }, {})
  assert.deepEqual(smoothed.dropped_ids, ['300442018876145664', 'c7a910eb'])

  // A UUID glued to a latin word is reported neither whole nor in pieces: the
  // core is masked even when its boundaries disqualify it, so the plain scan
  // cannot harvest `446655440000` out of its tail and call that an identifier.
  const run = await write.execute({ description: '拼接文本', body: 'recording550e8400-e29b-41d4-a716-446655440000 是一段无分隔的文本。' }, {})
  const cleared = await write.execute({ id: run.id, body: '该段文本已删除。' }, {})
  assert.equal(cleared.dropped_ids, undefined, 'a glued UUID is not an identifier, and neither is a fragment of one')

  // The ULID shape is the graph's own (Crockford base32, no I/L/O/U), not a
  // hand-rolled 26-char class that would accept ids which cannot exist.
  const impossible = await write.execute({ description: '非法ID', body: '参考 ABCDEFGHIJKLMNO12345678901 的记录。' }, {})
  const dropped2 = await write.execute({ id: impossible.id, body: '参考记录已失效。' }, {})
  assert.equal(dropped2.dropped_ids, undefined, 'I/L/O/U are not Crockford base32 — that string is not a node id')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// A pre-F63 node stored with literal `\n` escapes hands its body back exactly
// as it reads on disk, gluing an id to the escape. The prior body is unescaped
// before tokenizing for the same reason blind_rewrite accepts the raw argument
// as evidence: the repair happens after the read, and must not hide a fact.
test('a legacy escaped body still yields its identifiers (F55, #91 × F63, #108)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-escaped-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // Stored escaped, so on disk the id sits immediately after a literal `\n`.
  const node = await write.execute({ description: '待复核清单', body: '待复核清单:\\n300442018876145664 需要重新拉取' }, {})
  const lost = await write.execute({ id: node.id, body: '清单条目已重新拉取完毕。' }, {})
  assert.deepEqual(lost.dropped_ids, ['300442018876145664'], 'the escape must not swallow the id')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The framework writes ULIDs into bodies itself — supersede banners (ADR-0009)
// and the merge divider (F17). Counting those as provenance would make "all
// dropped" unreachable on exactly the long-history nodes that carry artifact
// ids, and a banner-plus-prose body would fire the advisory naming the
// plugin's own bookkeeping id.
test('framework banners are bookkeeping, not provenance (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-banner-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // A superseded node keeps its banner through any faithful revision.
  const old = await write.execute({ description: 'W41周报交付记录', body: 'W41 已交付,artifact_id=300417582904613376,录音 file_id=c7a910eb。' }, {})
  await write.execute({ description: 'W41周报交付记录(修订)', body: 'W41 修订版已交付。', supersedes: old.id }, {})
  const bannered = await tools.get('memory_read').execute({ id: old.id }, {})
  assert.match(bannered.body, /^Superseded by [0-9A-HJKMNP-TV-Z]{26} on \d{4}-\d{2}-\d{2}\./, 'the banner is on the old body')
  const purged = await write.execute({ id: old.id, body: `${bannered.body.split('\n')[0]}\n\nW41 已交付并归档。` }, {})
  assert.deepEqual(purged.dropped_ids, ['300417582904613376', 'c7a910eb'],
    'the kept banner must not make the real ids look retained')

  // And the other direction: a body that is only a banner plus prose has no
  // provenance of its own to lose.
  const plain = await write.execute({ description: '旧结论', body: '旧的结论,细节从略。' }, {})
  await write.execute({ description: '新结论', body: '新的结论。', supersedes: plain.id }, {})
  const marked = await tools.get('memory_read').execute({ id: plain.id }, {})
  const reworded = await write.execute({ id: plain.id, body: `${marked.body.split('\n')[0]}\n\n结论已作废,不再引用。` }, {})
  assert.equal(reworded.dropped_ids, undefined, "the plugin's own bookkeeping ULID is not an identifier the writer dropped")

  // The merge divider is the same class: `Merged from <ULID> on <date>:` is
  // baked into the KEEPER's body and survives every faithful revision.
  const keep = await write.execute({ description: 'NFC场次复核', body: 'NFC 场次 file_id=c7a910eb 待复核。' }, {})
  const absorb = await write.execute({ description: '按摩场次复核', body: '按摩场次 file_id=4e8b17c3 待复核。' }, {})
  await tools.get('memory_merge').execute({ keep_id: keep.id, absorb_id: absorb.id }, {})
  const merged = await tools.get('memory_read').execute({ id: keep.id }, {})
  assert.match(merged.body, /Merged from [0-9A-HJKMNP-TV-Z]{26} on \d{4}-\d{2}-\d{2}:/, 'the divider is in the keeper body')
  const flattened = await write.execute({ id: keep.id, body: '两场录音均已复核完毕。' }, {})
  assert.deepEqual(flattened.dropped_ids, ['c7a910eb', '4e8b17c3'],
    'the merge divider must not make the real ids look retained')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an over-long run is a payload, not an identifier (F55, #91)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-length-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The result quotes its payload VERBATIM, so an externally written blob must
  // never reach it — the count cap bounds how many ids are named, not how long
  // one is. Real ids here run to ~40 chars; past 64 it is bulk, and F21 owns it.
  const blob = `9f${'a3b7c1d5e9f2'.repeat(20)}`
  assert.ok(blob.length > 200 && /^[0-9a-f]+$/.test(blob), 'the blob is hex-shaped and far past any real id')
  const node = await write.execute({ description: '附件校验值与交付记录', body: `校验值 ${blob},录音 file_id=c7a910eb。` }, {})
  const lost = await write.execute({ id: node.id, body: '校验值与录音记录均已移入附件。' }, {})
  // Only the real id is protected, and the blob never enters the result.
  assert.deepEqual(lost.dropped_ids, ['c7a910eb'])
  const rendered = write.output.render({}, lost)[0].text
  assert.ok(rendered.length < 1000, 'the advisory stays a nudge — the blob cannot inflate the tool result')
  assert.doesNotMatch(rendered, /a3b7c1d5e9f2/)

  // The bound is enforced in the scan pattern, so an over-long run is skipped
  // WHOLE — no 64-char prefix or suffix is harvested out of it. A body whose
  // only id-shaped run is over-long therefore has no provenance to lose.
  const only = await write.execute({ description: '附件校验值', body: `校验值 ${blob}。` }, {})
  const rewritten = await write.execute({ id: only.id, body: '校验值已移入附件。' }, {})
  assert.equal(rewritten.dropped_ids, undefined, 'a blob is not a retrieval key')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F55 × F64: the provenance advisory is journaled with the ids it named', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ids-journal-'))
  const setup = await nextTurn(fresh, { turnId: '410001/step-4' })
  const node = await setup.get('memory_write').execute({
    description: 'W41周报交付记录',
    body: 'W41 周报已交付,artifact_id=300417582904613376,录音 file_id=c7a910eb。',
  }, {})
  await setup.get('memory_attach').execute({ id: node.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  assert.deepEqual(await journalLines(fresh), [], 'the create fired nothing')
  // A later turn tidies the node without reading its body: three things go
  // wrong at once, and each gets its own line, in the render's order.
  const turn = await nextTurn(fresh, { turnId: '410001/step-9' })
  await turn.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const lost = await turn.get('memory_write').execute({ id: node.id, body: 'W41 周报已交付并归档。' }, {})
  // Five now, and the fifth is the same event seen from the other end (F71.1,
  // #167): the rewrite dropped the two ids that sourced 「周报已交付」, so what
  // is left is a bare delivery claim with nothing behind it. The create above
  // stays silent for exactly that reason — it carried the ids.
  assert.deepEqual(advisoryKinds(lost), ['blind_rewrite', 'dropped_body', 'dropped_ids', 'stale_description', 'unsourced_assertions'],
    'the size advisories and the provenance one are orthogonal — each is a separate thing gone wrong')
  const lines = await journalLines(fresh)
  assert.match(lines[2], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=410001/step-9 dropped_ids ${node.id} 300417582904613376 c7a910eb$`))
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F61 (#106): the close-out sweep. F45 made in-flight work durable, and then
// nothing ever revisited it — a delivered result is stored as a NEW node, so
// the graph ends up asserting "answered" and "pending" about the same fact.
// 420002's `ledger-a` still marked three items 结果未返回 while sibling nodes
// recorded their completion; 430003's `ledger-b` read 检索中 for 13 steps after
// `result-a` stored the answer.

/** The 420002 `ledger-a` ledger, in the shape the replay wrote it. */
const PENDING_LEDGER = [
  '其他待办:',
  '- 4/17周报 结果未返回',
  '- Fern会 结果未返回',
  '- 演示团队规模 结果未返回',
  '下一步:重新派发上述三项查询,结果回来后回写本节点。',
].join('\n')

test('storing a result flags the open handoff that still calls it pending (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: '420002/step-14' })
  await settle()
  const write = tools.get('memory_write')
  const ledger = await write.execute({ description: '2030-04-18 交接:三项worker查询结果未返回', body: PENDING_LEDGER, type: 'handoff' }, {})
  assert.equal(ledger.stale_pending, undefined, 'the ledger itself opened the pending items — it did not resolve one')

  // The write the replay actually made at s14: the answer, stored as its own
  // node, with nothing at all said to the handoff that is still waiting for it.
  const stored = await write.execute({ description: 'Fern 内容已存储', body: 'Fern会纪要已存入本节点:2030-04-17 与 Fern 示例团队对齐了演练分组。', type: 'journal' }, {})
  assert.deepEqual(stored.stale_pending, [{ id: ledger.id, line: '- Fern会 结果未返回' }],
    'the advisory names the open ledger and the line that is now a lie')

  // Imperative, and it names the turn the fix belongs in — the same voice as
  // `similar` and `blind_rewrite`, both of which were read past when they were
  // phrased as observations.
  const rendered = write.output.render({}, stored)[0].text
  assert.match(rendered, new RegExp(`This write may resolve a pending item in ${ledger.id} — memory_read it and update or close that item this turn`))
  assert.match(rendered, /A pending list that survives its own resolution is a lie/)
  assert.match(rendered, new RegExp(`\\n {2}${ledger.id} — - Fern会 结果未返回$`))

  // F64: it rides the same journal as every other advisory, so a replay can
  // count the sweeps that fired from the graph root alone.
  const lines = (await journalLines(fresh)).filter((line) => line.includes(' stale_pending '))
  assert.equal(lines.length, 1)
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-14 stale_pending ${stored.id} ${ledger.id} — - Fern会 结果未返回$`))

  // The second of the three stale items, delivered the same way. Its identity
  // survives the letterless filter (F44's rule, #72): "4/17" is not a unit, so
  // the line matches on 周报 — with the shared "17" allowed to corroborate,
  // never to cover.
  const weekly = await write.execute({ description: '4/17周报已提交', body: '演练周报已于2030-04-19提交给课程教练。' }, {})
  assert.deepEqual(weekly.stale_pending, [{ id: ledger.id, line: '- 4/17周报 结果未返回' }])

  // Advisory only, always: the ledger is untouched — closing it is the
  // writer's call, and the graph never rewrites a body behind their back.
  assert.equal((await tools.get('memory_read').execute({ id: ledger.id }, {})).body, PENDING_LEDGER)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the close-out sweep reaches thread nodes, not just handoffs (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-thread-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // 430003's `DEMO01`: a `thread`, not a handoff — work state inside a live
  // session is the same kind of open ledger, and it went stale the same way.
  const ledger = await write.execute({
    description: '430003 演练许可调研清单',
    body: ['6. 星岛训练区RailPay费率:已确认千分之五', '7. 2030年4月KORVAL演示许可分类:检索中', '8. KORVAL演示许可有效期:检索中'].join('\n'),
    type: 'thread',
  }, {})
  const answer = await write.execute({ description: 'KORVAL演示许可分类已确认', body: '2030年4月KORVAL属于B类演练许可,有效期至2032年。' }, {})
  assert.deepEqual(answer.stale_pending, [{ id: ledger.id, line: '7. 2030年4月KORVAL演示许可分类:检索中' }], 'the first matching line, not every one')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a pending item is recognized by list shape and by the state words the section asks for (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-markers-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const ledger = await write.execute({
    description: 'handoff: Frankfurt codec swap',
    // Ordered lists are as common as bulleted ones in these ledgers, and the
    // state shape the section prescribes is hyphenated where a line writes it
    // out: both spellings have to read as pending.
    body: ['3. [ ] Sample benchmark numbers for the codec swap', '- blocked-on: facilities confirming the ingest cluster drain window'].join('\n'),
    type: 'handoff',
  }, {})
  const benchmark = await write.execute({ description: 'Sample benchmark numbers are in', body: 'The codec swap benchmark shows 12% lower p95 on the sample corpus.' }, {})
  assert.deepEqual(benchmark.stale_pending, [{ id: ledger.id, line: '3. [ ] Sample benchmark numbers for the codec swap' }], 'an unchecked box in a numbered list is still an open item')
  const window = await write.execute({ description: 'Facilities confirmed the drain window', body: 'The ingest cluster drain window is 2026-11-14, confirmed by facilities.' }, {})
  assert.deepEqual(window.stale_pending, [{ id: ledger.id, line: '- blocked-on: facilities confirming the ingest cluster drain window' }])
  // The `pending` marker keeps F52's word-boundary rule: "appending" is not it.
  const unrelated = await write.execute({ description: 'CSV appending strategy for the export job', body: 'Append rows in batches of 5000.' }, {})
  assert.equal(unrelated.stale_pending, undefined, 'a substring is not a marker, and an unrelated write matches no item')

  // The other ledger shape: one marked HEADER over a plain list. The bullets
  // carry no marker of their own and are open all the same.
  const headed = await write.execute({ description: 'handoff: vendor review', body: ['Pending items:', '- vendor SOC2 report'].join('\n'), type: 'handoff' }, {})
  const soc2 = await write.execute({ description: 'Vendor SOC2 report received', body: 'The vendor SOC2 report landed 2026-08-25, no exceptions.' }, {})
  assert.deepEqual(soc2.stale_pending, [{ id: headed.id, line: '- vendor SOC2 report' }], 'a list under a pending header is a pending list')
  // The header itself is scaffolding, not an item — "items" is a structural
  // word, and one shared word out of a three-word item is topical adjacency,
  // not delivery.
  const listy = await write.execute({ description: 'Stored the review items from the vendor call', body: 'Three items, all minor.' }, {})
  assert.equal(listy.stale_pending, undefined, 'a header names no item, and one word of three is not a resolution')

  // A ticked box is closed, whatever words trail it — on its own line and
  // under a pending header, where the list shape alone would vouch for it.
  const ticked = await write.execute({
    description: 'handoff: codec rollout',
    body: ['Pending:', '- [x] pending: Oslo latency numbers from the codec rollout'].join('\n'),
    type: 'handoff',
  }, {})
  const oslo = await write.execute({ description: 'Oslo latency numbers from the codec rollout', body: 'Oslo p95 latency dropped 8% after the codec rollout.' }, {})
  assert.ok(!(oslo.stale_pending ?? []).some((m) => m.id === ticked.id), 'a checked item is delivered already')

  // Blanking a body delivers nothing — the unchanged description must not be
  // scored as though this write had just answered something.
  const blanked = await write.execute({ id: soc2.id, body: '' }, {})
  assert.equal(blanked.stale_pending, undefined, 'an emptied body is not a delivered result')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the close-out sweep names the item it best matches, not the first it clears (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-best-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // A ledger's items share their project's vocabulary — "Acme API" alone
  // clears the floor on either line, and naming the first would send the
  // writer to close the wrong item.
  const ledger = await write.execute({
    description: 'handoff: Acme integration',
    body: ['- pending: Acme API pagination design', '- pending: Acme API authentication rollout'].join('\n'),
    type: 'handoff',
  }, {})
  const auth = await write.execute({ description: 'Acme API authentication rollout shipped', body: 'The Acme API authentication rollout went out 2026-08-25; OAuth device flow, no pagination change.' }, {})
  assert.deepEqual(auth.stale_pending, [{ id: ledger.id, line: '- pending: Acme API authentication rollout' }], 'the line the write actually answers')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a shared date is not a shared item (F44, #72) in the close-out sweep (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-dates-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const ledger = await write.execute({
    description: 'handoff 2026-08-24',
    body: ['- pending: send payroll report 2026-08-25', '- pending: 2026-08-25'].join('\n'),
    type: 'handoff',
  }, {})
  // An ISO date splits into three tokens, so before F44's rule reached this
  // matcher an unrelated note dated the same day covered three "units" of the
  // payroll line and cleared both thresholds — closing the wrong item.
  const gym = await write.execute({ description: 'gym reminder 2026-08-25', body: 'The user asked to be reminded about the gym on 2026-08-25.' }, {})
  assert.equal(gym.stale_pending, undefined, 'a date identifies nothing, so a shared date resolves nothing')
  const standup = await write.execute({ description: '2026-08-25 standup notes', body: 'Standup happened 2026-08-25, nothing blocking.' }, {})
  assert.equal(standup.stale_pending, undefined, 'and a pending line that is only a date can never be matched')
  // The item's own vocabulary still carries it, date or no date.
  const payroll = await write.execute({ description: 'payroll report sent', body: 'The payroll report went out on 2026-08-26.' }, {})
  assert.deepEqual(payroll.stale_pending, [{ id: ledger.id, line: '- pending: send payroll report 2026-08-25' }])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the close-out sweep stays silent on everything that resolves nothing (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-silent-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const ledger = await write.execute({ description: '2030-04-18 交接:三项worker查询结果未返回', body: PENDING_LEDGER, type: 'handoff' }, {})

  // A write about something else entirely shares no item vocabulary.
  const elsewhere = await write.execute({ description: '星岛训练区RailPay费率确认为千分之五', body: '2030-04-17 与演练团队确认,RailPay费率千分之五,按周结算。' }, {})
  assert.equal(elsewhere.stale_pending, undefined, 'an unrelated write resolves nothing')

  // The ledger's OWN write-back is the close-out, not a stale list — a node
  // must never be flagged against itself.
  const closing = await write.execute({ id: ledger.id, body: PENDING_LEDGER.replace('- Fern会 结果未返回', '- Fern会 内容已存储(2030-04-19)') }, {})
  assert.equal(closing.stale_pending, undefined, 'the node being written is never its own stale ledger')

  // A links-only or type-only update delivers no result, so there is nothing
  // for a pending item to be the question to.
  const wired = await write.execute({ id: ledger.id, links: [] }, {})
  assert.equal(wired.stale_pending, undefined, 'a links-only update stores no content')

  // A closed ledger is not an open one: superseding it retires the whole list.
  const nextLedger = await write.execute({ description: '2030-04-19 交接:三项查询已全部回收', body: '三项worker结果均已入库。', type: 'handoff', supersedes: ledger.id }, {})
  assert.equal(nextLedger.stale_pending, undefined, 'a successor closing the list is not stale against it')
  const late = await write.execute({ description: 'Fern 内容已存储', body: 'Fern会纪要已存入本节点。', type: 'journal' }, {})
  assert.equal(late.stale_pending, undefined, 'a superseded ledger is history — its pending list is closed')

  // And a work-state node retyped out of the kind (the other documented way to
  // close one) leaves the sweep with nothing to scan.
  const thread = await write.execute({ description: '演练许可调研清单', body: '7. KORVAL演示许可分类:检索中', type: 'thread' }, {})
  assert.equal((await write.execute({ description: 'KORVAL演示许可分类已确认', body: 'KORVAL属于B类演练许可。' }, {})).stale_pending?.length, 1, 'open while it is a thread')
  await write.execute({ id: thread.id, type: 'journal' }, {})
  const afterRetype = await write.execute({ description: 'KORVAL演示许可分类再次确认', body: 'KORVAL属于B类演练许可,已归档。' }, {})
  assert.equal(afterRetype.stale_pending, undefined, 'retyping to journal closes the ledger, so the sweep passes it by')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the close-out sweep names at most two ledgers per write (F61, #106)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-pending-cap-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // Seeded through the graph layer, the way the bash writer creates them: the
  // sweep reads the graph, not this process's own write history — and the
  // journal then holds exactly the line the resolving write produces.
  const ids = []
  for (const owner of ['甲', '乙', '丙', '丁']) {
    ids.push(await createNode(fresh, { description: `${owner}线交接:Fern会结果未返回`, body: '- Fern会 结果未返回\n下一步:重新派发。', type: 'handoff' }))
  }
  const stored = await write.execute({ description: 'Fern 内容已存储', body: 'Fern会纪要已存入本节点。', type: 'journal' }, {})
  assert.equal(stored.stale_pending.length, 2, 'the result stays bounded however many ledgers are open')
  for (const match of stored.stale_pending) assert.ok(ids.includes(match.id))
  assert.equal(new Set(stored.stale_pending.map((m) => m.id)).size, 2, 'two distinct ledgers, not one twice')
  const rendered = write.output.render({}, stored)[0].text
  assert.match(rendered, /This write may resolve pending items in \S+ and \S+ — memory_read each/)
  // One journal line per named ledger is not the shape — one line per
  // ADVISORY, carrying both, exactly as `similar` carries its suggestions.
  const lines = (await journalLines(fresh)).filter((line) => line.includes(' stale_pending '))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith(stored.stale_pending.map((m) => `${m.id} — ${m.line}`).join('; ')))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a substantial body revision without a description gets the stale-description nudge (F52, #88)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-stale-desc-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')

  // The 430003 s6 shape: a placeholder-described node gets its resolved
  // answer, description untouched — the nudge fires on the marker alone,
  // even though the char delta is small.
  const pending = await write.execute({ description: 'KORVAL质量问题（用户查询，后台检索中）', body: '', type: 'thread' }, {})
  assert.equal(pending.stale_description, undefined, 'the create path never carries the flag')
  const resolved = await write.execute({ id: pending.id, body: 'KORVAL质量问题已定位:识别错误主要来自NER/ER环节,错误率2.75%,已与算法团队确认修复方案。' }, {})
  assert.equal(resolved.stale_description, 'KORVAL质量问题（用户查询，后台检索中）')
  const rendered = write.output.render({}, resolved)[0].text
  assert.match(rendered, /advertises a pending state \("检索中"\)/)
  assert.match(rendered, /refresh the description \(and `type`/)

  // A still-pending write-back gets the SAME nudge, worded as a conditional —
  // marker absence in a body is no proof of resolution, so the advisory never
  // claims one, and it deliberately repeats on every marker-descriptioned
  // update until the description is refreshed (#100 review).
  const stillPending = await write.execute({ description: '供应商资质核验(待确认)', body: '' }, {})
  const updatedPending = await write.execute({ id: stillPending.id, body: '仍在等供应商回传材料,预计明晚给出核验结果。' }, {})
  assert.equal(updatedPending.stale_description, '供应商资质核验(待确认)', 'the nudge repeats until the description moves')
  const pendingRendered = write.output.render({}, updatedPending)[0].text
  assert.match(pendingRendered, /advertises a pending state \("待确认"\)/)
  assert.match(pendingRendered, /If this update resolved it/)
  assert.doesNotMatch(pendingRendered, /still reads as a placeholder|is now resolved|no longer pending/, 'the advisory must not assert a resolution it cannot see')

  // Echoing the existing description verbatim is not a refresh — the
  // retrieval surface did not move, so the echo must not silence the nudge
  // (#100 review).
  const echoed = await write.execute({ id: stillPending.id, description: '供应商资质核验(待确认)', body: '材料已回传一半,仍在核对经营范围与资质编号。' }, {})
  assert.equal(echoed.stale_description, '供应商资质核验(待确认)', 'a verbatim echo counts as unchanged')

  // "pending" only matches as a whole word: a description that merely
  // contains the substring is not a placeholder (#100 review).
  const csv = await write.execute({ description: 'CSV appending strategy', body: 'append rows to the daily file' }, {})
  const csvTouched = await write.execute({ id: csv.id, body: 'append rows to the daily file, fsync after each batch' }, {})
  assert.equal(csvTouched.stale_description, undefined, 'an embedded "pending" substring is not a marker')

  // No marker: the nudge needs a substantial change. A paragraph-sized fill
  // without a description fires; the same fill WITH a description is silent;
  // a small edit is silent either way.
  const filler = 'Follow-up findings: the stalls only reproduce when the friday run overlaps the weekly vacuum, and the lock is held by the reporting export. Splitting the export into its own window removed the stall in three consecutive runs; keeping the vacuum schedule unchanged. Next: watch the monday run, then close this thread if the overlap theory holds up over a full week of scheduled runs. Also worth recording: the alert threshold was tuned down to 5 minutes during the investigation and should go back to 15 once this closes, and the export owner asked to be pinged before any schedule change.'
  const thread = await write.execute({ description: 'ingest pipeline stall thread', body: 'seed note: ingest pipeline stalls on friday runs' }, {})
  const advanced = await write.execute({ id: thread.id, body: `ingest pipeline stalls on friday runs.\n${filler}` }, {})
  assert.equal(advanced.stale_description, 'ingest pipeline stall thread')
  assert.match(write.output.render({}, advanced)[0].text, /confirm "ingest pipeline stall thread" still summarizes the node/)
  const described = await write.execute({ id: thread.id, description: 'ingest pipeline stalls: friday vacuum overlap, export moved to own window', body: `ingest pipeline stalls on friday runs.\n${filler}\nconfirmed.` }, {})
  assert.equal(described.stale_description, undefined, 'supplying a description is exactly the asked-for behavior')
  const touched = await write.execute({ id: thread.id, body: `ingest pipeline stalls on friday runs.\n${filler}\nconfirmed again.` }, {})
  assert.equal(touched.stale_description, undefined, 'a trivial edit is not a revision the description could go stale over')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('type is revisable through memory_write updates, and the guidance says so (F52, #88)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-retype-'))
  const { ctx, tools, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  // The placeholder-resolution path: a thread stub retyped decision once
  // resolved, then cleared back to untyped with the empty string.
  const stub = await write.execute({ description: 'pricing follow-up (pending)', body: '', type: 'thread' }, {})
  const retyped = await write.execute({ id: stub.id, type: 'decision' }, {})
  assert.equal(retyped.stale_description, undefined, 'a type-only update revises no body — no nudge')
  assert.equal((await read.execute({ id: stub.id }, {})).type, 'decision')
  await write.execute({ id: stub.id, type: '' }, {})
  assert.equal((await read.execute({ id: stub.id }, {})).type, '')
  // The prompt names the path (the mechanism predates F52 — the one-liner is
  // the missing piece): section text and the tool description both say a
  // revision refreshes description and type in the same call.
  assert.match(renderSection({ sections, variables }), /both are revisable on update \(an empty-string `type` clears it\)/)
  assert.match(write.description, /refresh `description` and `type` in the same call/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_write typed_links record directional edges that memory_read renders with a type tag', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-typedlinks-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const a = (await write.execute({ description: 'follows-from source' }, {})).id
  const b = (await write.execute({ description: 'plain neighbor' }, {})).id
  const c = (await write.execute({ description: 'typed neighbor' }, {})).id
  // One node with an untyped link and two typed links, all reported uniformly.
  const hub = await write.execute({ description: 'hub with mixed edges', links: [b], typed_links: [{ id: c, type: 'relates-to' }, { id: a, type: 'follows-from' }] }, {})
  assert.equal(hub.links.filter((l) => l.status === 'created').length, 3, 'plain and typed links share the links result list')
  const view = await read.execute({ id: hub.id }, {})
  const byId = Object.fromEntries(view.edges.map((e) => [e.id, e]))
  assert.equal(byId[c].type, 'relates-to')
  assert.equal(byId[a].type, 'follows-from')
  assert.ok(!('type' in byId[b]), 'the plain link stays untyped')
  const text = read.output.render({}, view)[0].text
  assert.match(text, new RegExp(`${c} \\[relates-to\\] — typed neighbor`))
  assert.match(text, new RegExp(`${a} \\[follows-from\\] — follows-from source`))
  assert.match(text, new RegExp(`${b} — plain neighbor`))
  // An out-of-enum typed-link type is rejected by schema validation.
  await assert.rejects(() => write.execute({ description: 'bad', typed_links: [{ id: a, type: 'bogus' }] }, {}), ToolArgsError)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the supersedes edge is recorded with type `supersedes`', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-typed-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const old = await write.execute({ description: 'old decision', body: 'why' }, {})
  const next = await write.execute({ description: 'new decision', supersedes: old.id }, {})
  // The auto-created new -> old edge carries the `supersedes` type in the sidecar.
  const sidecar = await fsp.readFile(path.join(fresh, next.id, '__edges__', '.edge-types'), 'utf8')
  assert.match(sidecar, new RegExp(`^${old.id} supersedes$`, 'm'))
  // memory_read on the new node surfaces and renders it as a typed edge.
  const view = await read.execute({ id: next.id }, {})
  assert.deepEqual(view.edges, [{ id: old.id, description: 'old decision', type: 'supersedes' }])
  assert.match(read.output.render({}, view)[0].text, new RegExp(`${old.id} \\[supersedes\\] — old decision`))
  // Direction IS the meaning here, so the edge stays one-way under F54 (#90):
  // no reverse symlink, and the old node's view shows no edge row for it —
  // its banner (and [superseded by …] markers) name the successor instead.
  await assert.rejects(fsp.readlink(path.join(fresh, old.id, '__edges__', next.id)), 'supersedes is never symmetrized')
  assert.deepEqual((await read.execute({ id: old.id }, {})).edges, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_merge folds one node into another, repoints its edges, archives it, and refreshes the index', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-tool-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const merge = tools.get('memory_merge')
  const searchTool = tools.get('memory_search')
  const read = tools.get('memory_read')

  const keep = (await write.execute({ description: 'ClickHouse chosen for transcripts', body: 'keep body' }, {})).id
  const absorb = (await write.execute({ description: 'ClickHouse picked for transcript storage', body: 'absorb body' }, {})).id
  const other = (await write.execute({ description: 'a related note', links: [absorb] }, {})).id // other -> absorb

  const result = await merge.execute({ keep_id: keep, absorb_id: absorb }, {})
  assert.deepEqual(validate(merge.output.schema, result), [], 'the internal keepNode never reaches the tool result')
  assert.equal(result.keepNode, undefined)
  assert.equal(result.merged, true)
  assert.equal(result.keep_id, keep)
  assert.equal(result.absorb_id, absorb)
  assert.equal(result.edges_repointed, 1)
  assert.match(merge.output.render({}, result)[0].text, /Merged .+ into .+ 1 edge repointed, 0 files moved\. The absorbed node was archived\./)

  // absorb is archived: a default search misses it, keep survives.
  const hits = await searchTool.execute({ query: 'ClickHouse' }, {})
  assert.ok(!hits.matches.some((m) => m.id === absorb), 'absorbed node is no longer live')
  assert.ok(hits.matches.some((m) => m.id === keep), 'keep survives')
  // The repointed edge now lands on keep.
  assert.ok((await read.execute({ id: other }, {})).edges.some((e) => e.id === keep))
  // keep's body carries the merged-from provenance.
  assert.match((await read.execute({ id: keep }, {})).body, new RegExp(`Merged from ${absorb} on \\d{4}-\\d{2}-\\d{2}:`))
  // A malformed id is rejected by the graph guard.
  await assert.rejects(() => merge.execute({ keep_id: keep, absorb_id: '../evil' }, {}), /invalid/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('crossed concurrent memory_merge calls serialize without deadlock or residue (F68, #130)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-lock-'))
  const creator = await nextTurn(fresh)
  const write = creator.get('memory_write')
  const x = await write.execute({ description: 'crossed merge X', body: 'X body' }, {})
  const y = await write.execute({ description: 'crossed merge Y', body: 'Y body' }, {})
  const peer = await write.execute({ description: 'crossed merge typed peer' }, {})
  await write.execute({ id: x.id, typed_links: [{ id: peer.id, type: 'follows-from' }] }, {})
  const sessions = [await nextTurn(fresh), await nextTurn(fresh)]

  let signalHeld
  let release
  const held = new Promise((resolve) => { signalHeld = resolve })
  const released = new Promise((resolve) => { release = resolve })
  const blocker = withNodeLocks(fresh, [x.id, y.id], async () => {
    signalHeld()
    await released
  })
  await held
  const merges = [
    sessions[0].get('memory_merge').execute({ keep_id: y.id, absorb_id: x.id }, {}),
    sessions[1].get('memory_merge').execute({ keep_id: x.id, absorb_id: y.id }, {}),
  ]
  await settle()
  release()
  await blocker
  const settled = await Promise.allSettled(merges)
  const fulfilled = settled.filter((result) => result.status === 'fulfilled')
  const rejected = settled.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'exactly one crossed merge can archive its peer')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /node does not exist(?: \(or is archived\))?/,
    'the loser either validates after archival or reaches its first locked write after its keep node was archived')

  const liveIds = (await fsp.readdir(fresh, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && ULID_RE.test(entry.name))
    .map((entry) => entry.name)
  for (const id of liveIds) {
    for (const target of await outEdges(fresh, id)) {
      assert.ok(liveIds.includes(target), `live edge ${id} -> ${target} is not dangling`)
    }
    for (const target of (await edgeTypes(fresh, id)).keys()) {
      await fsp.lstat(path.join(fresh, id, '__edges__', target))
      assert.ok(liveIds.includes(target), `sidecar ${id} -> ${target} names an archived node`)
    }
  }
  assert.deepEqual(await fsp.readdir(path.join(fresh, '.locks')), [], 'crossed merges leave no lock directories')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('concurrent memory_merge and a typed addEdge whose third party sorts first do not deadlock (F68, #130 codex review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-thirdparty-'))
  // Different timestamp prefixes make this ordering independent of ULID randomness.
  const third = await createNode(fresh, { description: 'third party sorts first', now: 1_000 })
  const keep = await createNode(fresh, { description: 'merge keep target', now: 2_000 })
  const absorb = await createNode(fresh, { description: 'merge absorb target', now: 3_000 })
  assert.ok(third < keep && third < absorb, 'fixture assumption: third sorts before keep and absorb')
  await addEdge(fresh, third, absorb)

  const sessions = [await nextTurn(fresh), await nextTurn(fresh)]
  await sessions[1].get('memory_read').execute({ id: keep }, {})

  let signalHeld
  let release
  const held = new Promise((resolve) => { signalHeld = resolve })
  const released = new Promise((resolve) => { release = resolve })
  const blocker = withNodeLocks(fresh, [third], async () => {
    signalHeld()
    await released
  })
  await held
  const merge = sessions[0].get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {})
  const typedEdge = sessions[1].get('memory_write').execute({ id: keep, typed_links: [{ id: third, type: 'follows-from' }] }, {})
  await settle()
  release()
  await blocker

  const timeoutMarker = Symbol('timeout')
  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(timeoutMarker), 5_000)
  })
  const outcome = await Promise.race([Promise.allSettled([merge, typedEdge]), timeout])
  clearTimeout(timeoutId)
  assert.notEqual(outcome, timeoutMarker, 'both operations settle well under the 30s stale-lock window — no deadlock')
  assert.deepEqual(await fsp.readdir(path.join(fresh, '.locks')), [], 'no lock directories leak')

  const liveIds = (await fsp.readdir(fresh, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && ULID_RE.test(entry.name))
    .map((entry) => entry.name)
  for (const id of liveIds) {
    for (const target of await outEdges(fresh, id)) {
      assert.ok(liveIds.includes(target), `live edge ${id} -> ${target} is not dangling`)
    }
    for (const target of (await edgeTypes(fresh, id)).keys()) {
      assert.ok(liveIds.includes(target), `sidecar ${id} -> ${target} names an archived node`)
    }
  }
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed_link naming the supersedes target is refused before execution', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-retype-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const old = await write.execute({ description: 'old decision', body: 'why' }, {})
  await read.execute({ id: old.id }, {})
  const before = await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8')
  // The new node supersedes `old` AND names it in typed_links: one relationship
  // in two spellings. The typed entry used to be reported as a `failed` link
  // AFTER the create and the banner landed — a known partial that latched the
  // manage fence — so it is a preparation refusal now, and nothing is written.
  await assert.rejects(
    () => write.execute({ description: 'new decision', body: 'the new why', supersedes: old.id, typed_links: [{ id: old.id, type: 'relates-to' }] }, {}),
    (error) => error instanceof ToolArgsError
      && error.violations.some((violation) => /`supersedes` and `typed_links` both name/.test(violation)),
  )
  assert.equal(await fsp.readFile(path.join(fresh, old.id, 'node.md'), 'utf8'), before, 'the old node keeps no banner')
  assert.equal((await fsp.readdir(fresh)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).length, 1, 'no successor was published')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the memory section injects duplicate candidates from the .duplicates dotfile, and nothing when absent', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dupinject-'))
  const a = await createNode(fresh, { description: 'ClickHouse for transcripts' })
  const b = await createNode(fresh, { description: 'ClickHouse transcript store' })
  const c = await createNode(fresh, { description: 'ClickHouse transcript pick' })
  const d = await createNode(fresh, { description: 'ClickHouse transcript choice' })
  // Write the dotfile the way graph-maintain does: `<a> <b>` per line, top first.
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${a} ${b}\n${a} ${c}\n${a} ${d}\n${b} ${c}\n`)
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  const index = variables.get('memory_index')()
  assert.match(index, /Possible duplicate memories — if two are the same fact, run memory_merge\(keep_id, absorb_id\):/)
  assert.match(index, new RegExp(`  ${a} ~ ${b}`))
  // Only the top 3 pairs are surfaced.
  assert.equal((index.match(/ ~ /g) ?? []).length, 3, 'at most three duplicate pairs are injected')
  assert.doesNotMatch(index, new RegExp(`  ${b} ~ ${c}`), 'the fourth pair is not shown')

  // Absent dotfile → the block disappears (byte-identical to no-duplicates state).
  await fsp.rm(path.join(fresh, '.duplicates'))
  const { ctx: ctx2, variables: variables2 } = fakeCtx()
  apply(ctx2, { graphRoot: fresh })
  assert.doesNotMatch(variables2.get('memory_index')(), /Possible duplicate/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('duplicate injection drops a pair whose side was archived, surfacing only fully-live pairs', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dup-stale-'))
  const a = await createNode(fresh, { description: 'ClickHouse for transcripts' })
  const b = await createNode(fresh, { description: 'ClickHouse transcript store' })
  const c = await createNode(fresh, { description: 'Postgres pool tuning' })
  const d = await createNode(fresh, { description: 'Postgres pool sizing' })
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${a} ${b}\n${c} ${d}\n`)
  // Archive one side of the first pair the way memory_merge does (mv into .archive/).
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, b), path.join(fresh, '.archive', b))
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  const index = variables.get('memory_index')()
  assert.doesNotMatch(index, new RegExp(`${a} ~ ${b}`), 'a pair with an archived side is never injected (re-merging it would throw)')
  assert.match(index, new RegExp(`  ${c} ~ ${d}`), 'the fully-live pair is still injected')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('duplicate injection filters stale pairs BEFORE slicing, so leading archived rows cannot hide a live pair', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-dup-order-'))
  const ids = []
  for (let i = 0; i < 6; i++) ids.push(await createNode(fresh, { description: `node ${i}` }))
  // Three leading rows all reference ids[0]; the only fully-live pair is 4th.
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${ids[0]} ${ids[1]}\n${ids[0]} ${ids[2]}\n${ids[0]} ${ids[3]}\n${ids[4]} ${ids[5]}\n`)
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, ids[0]), path.join(fresh, '.archive', ids[0]))
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  const index = variables.get('memory_index')()
  assert.match(index, new RegExp(`  ${ids[4]} ~ ${ids[5]}`), 'the live 4th pair survives even though the first 3 rows are stale (filter precedes slice)')
  assert.doesNotMatch(index, new RegExp(`${ids[0]} ~`), 'no stale pair is shown')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a supersede that fails midway rolls the new node back', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-rollback-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const searchTool = tools.get('memory_search')
  const old = await write.execute({ description: 'a decision soon unwritable', body: 'original rationale' }, {})
  const before = (await searchTool.execute({ query: '' }, {})).total
  // Make the banner write fail after validation: the old node dir refuses writes.
  await fsp.chmod(path.join(fresh, old.id), 0o555)
  try {
    await assert.rejects(() => write.execute({ description: 'the would-be successor', supersedes: old.id }, {}))
  } finally {
    await fsp.chmod(path.join(fresh, old.id), 0o755)
  }
  // All-or-nothing: the half-created successor (and its edge) are gone.
  assert.equal((await searchTool.execute({ query: '' }, {})).total, before)
  assert.equal((await tools.get('memory_read').execute({ id: old.id }, {})).body, 'original rationale', 'the old body is untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('supersede combined with `id` is rejected before anything is written', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-conflict-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const existing = await write.execute({ description: 'a node to revise' }, {})
  const other = await write.execute({ description: 'another node' }, {})
  const before = await fsp.readFile(path.join(fresh, existing.id, 'node.md'), 'utf8')
  // #247: the contradiction keeps its hard error, but the message now names
  // BOTH remedies — d4e5f6a7 resent the same rejected call four times because
  // it said only what was wrong.
  const error = await write.execute({ id: existing.id, body: 'revised', supersedes: other.id }, {}).then(() => undefined, (error) => error)
  assert.match(error.message, /`supersedes` cannot be combined with `id` — nothing was written/)
  assert.match(error.message, new RegExp(`To edit ${existing.id} in place, resend without \`supersedes\``))
  assert.match(error.message, /To replace it, drop `id` and pass description \+ body \+ supersedes/)
  // Deliberately absent: the `typed_links` spelling reads as a third remedy, but
  // on a deployment without the audited refusal codes an id-update carrying a
  // typed supersede meets the plain "has not been read this session" rejection,
  // which on the zy_a2a line latches the manage fence and quarantines the graph.
  assert.doesNotMatch(error.message, /typed_links/, 'the message must not steer models into the uncertified typed-link path')
  assert.match(error.message, /Do not resend unchanged/)
  assert.equal(await fsp.readFile(path.join(fresh, existing.id, 'node.md'), 'utf8'), before, 'nothing was written')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// demo-boundary: the pure contradictions above are rejected by `defineTool`'s
// trusted preparation, not by the handler. That is the property the runtime
// wrapper depends on — a violation there proves the handler never ran — so the
// test asserts the preparation's own verdict, not merely that a call throws.
// The valid shapes the rules must NOT swallow (an update without a description,
// an append with just an id) are asserted admitted in the same breath, because
// over-rejection at this boundary would be silent for a whole route.
test('memory_write pure shape contradictions reject at the boundary, and admitted routes still run (demo-boundary)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-semantic-write-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, appendWrites: true })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const prepare = trustedPreparationFor(write)
  const existing = await write.execute({ description: 'existing node', body: 'stored body', type: 'thread' }, {})
  const other = await write.execute({ description: 'other node', body: 'other body' }, {})
  const before = await fsp.readFile(path.join(fresh, existing.id, 'node.md'), 'utf8')

  // `supersedes` is create-only: schema-valid, so only the semantic hook can
  // reject it.
  const conflict = { id: existing.id, supersedes: other.id, body: 'revised' }
  // #247: the violation keeps its hard rejection but names both remedies — and
  // (#247 review 2) NOT the `typed_links` spelling, which reads as a third remedy
  // but leads an id-update into the plain unread rejection (which latches the
  // manage fence and quarantines the graph on this line).
  const conflictViolation = `\`supersedes\` cannot be combined with \`id\` — nothing was written. To edit ${existing.id} in place, resend without \`supersedes\`. To replace it, drop \`id\` and pass description + body + supersedes. Do not resend unchanged.`
  assert.doesNotMatch(conflictViolation, /typed_links/)
  assert.deepEqual(prepare(conflict).violations, [conflictViolation])
  await assert.rejects(() => write.execute(conflict, {}), (error) => {
    assert.ok(error instanceof ToolArgsError)
    assert.deepEqual(error.violations, [conflictViolation])
    return true
  })

  // A create without a description (and not an append) is the same class.
  // #263 A2: the rejection names BOTH remedies (pass `description`, or pass
  // `id` to update) instead of only stating the requirement.
  const orphan = { body: 'orphan body' }
  const [orphanViolation] = prepare(orphan).violations
  assert.match(orphanViolation, /^requires `description` when creating a node/)
  assert.match(orphanViolation, /pass `description`/)
  assert.match(orphanViolation, /or pass `id` to update an existing one/)
  await assert.rejects(() => write.execute(orphan, {}), ToolArgsError)

  // The append route's own contradictions, including `append`+`supersedes`
  // keeping the supersedes verdict first, as the handler used to.
  assert.deepEqual(prepare({ id: existing.id, append: 'x', body: 'y' }).violations, [
    '`append` and `body` cannot be combined — `append` adds below the stored body, `body` replaces it. Pass one or the other.',
  ])
  await assert.rejects(() => write.execute({ id: existing.id, append: 'x', body: 'y' }, {}), ToolArgsError)
  assert.deepEqual(prepare({ id: existing.id, append: 'x', supersedes: other.id }).violations, [
    conflictViolation,
    '`append` cannot carry `supersedes` — an append only adds text below the body. To change what the node says (refresh its description or type, link it, supersede it, attach a file), memory_read it and write the full `body` with `id`.',
  ])

  // The rules must admit the ordinary shapes: an update needs no description,
  // and an append needs nothing but an id.
  assert.deepEqual(prepare({ id: existing.id, body: 'revised' }).violations, [])
  assert.deepEqual(prepare({ id: existing.id, append: 'more' }).violations, [])
  assert.equal(
    await fsp.readFile(path.join(fresh, existing.id, 'node.md'), 'utf8'),
    before,
    'every rejection left the node untouched',
  )

  // A real creation, update and append still execute afterwards.
  const created = await write.execute({ description: 'created after probes', body: 'body', type: 'thread' }, {})
  assert.equal(created.created, true)
  await read.execute({ id: created.id }, {})
  const updated = await write.execute({ id: created.id, body: 'revised body' }, {})
  assert.equal(updated.created, false)
  const appended = await write.execute({ id: created.id, append: 'appended line' }, {})
  assert.equal(appended.created, false)
  assert.equal((await read.execute({ id: created.id }, {})).body.trim(), 'revised body\n\nappended line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('superseding an unknown id errors cleanly and creates no new node', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-missing-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const before = (await tools.get('memory_search').execute({ query: '' }, {})).total
  await assert.rejects(
    () => write.execute({ description: 'a would-be successor', supersedes: '01J00000000000000000000001' }, {}),
    /cannot supersede — node does not exist/,
  )
  // Nothing half-happened: no new node was created.
  const after = (await tools.get('memory_search').execute({ query: '' }, {})).total
  assert.equal(after, before)
  // A malformed supersedes id is rejected by the id guard, also with no node created.
  await assert.rejects(() => write.execute({ description: 'x', supersedes: '../evil' }, {}), /invalid/)
  assert.equal((await tools.get('memory_search').execute({ query: '' }, {})).total, before)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a long body is stored intact and nudged toward an attachment', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-longbody-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const bulk = 'transcript line\n'.repeat(200)
  const stored = await write.execute({ description: 'export thread transcript', body: bulk }, {})
  assert.equal(stored.long_body, bulk.length)
  assert.match(write.output.render({}, stored)[0].text, /Long body \(\d+ chars\)/)
  // Advisory only: nothing truncated, the whole body is readable back.
  const view = await tools.get('memory_read').execute({ id: stored.id }, {})
  assert.equal(view.body.trim(), bulk.trim())
  // A short body, and an update that does not touch the body, stay quiet.
  const short = await write.execute({ description: 'short fact', body: 'one line' }, {})
  assert.equal(short.long_body, undefined)
  assert.doesNotMatch(write.output.render({}, short)[0].text, /Long body/)
  assert.equal((await write.execute({ id: stored.id, description: 'export thread transcript' }, {})).long_body, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F73: a deliverable-shaped body draws the attach nudge at any size; prose and gists stay quiet', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-deliverable-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  // The issue's turn-21 shape: a recited report of ~2 KB — ten enumerated
  // items split across two sections — far under LONG_BODY_CHARS, so only the
  // shape trigger can see it. The list floor counts TOTAL items on purpose:
  // the section header between the blocks breaks any contiguous window.
  const recited = [
    'W32 周报正文如下：', '风控部分：',
    ...Array.from({ length: 6 }, (_, i) => `${i + 1}. 风控条目${i + 1}：额度阈值与复核流程的验收结论。`),
    'KYC 部分：',
    ...Array.from({ length: 4 }, (_, i) => `${i + 7}、KYC 条目${i + 1}：证件核验与名单筛查的处理结论。`),
  ].join('\n')
  assert.ok(recited.length < 1500, 'the fixture must sit under the F21 size bar')
  const report = await write.execute({ description: 'W32 周报已交付', body: recited }, {})
  assert.equal(report.long_body, undefined, 'the size trigger does not see this body')
  assert.equal(report.verbatim_deliverable, 'a 10-item enumeration')
  const text = write.output.render({}, report)[0].text
  assert.match(text, /verbatim deliverable/)
  assert.match(text, /memory_attach/)
  // Mirrored to the journal like every advisory (F64): kind, node, payload.
  assert.match(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), new RegExp(` verbatim_deliverable ${report.id} a 10-item enumeration`))
  // A multi-row table fires — the issue's turn-91 shape — as does a quoted block.
  const table = await write.execute({ description: '8 月录音清单', body: '| id | title | 时长 |\n|---|---|---|\n| r1 | 周会 | 31m |\n| r2 | 面谈 | 12m |' }, {})
  assert.equal(table.verbatim_deliverable, 'a 4-row table')
  const quoted = await write.execute({ description: '通知原文', body: '通知原文：\n> 一、自 2026-09-01 起生效。\n> 二、旧口径同日废止。\n> 三、异议期七个工作日。' }, {})
  assert.equal(quoted.verbatim_deliverable, 'a 3-line quoted block')
  // Solo (no long_body), the closing clause narrows the old own-synthesis
  // escape hatch instead of handing the verdict back (F82, #191; codex review
  // of #192): a complete list or table is detail whoever composed it, and the
  // advisory must never again say "keep it in the body, no attachment needed".
  assert.doesNotMatch(text, /no attachment needed/)
  assert.match(text, /the shape of a verbatim deliverable/)
  assert.match(text, /Store the full version with memory_attach and keep this body the gist card/)
  assert.match(text, /Composing it yourself is no exemption/)
  assert.match(text, /only running prose has no detail tier/)
  // …and the ask is a detail FILE, never a stripped body — the summary stays,
  // which is what keeps a compliant writer out of an advisory loop.
  assert.match(text, /the summary stays here/)
  // A self-authored table — nothing recited, nothing attached — now gets the
  // same tier-consistent advice as the recited report above. This is the exact
  // shape the pre-F82 branch told the writer to keep inline.
  const ownTable = await write.execute({ description: '方案对比结论', body: '我自己整理的对比：\n| 方案 | 成本 | 结论 |\n|---|---|---|\n| A | 高 | 否 |\n| B | 低 | 是 |' }, {})
  assert.equal(ownTable.verbatim_deliverable, 'a 4-row table')
  const ownText = write.output.render({}, ownTable)[0].text
  assert.doesNotMatch(ownText, /no attachment needed/)
  assert.match(ownText, /Store the full version with memory_attach and keep this body the gist card/)
  // Both advisories on one write (codex round 2): an agent-authored 1,500+
  // char body of enumerated reasoning must not read opposite instructions —
  // the shape advisory defers to the size rule instead of contradicting it.
  const bulkList = Array.from({ length: 40 }, (_, i) => `${i + 1}. 复盘要点${i + 1}：this line pads the body well past the long-body bar with enumerated reasoning.`).join('\n')
  const both = await write.execute({ description: 'both advisories fire', body: bulkList }, {})
  assert.equal(both.long_body, bulkList.length)
  assert.equal(both.verbatim_deliverable, 'a 40-item enumeration')
  const bothText = write.output.render({}, both)[0].text
  assert.doesNotMatch(bothText, /no attachment needed/)
  assert.match(bothText, /Long body advisory above still stands/)
  assert.match(bothText, /Composing it yourself is no exemption/)
  // Negatives: ordinary prose, and a gist card whose few bullets are the
  // agent's own summary — the non-goals the advisory must not nag. F82 narrows
  // the escape hatch in the COPY, not the detector: a body keeping a short
  // summary still sits under the floors and stays silent, which is why the
  // narrowed advisory cannot fire forever on a writer who complied.
  const prose = await write.execute({ description: 'Q3 目标维持不变', body: 'We agreed the Q3 target stays at 12%. 张三 owns the rollout, and the deadline moved to 2026-09-15 because the vendor slipped. 1.5x growth is still the stretch case.' }, {})
  assert.equal(prose.verbatim_deliverable, undefined)
  assert.doesNotMatch(write.output.render({}, prose)[0].text, /verbatim deliverable/)
  const gist = await write.execute({ description: 'sprint decisions', body: 'Decided:\n- ship Friday\n- keep Postgres\n- drop the retry queue\n- revisit quotas in Q4' }, {})
  assert.equal(gist.verbatim_deliverable, undefined)
  // The compliant shape end to end: the full list rides the write as a named
  // detail file and the body keeps a five-line summary — no advisory at all.
  const complied = await write.execute({
    description: 'Magento 订单列表列',
    body: '订单列表共 12 列；关键列：Grand Total、Purchase Point、Status。完整列表见 magento-orders-grid-columns.md。',
    attach: { filename: 'magento-orders-grid-columns.md', content: Array.from({ length: 12 }, (_, i) => `${i + 1}. column ${i + 1}`).join('\n') },
  }, {})
  assert.equal(complied.verbatim_deliverable, undefined, 'a body that kept only the summary draws nothing')
  assert.equal(complied.generic_filename, undefined)
  assert.doesNotMatch(write.output.render({}, complied)[0].text, /structured detail/)
  // An update that does not touch the body recited nothing (read first — F68 gates the update path).
  await tools.get('memory_read').execute({ id: report.id }, {})
  assert.equal((await write.execute({ id: report.id, description: 'W32 周报已交付' }, {})).verbatim_deliverable, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F74 (#163): F73 fixed the trigger — 29 verbatim_deliverable advisories on the
// round-11 replay where the size bar fired zero — and adoption did not move at
// all: memory_attach stayed at 0 calls in 120 turns, three rounds running. The
// reason was structural, not a detection gap: acting on the advisory meant a
// SECOND memory_write plus a memory_attach, and the model ended the turn
// instead. So the payload now rides the write that was already happening.
test('F74: memory_write stores an inline attachment on create and on update', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const payload = '| 序号 | 条目 | 结论 |\n|---|---|---|\n| 1 | 额度阈值 | 通过 |\n| 2 | 名单筛查 | 待复核 |\n'

  // Create: one call stores the gist card AND the deliverable it summarizes.
  const stored = await write.execute({ description: 'W32 周报已交付', body: 'W32 周报：风控 2 条，其中名单筛查待复核。全文见 zhoubao-2026W32.md。', attach: { filename: 'zhoubao-2026W32.md', content: payload } }, {})
  assert.deepEqual(stored.attached, { file: 'zhoubao-2026W32.md', bytes: Buffer.byteLength(payload), status: 'created' })
  assert.equal(stored.attach_failed, undefined)
  assert.deepEqual(validate(write.output.schema, stored), [])
  // Reported exactly as memory_attach reports its own, so one payload reads
  // the same however it was stored.
  assert.match(write.output.render({}, stored)[0].text, /^Attached zhoubao-2026W32\.md on 01[0-9A-HJKMNP-TV-Z]{24} \(\d+ bytes\)\.$/m)
  // A real attachment, not a private half-write: read lists it and
  // memory_read_file pages it back byte for byte.
  const view = await read.execute({ id: stored.id }, {})
  assert.deepEqual(view.files, [{ name: 'zhoubao-2026W32.md', size: stored.attached.bytes, summary: '| 序号 | 条目 | 结论 |' }])
  assert.equal((await tools.get('memory_read_file').execute({ id: stored.id, file: 'zhoubao-2026W32.md' }, {})).content, payload)

  // Update: the same one call on an existing node. A new name creates…
  const second = await write.execute({ id: stored.id, body: 'W32 周报：风控 2 条。KYC 明单另附 kyc-mingdan.md。', attach: { filename: 'kyc-mingdan.md', content: 'KYC 明单\n' } }, {})
  assert.deepEqual(second.attached, { file: 'kyc-mingdan.md', bytes: Buffer.byteLength('KYC 明单\n'), status: 'created' })
  // …and an existing one overwrites, reported as memory_attach reports it.
  const third = await write.execute({ id: stored.id, attach: { filename: 'kyc-mingdan.md', content: 'KYC 明单（第二版）\n' } }, {})
  assert.equal(third.attached.status, 'overwritten')
  assert.match(write.output.render({}, third)[0].text, /^Overwrote kyc-mingdan\.md on /m)
  assert.equal((await tools.get('memory_read_file').execute({ id: stored.id, file: 'kyc-mingdan.md' }, {})).content, 'KYC 明单（第二版）\n')
  // The node kept both files and the body the writes gave it.
  const after = await read.execute({ id: stored.id }, {})
  assert.deepEqual(after.files.map((file) => file.name).sort(), ['kyc-mingdan.md', 'zhoubao-2026W32.md'])
  assert.match(after.body, /KYC 明单另附/)

  // F73's detector is untouched — it still fires when the payload rode this
  // very call, which is what makes adoption measurable — but the advisory no
  // longer asks for what the writer just did.
  const shaped = await write.execute({ description: '8 月录音清单', body: payload, attach: { filename: 'lu-yin-8yue.md', content: payload } }, {})
  assert.equal(shaped.verbatim_deliverable, 'a 4-row table')
  const shapedText = write.output.render({}, shaped)[0].text
  assert.match(shapedText, /You stored lu-yin-8yue\.md this call/)
  assert.doesNotMatch(shapedText, /Store the full version with memory_attach/)
  // Nor does it re-litigate authorship at a writer who already attached
  // (F82, #191): that branch asks for nothing further.
  assert.doesNotMatch(shapedText, /Composing it yourself/)

  // A write with no `attach` behaves exactly as it did before: no field, no
  // line in the render, no file in the node directory.
  const plain = await write.execute({ description: 'a plain write, no extra file', body: 'one line' }, {})
  assert.equal(plain.attached, undefined)
  assert.equal(plain.attach_failed, undefined)
  assert.deepEqual((await fsp.readdir(path.join(fresh, plain.id))).filter((entry) => entry !== '__edges__'), ['node.md'])
  assert.deepEqual((await read.execute({ id: plain.id }, {})).files, [])
  assert.doesNotMatch(write.output.render({}, plain)[0].text, /Attached|attachment/)
  // A landed attachment is an OUTCOME, not a finding: nothing here is journaled.
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), /attach/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The two failure halves, which is where a one-call convenience gets dangerous:
// a payload silently believed stored is the loss the feature exists to prevent.
test('F74: an inline attach that fails keeps the write and says so; an invalid one lands nothing', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-fail-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const id = (await write.execute({ description: 'W32 周报已交付', body: '全文见 zhoubao.md。', attach: { filename: 'zhoubao.md', content: 'W32 全文\n' } }, {})).id

  // The empty-overwrite refusal (ledger #21) is the one validation that needs
  // the node directory, so it is the failure that CAN reach a landed write.
  const failed = await write.execute({ id, body: '全文见 zhoubao.md（已复核）。', attach: { filename: 'zhoubao.md', content: '' } }, {})
  assert.equal(failed.attached, undefined)
  assert.match(failed.attach_failed, /refusing to replace zhoubao\.md/)
  assert.deepEqual(validate(write.output.schema, failed), [])
  // The write is NOT rolled back — and the prior payload is not clobbered.
  const view = await read.execute({ id }, {})
  assert.match(view.body, /已复核/)
  assert.equal((await tools.get('memory_read_file').execute({ id, file: 'zhoubao.md' }, {})).content, 'W32 全文\n')
  // Both halves in one breath, and the retry is named — never the failure alone.
  const text = write.output.render({}, failed)[0].text
  assert.match(text, /^Updated 01[0-9A-HJKMNP-TV-Z]{24}/)
  assert.match(text, /written but the attachment was NOT stored/)
  assert.match(text, new RegExp(`memory_attach on ${id}`))
  // Journaled like every advisory the writer is shown (F64, #109).
  assert.match(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), new RegExp(` attach_failed ${id} `))

  // The name rules are memory_attach's, unchanged — and they reject BEFORE the
  // write mutates anything, so a bad filename never costs a half-stored node.
  const nodesBefore = (await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry))
  for (const [attach, message] of [
    [{ filename: 'node.md', content: 'x' }, /reserved/],
    [{ filename: '__edges__', content: 'x' }, /reserved/],
    [{ filename: '../escape', content: 'x' }, /path separators/],
    [{ filename: 'sub/dir.md', content: 'x' }, /path separators/],
    [{ filename: '.hidden', content: 'x' }, /start with a dot/],
    [{ filename: 'ok.md', content: 42 }, /arguments\.attach\.content must be string/],
    [{ filename: 'ok.md' }, /arguments\.attach\.content is required/],
    [{ content: 'x' }, /arguments\.attach\.filename is required/],
  ]) {
    await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach }, {}), message)
    // And on the update path, where the reject must spare a node that exists.
    await assert.rejects(() => write.execute({ id, body: 'MUST NOT LAND', attach }, {}), message)
  }
  assert.deepEqual((await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry)), nodesBefore, 'a rejected attach creates no node')
  const survivor = await read.execute({ id }, {})
  assert.match(survivor.body, /已复核/, 'a rejected attach lands no body either')
  assert.deepEqual(survivor.files.map((file) => file.name), ['zhoubao.md'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The create half of the same property (codex review round 2 of #165): a
// create has no critical section to join — createNode publishes by renaming a
// staging directory into place — so the file has to be IN what is renamed.
// Otherwise the node is discoverable by lock-free search with a gist whose
// payload does not exist yet, and a peer can update it in that gap. The test
// watches the publication rename itself.
test('F74: a create publishes its body and attachment in one rename (#165 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-publish-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const realRename = fsp.rename
  const published = []
  fsp.rename = async (...args) => {
    if (path.basename(args[0]).startsWith('.staging-')) published.push((await fsp.readdir(args[0])).sort())
    return realRename.apply(fsp, args)
  }
  let stored
  try {
    stored = await tools.get('memory_write').execute({ description: '周报节点', body: '第一版', attach: { filename: 'inline.md', content: 'v1\n' } }, {})
  } finally {
    fsp.rename = realRename
  }
  assert.deepEqual(published, [['__edges__', 'inline.md', 'node.md']],
    'the node becomes visible complete — there is no state where the gist exists without the file it names')
  assert.deepEqual(stored.attached, { file: 'inline.md', bytes: Buffer.byteLength('v1\n'), status: 'created' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F78 (#171): round 13's first use of the one-call path passed `attach` as a
// JSON STRING — the exact {filename, content} shape, serialized — drew
// `arguments.attach must be object`, and the model silently recovered with a
// body rewrite plus a standalone memory_attach: the two-call flow F74 exists
// to remove, with nothing anywhere recording that the inline path was even
// attempted. The boundary now parses the string; everything it cannot repair
// still fails with the same violations it always drew.
test('F78: a JSON-string `attach` is parsed at the boundary; what does not parse to the shape still rejects (#171)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-string-attach-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const payload = '# 物流×仓储业务对接会议纪要\n**日期：** 2026年8月19日\n'
  // The round-13 shape verbatim: the object form, quoted — stored exactly as
  // the object form would have stored it.
  const stored = await write.execute({ description: '会议纪要已归档', body: '纪要全文见附件。', attach: JSON.stringify({ filename: 'jiyao-2026-08-19.md', content: payload }) }, {})
  assert.deepEqual(stored.attached, { file: 'jiyao-2026-08-19.md', bytes: Buffer.byteLength(payload), status: 'created' })
  assert.equal((await tools.get('memory_read_file').execute({ id: stored.id, file: 'jiyao-2026-08-19.md' }, {})).content, payload)
  // The update path repairs through the same boundary — coerce runs before
  // the create/update split ever sees the arguments.
  await tools.get('memory_read').execute({ id: stored.id }, {})
  const second = await write.execute({ id: stored.id, attach: JSON.stringify({ filename: 'jiyao-2026-08-19.md', content: `${payload}（已复核）\n` }) }, {})
  assert.equal(second.attached.status, 'overwritten')
  // The presenter sees the repaired arguments too — a logged serialized call
  // renders its card instead of falling back to the generic one.
  assert.equal(write.presentCall({ description: 'x', attach: JSON.stringify({ filename: 'a.md', content: 'b' }) }).title, 'Store a memory')
  // Repair-or-leave-alone: a string that is not JSON, or is JSON of the wrong
  // type, draws the SAME clear violation the object rule always drew — and a
  // parsed object still runs the nested checks it would have run arriving as
  // one.
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: 'not json at all' }, {}), /arguments\.attach must be object/)
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: '[1, 2]' }, {}), /arguments\.attach must be object/)
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: '"double-encoded"' }, {}), /arguments\.attach must be object/)
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: 'null' }, {}), /arguments\.attach must be object/)
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: JSON.stringify({ filename: 'a.md' }) }, {}), /arguments\.attach\.content is required/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The atomicity property, from the codex pre-merge review of #165: publishing
// the body in one critical section and the file in a SECOND one let a peer's
// write land between them — A writes body A, B writes body B and file B, then
// A's late attach overwrites file B with payload A, both calls reporting
// success and the node left pairing B's gist with A's payload. One section is
// what forbids it, so the test watches the lock itself: at the moment the
// node's lock is released, BOTH halves of the call must already be on disk,
// and there must be no second acquisition left to make.
test('F74: an inline attach publishes inside the write\'s own critical section (#165 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-atomic-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const id = (await write.execute({ description: '周报节点', body: '第一版', attach: { filename: 'inline.md', content: 'v1\n' } }, {})).id

  const lockDir = path.join(fresh, '.locks', `${id}.lock`)
  const realRmdir = fsp.rmdir
  const releases = []
  fsp.rmdir = async (...args) => {
    if (args[0] === lockDir) {
      releases.push({
        body: await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8'),
        file: await fsp.readFile(path.join(fresh, id, 'inline.md'), 'utf8').catch(() => undefined),
      })
    }
    return realRmdir.apply(fsp, args)
  }
  try {
    await write.execute({ id, body: '第二版', attach: { filename: 'inline.md', content: 'v2\n' } }, {})
  } finally {
    fsp.rmdir = realRmdir
  }
  assert.equal(releases.length, 1, 'one write takes the node lock once — a second scope is a window a peer can write into')
  assert.match(releases[0].body, /第二版/, 'the body is published before the lock is released')
  assert.equal(releases[0].file, 'v2\n', 'and so is the payload — no state pairs this gist with the previous file')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The inheritance collision, from codex review round 2 of #165: a `supersedes`
// create inherits the old node's files, and an inline attach of the SAME name
// used to land after that move and overwrite one — a silent delete of the
// historical payload, which habit 6 forbids outright. Publishing the file with
// the node (createNode's rename) puts it in the destination BEFORE
// moveExtraFiles runs, so the inherited file takes the collision-safe rename
// exactly as it would for a follow-up memory_attach. Both payloads survive.
test('F74: a supersedes create with an inline attach keeps the inherited file, renamed (#165 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-inherit-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const readFile = tools.get('memory_read_file')
  const old = await write.execute({ description: '旧周报', body: 'v1', attach: { filename: 'report.md', content: 'OLD REPORT\n' } }, {})
  const next = await write.execute({ description: '新周报', body: 'v2', supersedes: old.id, attach: { filename: 'report.md', content: 'NEW REPORT\n' } }, {})

  assert.deepEqual(next.attached, { file: 'report.md', bytes: Buffer.byteLength('NEW REPORT\n'), status: 'created' })
  assert.equal(next.superseded.files_moved, 1, 'the old payload followed the live head')
  const files = (await tools.get('memory_read').execute({ id: next.id }, {})).files.map((file) => file.name).sort()
  assert.equal(files.length, 2, 'both payloads are on the successor — neither overwrote the other')
  assert.ok(files.includes('report.md'))
  const inherited = files.find((name) => name !== 'report.md')
  assert.match(inherited, new RegExp(`^${old.id.slice(0, 8)}(_\\d+)?_report\\.md$`), 'the inherited file took the collision-safe rename')
  assert.equal((await readFile.execute({ id: next.id, file: 'report.md' }, {})).content, 'NEW REPORT\n')
  assert.equal((await readFile.execute({ id: next.id, file: inherited }, {})).content, 'OLD REPORT\n', 'the superseded payload survives verbatim')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The #144 rollback property, re-verified with an attachment in play: a gated
// supersede reject must leave zero new directories. The typed_links spelling is
// the one that can reject AFTER the create's inline attach has already landed,
// so `rollbackSuccessor` has to recognize that file as this call's own.
test('F74: a gated supersede reject leaves no successor and no orphan file (#144 × #163)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-rollback-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const target = (await tools.get('memory_write').execute({ description: '旧决定', body: 'v1' }, {})).id
  // A second Session, which has never read the target: both supersede
  // spellings must reject on the version gate (F68, #130).
  const { ctx: other, tools: stranger } = fakeCtx()
  apply(other, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const nodesBefore = (await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry))
  for (const extra of [{ supersedes: target }, { typed_links: [{ id: target, type: 'supersedes' }] }]) {
    await assert.rejects(
      () => stranger.get('memory_write').execute({ description: '新决定', body: 'v2', attach: { filename: 'payload.md', content: 'full text\n' }, ...extra }, {}),
      /has not been read this session/,
    )
    assert.deepEqual((await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry)), nodesBefore, 'the rejected create is unpublished, attachment and all')
  }

  // And the branch the ordinary rejects never reach: the LOCKED re-check, when
  // the target changes in the last millisecond between the unlocked pre-check
  // and the lock. By then the create has published AND its inline attachment
  // has landed, so this is the one path where `rollbackSuccessor` sees a file
  // in the successor's directory — it must recognize it as this call's own and
  // unpublish anyway. The competitor writes at lock-acquisition time.
  await stranger.get('memory_read').execute({ id: target }, {})
  const targetLock = path.join(fresh, '.locks', `${target}.lock`)
  const realMkdir = fsp.mkdir
  let raced = false
  fsp.mkdir = async (...args) => {
    if (args[0] === targetLock && !raced) {
      raced = true
      await fsp.writeFile(path.join(fresh, target, 'node.md'), `${await fsp.readFile(path.join(fresh, target, 'node.md'), 'utf8')}\ncompeting edit\n`)
    }
    return realMkdir.apply(fsp, args)
  }
  try {
    await assert.rejects(
      () => stranger.get('memory_write').execute({ description: '新决定', body: 'v2', attach: { filename: 'payload.md', content: 'full text\n' }, typed_links: [{ id: target, type: 'supersedes' }] }, {}),
      /changed since it was read — a Stale Write/,
    )
  } finally {
    fsp.mkdir = realMkdir
  }
  assert.ok(raced, 'the competing edit must have landed inside the lock queue, or the race was not exercised')
  assert.deepEqual((await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry)), nodesBefore, 'the successor is unpublished even though this call had already attached to it')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The other half of the rollback rule (codex review round 2 of #165): the
// successor's file is recognized by CONTENT, not by name. A peer that
// overwrites that filename while this call waits on the target's lock owns
// those bytes, and #144's doctrine is that a stray recoverable node beats a
// deleted write — so the rollback must decline and leave the node standing.
test('F74: a peer\'s bytes under the attachment name veto the rollback (#165 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-foreign-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const target = (await tools.get('memory_write').execute({ description: '旧决定', body: 'v1' }, {})).id
  const { ctx: other, tools: stranger } = fakeCtx()
  apply(other, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  await stranger.get('memory_read').execute({ id: target }, {})
  const nodesBefore = (await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry))

  // At lock-acquisition time: stale the target (forcing the gated reject) AND
  // overwrite the successor's attachment with somebody else's bytes.
  const targetLock = path.join(fresh, '.locks', `${target}.lock`)
  const realMkdir = fsp.mkdir
  let successor
  fsp.mkdir = async (...args) => {
    if (args[0] === targetLock && successor === undefined) {
      successor = (await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry) && !nodesBefore.includes(entry))[0]
      await fsp.writeFile(path.join(fresh, target, 'node.md'), `${await fsp.readFile(path.join(fresh, target, 'node.md'), 'utf8')}\ncompeting edit\n`)
      await fsp.writeFile(path.join(fresh, successor, 'payload.md'), 'A PEER WROTE THIS\n')
    }
    return realMkdir.apply(fsp, args)
  }
  try {
    await assert.rejects(
      () => stranger.get('memory_write').execute({ description: '新决定', body: 'v2', attach: { filename: 'payload.md', content: 'mine\n' }, typed_links: [{ id: target, type: 'supersedes' }] }, {}),
      /changed since it was read — a Stale Write/,
    )
  } finally {
    fsp.mkdir = realMkdir
  }
  assert.ok(successor, 'the successor must have been published before the gate rejected')
  assert.equal(await fsp.readFile(path.join(fresh, successor, 'payload.md'), 'utf8'), 'A PEER WROTE THIS\n',
    "the rollback must not delete bytes this call did not write — a stray node is recoverable, somebody's write is not")
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The size cap, from the same review: it is knowable before the node is
// touched, so it must reject there — an over-cap payload that lands the gist
// and then fails leaves a body naming a file nobody can open.
test('F74: an over-cap inline attach rejects before the node is written (#165 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inline-attach-cap-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const over = { filename: 'huge.md', content: 'x'.repeat(ATTACH_MAX_BYTES + 1) }
  const id = (await write.execute({ description: '周报节点', body: '第一版' }, {})).id
  const nodesBefore = (await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry))
  // Create: nothing is minted.
  await assert.rejects(() => write.execute({ description: 'MUST NOT LAND', body: 'x', attach: over }, {}), /`attach.content` too large \(\d+ bytes, max \d+\)/)
  assert.deepEqual((await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry)), nodesBefore, 'an over-cap payload mints no node')
  // Update: the body it would have promised the file to is untouched.
  await assert.rejects(() => write.execute({ id, body: 'MUST NOT LAND', attach: over }, {}), /`attach.content` too large/)
  const view = await tools.get('memory_read').execute({ id }, {})
  assert.match(view.body, /第一版/)
  assert.deepEqual(view.files, [])
  // One byte under the cap is stored, so the check is a cap and not a wall.
  const ok = await write.execute({ id, body: '第二版', attach: { filename: 'big.md', content: 'y'.repeat(ATTACH_MAX_BYTES) } }, {})
  assert.deepEqual(ok.attached, { file: 'big.md', bytes: ATTACH_MAX_BYTES, status: 'created' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F46 (#75): a memory-update turn that writes nothing is silent data loss. The
// exit check fires only when the composition declared `expectWrite`, and only
// on a process that made zero successful memory_write calls. The check lives
// on process exit, so the positive cases fork a child rather than pollute this
// runner's own exit.
const LIB_URL = new URL('../lib/index.js', import.meta.url).href

/** Run a small module in a child node, returning { status, stderr }. */
function forkModule(source) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  return { status: child.status, stderr: child.stderr }
}

test('F46: expectWrite validation and no exit handler by default', () => {
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, expectWrite: 'yes' }), /`expectWrite` must be a boolean/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, expectWrite: 1 }), /`expectWrite` must be a boolean/)
  // Default off: an ordinary composition must not gain an exit handler at all.
  const before = process.listenerCount('exit')
  apply(fakeCtx().ctx, { graphRoot: root })
  apply(fakeCtx().ctx, { graphRoot: root, expectWrite: false })
  assert.equal(process.listenerCount('exit'), before)
})

test('F46: a zero-write exit under expectWrite warns and leaves a marker line', async () => {
  // A path that does not exist yet: createNode makes the root lazily, and a
  // zero-write turn is exactly the turn that never called it — the marker
  // write must create the root itself (codex review of this change).
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f46-'))
  const fresh = path.join(parent, 'memories')
  const { status, stderr } = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    apply({ tools: { register: () => () => {} }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true })
  `)
  assert.equal(status, 0)
  assert.match(stderr, /made no memory_write call/)
  // No turnId configured: neither surface may carry a `turn=` field (F48, #84)
  // — the marker keeps its exact F46 shape, asserted to the byte below.
  assert.doesNotMatch(stderr, /turn=/)
  const marker = await fsp.readFile(path.join(fresh, '.zero-write-turns'), 'utf8')
  const lines = marker.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* pid=\d+ zero memory_write calls$/)
  await fsp.rm(parent, { recursive: true, force: true })
})

test('F46: a turn that wrote stays silent, and a failed write does not count', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f46ok-'))
  const wrote = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    const tools = new Map()
    apply({ tools: { register: (d) => { tools.set(d.name, d); return () => {} } }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true })
    await tools.get('memory_write').execute({ description: 'child turn fact' }, {})
  `)
  assert.equal(wrote.status, 0)
  assert.doesNotMatch(wrote.stderr, /memory_write/)
  await assert.rejects(() => fsp.access(path.join(fresh, '.zero-write-turns')))
  // A write that THREW persisted nothing, so it must still flag.
  const failed = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    const tools = new Map()
    apply({ tools: { register: (d) => { tools.set(d.name, d); return () => {} } }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true })
    await tools.get('memory_write').execute({ body: 'no description, rejected' }, {}).catch(() => {})
  `)
  assert.equal(failed.status, 0)
  assert.match(failed.stderr, /made no memory_write call/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F48 (#84): the marker recorded only pid + timestamp, so forensics could not
// tell which segment died. A caller that knows the turn names it via `turnId`,
// and both the marker line and the stderr warning carry it.
test('F48: turnId must be a non-empty single-line string', () => {
  for (const bad of [42, true, '', null, ['s12'], { step: 12 }]) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, turnId: bad }), /`turnId` must be a non-empty string/)
  }
  // Any line terminator would forge extra marker lines in a line-oriented
  // file — including the Unicode separators JS treats as line breaks.
  for (const sep of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, turnId: `s12${sep}forged` }), /`turnId` must be a single line/)
  }
  // Valid ids load fine, with or without the exit hook armed.
  apply(fakeCtx().ctx, { graphRoot: root, turnId: '420002/step-12' })
})

test('F48: a zero-write exit under a turnId names the turn in the marker and on stderr', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f48-'))
  const { status, stderr } = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    apply({ tools: { register: () => () => {} }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true, turnId: '420002/step-12' })
  `)
  assert.equal(status, 0)
  // The operator can tie the warning to a segment without opening the file.
  assert.match(stderr, /made no memory_write call \(turn=420002\/step-12\)/)
  const marker = await fsp.readFile(path.join(fresh, '.zero-write-turns'), 'utf8')
  const lines = marker.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ pid=\d+ turn=420002\/step-12 zero memory_write calls$/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F48: a turn that wrote stays silent even with a turnId configured', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f48ok-'))
  const wrote = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    const tools = new Map()
    apply({ tools: { register: (d) => { tools.set(d.name, d); return () => {} } }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true, turnId: '430003/step-01' })
    await tools.get('memory_write').execute({ description: 'child turn fact' }, {})
  `)
  assert.equal(wrote.status, 0)
  assert.equal(wrote.stderr, '')
  await assert.rejects(() => fsp.access(path.join(fresh, '.zero-write-turns')))
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F64 (#109): advisories ride the tool result, which lives only in the session
// transcript. The journal mirrors them to `<root>/.advisories` so a replay's
// advisories are countable per turn from the graph root alone.

/** The `.advisories` lines at a graph root; `[]` when the journal never opened. */
const journalLines = (dir) => fsp.readFile(path.join(dir, '.advisories'), 'utf8')
  .then((text) => text.split('\n').filter((line) => line.length > 0), () => [])

test('F64: an advisory is mirrored to `.advisories` with its turn, kind, node and digest', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: '420002/step-12' })
  await settle()
  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'ClickHouse chosen for transcript storage over Postgres', body: 'analytical joins' }, {})
  // A clean write journals nothing — silence means no advisory fired, so the
  // file does not even exist yet.
  assert.deepEqual(await journalLines(fresh), [])
  const second = await write.execute({ description: 'ClickHouse selected for transcript storage instead of Postgres', body: 'analytical joins' }, {})
  assert.deepEqual(second.similar.map((m) => m.id), [first.id], 'the duplicate guard is what this test journals')
  const lines = await journalLines(fresh)
  assert.equal(lines.length, 1)
  // The line names the turn (F48's field, same omit-when-unset rule), the
  // advisory kind, the node the advisory is ABOUT, and the payload digest.
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-12 similar ${second.id} ${first.id} — ClickHouse chosen for transcript storage over Postgres$`))
  // Append-only: a later advisory joins the file rather than replacing it.
  const third = await write.execute({ description: 'ClickHouse picked for transcript storage rather than Postgres', body: 'analytical joins' }, {})
  const grown = await journalLines(fresh)
  assert.equal(grown.length, 1 + advisoryKinds(third).length)
  assert.equal(grown[0], lines[0], 'the earlier line is untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

/** The advisory kinds a write result carries, as the journal orders them —
 * one entry per journal LINE, so each hub peer counts once. */
function advisoryKinds(value) {
  const kinds = []
  if ((value.similar ?? []).length > 0) kinds.push('similar')
  if (value.long_body !== undefined) kinds.push('long_body')
  if (value.verbatim_deliverable !== undefined) kinds.push('verbatim_deliverable')
  if (value.node_size !== undefined) kinds.push('node_size')
  if (value.node_degree !== undefined) kinds.push('node_degree')
  for (const _ of value.hub_links ?? []) kinds.push('node_degree')
  if ((value.link_candidates ?? []).length > 0) kinds.push('link_candidates')
  if (value.blind_rewrite !== undefined) kinds.push('blind_rewrite')
  if (value.replaced_body !== undefined) kinds.push('replaced_body')
  if (value.dropped_body !== undefined) kinds.push('dropped_body')
  if ((value.dropped_ids ?? []).length > 0) kinds.push('dropped_ids')
  if (value.stale_description !== undefined) kinds.push('stale_description')
  if ((value.unsourced_assertions ?? []).length > 0) kinds.push('unsourced_assertions')
  if ((value.minted_precision ?? []).length > 0) kinds.push('minted_precision')
  if ((value.restated_lines ?? []).length > 0) kinds.push('restated_lines')
  if ((value.stale_pending ?? []).length > 0) kinds.push('stale_pending')
  return kinds
}

test('F64: without a turnId the line carries no `turn=` field at all', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-noturn-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  await write.execute({ description: 'Redis dropped from the ingest path over latency spikes', body: 'tail latency' }, {})
  await write.execute({ description: 'Redis removed from the ingest path because of latency spikes', body: 'tail latency' }, {})
  const lines = await journalLines(fresh)
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /turn=/)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ similar 0/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F64: a turnId carrying whitespace is escaped so the line stays positional', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-turnws-'))
  const { ctx, tools } = fakeCtx()
  // F48 validates `turnId` as a single LINE, not as a single token, and that
  // validation must stay as it is — it throws at load, and a replay already in
  // flight would die on the id it has been passing all along. So the journal
  // escapes at write time instead: the fields after `turn=` are positional.
  apply(ctx, { graphRoot: fresh, turnId: '420002/step 12\t(retry 100%)' })
  await settle()
  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'the Oslo datacenter contract renews in March', body: 'renewal' }, {})
  const second = await write.execute({ description: 'the Oslo datacenter contract is renewed each March', body: 'renewal' }, {})
  const [line] = await journalLines(fresh)
  const fields = line.split(' ')
  assert.equal(fields[1], 'turn=420002/step%2012%09(retry%20100%25)')
  // Positional again: kind, then the node, then the digest to end of line.
  assert.equal(fields[2], 'similar')
  assert.equal(fields[3], second.id)
  assert.ok(fields.slice(4).join(' ').startsWith(first.id))
  // And the escape is reversible, so a consumer can group by the id the caller
  // actually configured.
  assert.equal(decodeURIComponent(fields[1].slice('turn='.length)), '420002/step 12\t(retry 100%)')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// One line per advisory, each naming the node it is ABOUT — the written node
// for every kind except F70's hub peers, whose node_degree lines name the
// peer (asserted in the F70 degree test).
test('F64: a write firing several advisories gets one line each, naming the node each is about', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-multi-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: '420002/step-10' })
  await settle()
  const write = tools.get('memory_write')
  // The F52 lossy-shrink shape: the update drops a dated-facts block AND
  // leaves the description asserting what it dropped — two advisories, one
  // write, so two lines.
  const prior = [
    '2030-02-04 与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '2030-02-08 预算结论:参与者名单已sign up,但costing没有sign up,练习额度缺口约240万美金,账目由虚构协调员单独核算,发票样例需逐项复核,结算规则另存表格。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const next = [
    '与教练对齐160-HC演练进展:双方确认了课程分组的整体框架,按月度推进练习场景轮换,先安排主持人与记录负责人,模拟小组按指定节奏完成练习。',
    '后续安排:2月第三周提交修订后的costing样例,同步给课程负责人校验,并在模拟例会上展示结果。',
  ].join('\n')
  const node = await write.execute({ description: '160-HC演练进展:costing额度未sign up,缺口约240万美金', body: prior, type: 'thread' }, {})
  assert.deepEqual(await journalLines(fresh), [], 'the create fired nothing')
  const shrunk = await write.execute({ id: node.id, body: next }, {})
  assert.deepEqual(advisoryKinds(shrunk), ['dropped_body', 'stale_description'])
  const lines = await journalLines(fresh)
  assert.equal(lines.length, 2)
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-10 dropped_body ${node.id} ${prior.length - next.length} chars$`))
  assert.match(lines[1], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-10 stale_description ${node.id} 160-HC演练进展:costing额度未sign up,缺口约240万美金$`))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F64: the blind-rewrite advisory rides the same plumbing and is journaled by kind (F62, #107)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-blind-'))
  const setup = await nextTurn(fresh, { turnId: '420002/step-6' })
  const prior = 'The gate code is 4417 and the lockbox by the side door holds the spare key.'
  const node = await setup.get('memory_write').execute({ description: 'gate code and spare key location', body: prior }, {})
  await setup.get('memory_attach').execute({ id: node.id, filename: 'version-gate.txt', content: 'read path for version-gate compatibility tests' }, {})
  assert.deepEqual(await journalLines(fresh), [], 'the create fired nothing')
  // A new turn, no body read, a wholesale replace: the process advisory and
  // the content advisory it explains both land, one line each, same node.
  const turn = await nextTurn(fresh, { turnId: '420002/step-7' })
  await turn.get('memory_read_file').execute({ id: node.id, file: 'version-gate.txt' }, {})
  const purged = await turn.get('memory_write').execute({ id: node.id, body: 'Access details are intentionally not retained here.' }, {})
  assert.deepEqual(advisoryKinds(purged), ['blind_rewrite', 'replaced_body', 'stale_description'])
  const lines = await journalLines(fresh)
  assert.equal(lines.length, 3)
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-7 blind_rewrite ${node.id} ${prior.length} chars$`))
  assert.match(lines[1], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=420002/step-7 replaced_body ${node.id} ${prior.length} chars$`))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F64: the digest stays one line and capped, however long the payload', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-digest-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: 's1' })
  await settle()
  const write = tools.get('memory_write')
  const long = `the Frankfurt region migration is scheduled for the November maintenance window because the ingest cluster there ${'carries the overnight batch and the replay backlog together '.repeat(4)}and cannot be drained sooner`
  const first = await write.execute({ description: long, body: 'migration' }, {})
  const second = await write.execute({ description: long.replace('scheduled', 'planned'), body: 'migration' }, {})
  const lines = await journalLines(fresh)
  assert.equal(lines.length, 1)
  // Everything after `<kind> <id> ` is the digest — the payload, here the
  // flagged node and its 381-char description, capped at 200 chars with an
  // ellipsis standing in for what was cut.
  const digest = lines[0].replace(new RegExp(`^\\S+ turn=s1 similar ${second.id} `), '')
  assert.equal(digest.length, 200)
  assert.ok(digest.endsWith('…'))
  assert.ok(digest.startsWith(`${first.id} — the Frankfurt region migration`))

  // Line separators an external writer left in a description fold to spaces:
  // the file is line-oriented, and a forged line is worse than a folded one.
  const node = await write.execute({ description: 'placeholder', body: 'x'.repeat(600) }, {})
  const nodeFile = path.join(fresh, node.id, 'node.md')
  const raw = await fsp.readFile(nodeFile, 'utf8')
  await fsp.writeFile(nodeFile, raw.replace('description: placeholder', 'description: split across the\rline'))
  // The out-of-band edit invalidated this Session's create-time hash. Re-read
  // the changed bytes before exercising the journal's line folding (F68, #129).
  await tools.get('memory_read').execute({ id: node.id }, {})
  const revised = await write.execute({ id: node.id, body: 'a wholly different subject: the loading dock gate code rotation' }, {})
  assert.equal(revised.stale_description, 'split across the\rline')
  const all = await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')
  assert.doesNotMatch(all, /[\r\u2028\u2029]/)
  assert.ok(all.includes(`stale_description ${node.id} split across the line\n`))

  // The cap falls INSIDE a surrogate pair here (120 astral chars = 240 code
  // units, the 200th of which is a low surrogate): the digest gives up the
  // whole character rather than emitting half of one.
  const astral = await write.execute({ description: '🚀'.repeat(120), body: 'y'.repeat(600) }, {})
  const rocket = await write.execute({ id: astral.id, body: 'an entirely separate matter: the loading dock gate code rotation' }, {})
  assert.equal(rocket.stale_description, '🚀'.repeat(120))
  const cut = (await journalLines(fresh)).find((line) => line.includes(`stale_description ${astral.id} `))
  assert.equal(cut.slice(cut.indexOf('🚀')), `${'🚀'.repeat(99)}…`)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F64: a journal that cannot be appended costs a warning, never the write', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f64-broken-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: 's3' })
  await settle()
  const write = tools.get('memory_write')
  const first = await write.execute({ description: 'the staging cluster is rebuilt nightly from the production snapshot', body: 'rebuild' }, {})
  // A directory where the journal file belongs: every append fails, exactly as
  // a read-only root would, and the write path must not notice.
  await fsp.mkdir(path.join(fresh, '.advisories'))
  const warnings = []
  const stderr = process.stderr.write
  process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true }
  let second
  try {
    second = await write.execute({ description: 'the staging cluster gets rebuilt nightly from a production snapshot', body: 'rebuild' }, {})
  } finally {
    process.stderr.write = stderr
  }
  // The write landed and still carries its advisory in the result.
  assert.equal(second.created, true)
  assert.deepEqual(second.similar.map((m) => m.id), [first.id])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not append 1 advisory line to .*\.advisories/)
  assert.match(warnings[0], /The write itself landed\./)
  // Nor may the warning itself break the write: a harness that replaced stderr
  // with something that throws is not the write path's problem.
  process.stderr.write = () => { throw new Error('stderr is gone') }
  let third
  try {
    third = await write.execute({ description: 'the staging cluster is rebuilt each night from the production snapshot', body: 'rebuild' }, {})
  } finally {
    process.stderr.write = stderr
  }
  assert.equal(third.created, true)
  assert.ok(third.similar.length > 0, 'the advisory still rides the result')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F40 (#60): the injected section carries the orphan census, and drops it the
// moment every node is connected.
test('the memory section surfaces unlinked nodes and clears once they are wired', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-census-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = tools.get('memory_write')
  const index = () => variables.get('memory_index')()
  // An empty graph and a fully-linked graph say nothing about orphans.
  assert.doesNotMatch(index(), /unlinked memor/)
  const a = (await write.execute({ description: 'first island fact' }, {})).id
  const b = (await write.execute({ description: 'second island fact' }, {})).id
  const shown = index()
  assert.match(shown, /2 unlinked memories have no edges at all/)
  assert.match(shown, new RegExp(`  ${a} — first island fact`))
  assert.match(shown, new RegExp(`  ${b} — second island fact`))
  // Wiring the two to each other empties the census — byte-identical silence.
  await write.execute({ id: a, links: [b] }, {})
  assert.doesNotMatch(index(), /unlinked memor/)
  // One orphan again: singular phrasing, and the cap note only past the cap.
  const c = (await write.execute({ description: 'third island fact' }, {})).id
  assert.match(index(), new RegExp(`1 unlinked memory has no edges at all[^]*  ${c} — third island fact`))
  assert.doesNotMatch(index(), /more — memory_search/)
  // Five orphans: three shown, the remainder counted.
  for (const n of ['fourth', 'fifth', 'sixth', 'seventh']) await write.execute({ description: `${n} island fact` }, {})
  const many = index()
  assert.match(many, /5 unlinked memories have no edges at all/)
  assert.match(many, /…2 more — memory_search "" lists the whole graph/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F60 (#105): the zero-write marker was write-only forensics — nobody read it
// until an operator went looking. The injected section now reports recent
// entries, so the next session (which may be the only party that still knows
// what those turns covered) is told the content is missing.
test('the memory section reports recent zero-write turns and stays silent otherwise', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-zerowrite-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const index = () => variables.get('memory_index')()
  const marker = path.join(fresh, '.zero-write-turns')
  const at = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  const entry = (daysAgo, turn) => `${at(daysAgo)} pid=4242${turn ? ` turn=${turn}` : ''} zero memory_write calls\n`
  // No marker at all: byte-identical silence.
  assert.doesNotMatch(index(), /exited without writing/)
  // One recent entry: singular, and the notice points at the file, never dumps it.
  await fsp.writeFile(marker, entry(1, '127521/s2'))
  const one = index()
  assert.match(one, /1 memory turn in the last 7 days exited without writing anything \(see \.zero-write-turns at the graph root\) — if you know what those conversations covered, store it; search first, an earlier session may already have\. Content from those turns is otherwise lost\./)
  assert.doesNotMatch(one, /pid=4242/, 'the notice is a count and a pointer, never a line of the file')
  assert.doesNotMatch(one, /127521/)
  assert.equal(one.split('\n').filter((line) => line.includes('exited without writing')).length, 1, 'one line, always')
  // Four entries, one of them stale: only the three inside the window count.
  await fsp.writeFile(marker, entry(6) + entry(8, '410001/s6') + entry(2) + entry(0))
  assert.match(index(), /3 memory turns in the last 7 days exited without writing/)
  // Everything past the window: silence again, the notice clears itself.
  await fsp.writeFile(marker, entry(9) + entry(40) + entry(365))
  assert.doesNotMatch(index(), /exited without writing/)
  // A marker dated far in the FUTURE is a skewed clock, not a recent loss —
  // counting it would pin the notice open until its own date came round.
  await fsp.writeFile(marker, entry(-30) + entry(-400))
  assert.doesNotMatch(index(), /exited without writing/)
  // Mild skew still counts: the tolerance on that side is the window itself.
  await fsp.writeFile(marker, entry(-1))
  assert.match(index(), /1 memory turn in the last 7 days exited without writing/)
  // An empty marker, and a marker of garbage, are both silence — this reader
  // parses only the leading instant and never trusts the rest of the line.
  await fsp.writeFile(marker, '')
  assert.doesNotMatch(index(), /exited without writing/)
  await fsp.writeFile(marker, 'not a marker line at all\n\n   \n')
  assert.doesNotMatch(index(), /exited without writing/)
  // Past the display cap the count stops being exact; the file keeps the truth.
  await fsp.writeFile(marker, entry(1).repeat(25))
  assert.match(index(), /20\+ memory turns in the last 7 days exited without writing/)
  // The notice rides after the index and the census, not instead of them.
  await tools.get('memory_write').execute({ description: 'a fact stored despite the lost turns' }, {})
  const full = index()
  assert.match(full, /a fact stored despite the lost turns[^]*unlinked memory has no edges[^]*20\+ memory turns/)
  // End to end against the real producer: the reader parses what the F46/F48
  // exit hook actually writes, not what this test thinks it writes.
  await fsp.rm(marker)
  assert.doesNotMatch(index(), /exited without writing/)
  const dead = forkModule(`
    const { apply } = await import(${JSON.stringify(LIB_URL)})
    apply({ tools: { register: () => () => {} }, inject: () => {} }, { graphRoot: ${JSON.stringify(fresh)}, expectWrite: true, turnId: '127521/s2' })
  `)
  assert.equal(dead.status, 0)
  assert.match(index(), /1 memory turn in the last 7 days exited without writing/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F60 (#105): the notice reads a dotfile, not the graph — so it must survive
// the index scan failing, which is precisely when a graph is losing content.
// And the tail read must not lose an entry to its own cut, or hang the
// synchronous assembly path on something that is not a regular file.
test('the zero-write notice survives an unreadable index, a huge marker and a fifo', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-zerowrite2-'))
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const index = () => variables.get('memory_index')()
  const marker = path.join(fresh, '.zero-write-turns')
  const entry = (daysAgo, pad = '') => `${new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()} pid=4242${pad ? ` turn=${pad}` : ''} zero memory_write calls\n`
  // A marker past the 64 KiB tail: the entries inside the window still count,
  // and the entry the cut lands in is dropped rather than parsed as one.
  const filler = entry(30, 'x'.repeat(200))
  await fsp.writeFile(marker, filler.repeat(Math.ceil((64 * 1024) / filler.length) + 10) + entry(1) + entry(1))
  assert.match(index(), /2 memory turns in the last 7 days exited without writing/)
  // The cut landing exactly ON a line boundary must not eat a whole entry.
  // Build the last 64 KiB as exactly two whole lines — the recent one first,
  // then a stale one padded to fill the window — so the tail begins where an
  // entry does. A reader that always drops its first line would lose the only
  // recent entry here and report nothing.
  const recent = entry(1)
  const stale = entry(30)
  const pad = 64 * 1024 - recent.length - stale.length - ' turn='.length
  const tail = recent + entry(30, 'x'.repeat(pad))
  assert.equal(tail.length, 64 * 1024, 'the tail window is exactly two whole lines')
  await fsp.writeFile(marker, entry(60) + tail)
  assert.match(index(), /1 memory turn in the last 7 days exited without writing/)
  // A line with no separator at all is a truncated entry, not an entry: a
  // recent timestamp plus one garbage character must NOT be read as a
  // timestamp field (chopping the last character would make it parse), and the
  // well-formed entries around it must still count.
  const truncated = `${new Date(Date.now() - 864e5).toISOString()}x\n`
  await fsp.writeFile(marker, truncated)
  assert.doesNotMatch(index(), /exited without writing/)
  await fsp.writeFile(marker, entry(1) + truncated + entry(2))
  assert.match(index(), /2 memory turns in the last 7 days exited without writing/)
  // The index scan failing must not take the loss signal with it: a root that
  // can be traversed but not listed breaks the scan while the marker inside it
  // still opens by name — the exact moment a graph is losing content.
  await fsp.writeFile(marker, entry(1))
  await fsp.chmod(fresh, 0o111)
  const degraded = index()
  await fsp.chmod(fresh, 0o755)
  assert.match(degraded, /\(memory index unavailable: /, 'the scan really did fail')
  assert.match(degraded, /1 memory turn in the last 7 days exited without writing/)
  // A fifo in the marker's place must not hang prompt assembly (O_NONBLOCK),
  // and a symlink must not redirect the read (O_NOFOLLOW) — both are silence.
  await fsp.rm(marker)
  execFileSync('mkfifo', [marker])
  assert.doesNotMatch(index(), /exited without writing/)
  await fsp.rm(marker)
  const elsewhere = path.join(fresh, 'elsewhere.log')
  await fsp.writeFile(elsewhere, entry(1))
  await fsp.symlink(elsewhere, marker)
  assert.doesNotMatch(index(), /exited without writing/)
  await fsp.rm(marker)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F30 (#50): memory_attach captures by reference through `from_path`, and the
// two sources are exactly-one-of.
test('memory_attach from_path copies the file, leaves the source, defaults the name, and demands one source', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachref-'))
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachloose-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, attachFromPathRoots: [outside] })
  await settle()
  const attachTool = tools.get('memory_attach')
  const { id } = await tools.get('memory_write').execute({ description: 'thread with a loose transcript' }, {})
  const loose = path.join(outside, 'discussion.md')
  await fsp.writeFile(loose, 'the whole discussion, kept, not a summary\n')
  const copied = await attachTool.execute({ id, from_path: loose }, {})
  assert.deepEqual(copied, { id, file: 'discussion.md', bytes: 42, status: 'created', copied_from: loose })
  assert.match(attachTool.output.render({}, copied)[0].text, /copied from/)
  assert.doesNotMatch(attachTool.output.render({}, copied)[0].text, /moved/)
  // The source is left exactly where and as it was (security fix: a
  // model-chosen path must never be consumed).
  assert.equal(await fsp.readFile(loose, 'utf8'), 'the whole discussion, kept, not a summary\n')
  // The copied bytes read back through the normal read path.
  const back = await tools.get('memory_read_file').execute({ id, file: 'discussion.md' }, {})
  assert.equal(back.content, 'the whole discussion, kept, not a summary\n')
  // Exactly one source: both and neither are named contradictions.
  await assert.rejects(() => attachTool.execute({ id, filename: 'x.md', content: 'x', from_path: loose }, {}), /exactly one of/)
  await assert.rejects(() => attachTool.execute({ id, filename: 'x.md' }, {}), /exactly one of/)
  // `content` still requires an explicit filename.
  await assert.rejects(() => attachTool.execute({ id, content: 'x' }, {}), /`filename` is required with `content`/)
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
})

// Security review (2026-10-19): from_path is confined by deployment config —
// `attachFromPath` (on/off, default on) and `attachFromPathRoots` (default:
// the working directory and the home directory). Refusals name the reason,
// never the file's contents, and never touch the source.
test('memory_attach from_path obeys attachFromPath and attachFromPathRoots', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-roots-plugin-'))
  const allowed = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-roots-allowed-'))
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-roots-elsewhere-'))
  const secret = 'TOP-SECRET-CONTENT-7f3a'
  const inside = path.join(allowed, 'handover.md')
  const outsideFile = path.join(elsewhere, 'handover.md')
  await fsp.writeFile(inside, `handover ${secret}\n`)
  await fsp.writeFile(outsideFile, `handover ${secret}\n`)
  const before = await Promise.all([inside, outsideFile].map((file) => fsp.stat(file)))
  const untouched = async () => {
    for (const [i, file] of [inside, outsideFile].entries()) {
      assert.equal(await fsp.readFile(file, 'utf8'), `handover ${secret}\n`)
      assert.equal((await fsp.stat(file)).mtimeMs, before[i].mtimeMs)
    }
  }
  // Configured roots: inside passes, outside is refused by name.
  const on = await nextTurn(fresh, { attachFromPathRoots: [allowed] })
  const { id } = await on.get('memory_write').execute({ description: 'handover thread' }, {})
  const copied = await on.get('memory_attach').execute({ id, from_path: inside }, {})
  assert.equal(copied.copied_from, inside)
  const refused = await on.get('memory_attach').execute({ id, from_path: outsideFile, filename: 'other.md' }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /not under an allowed source directory/)
  assert.doesNotMatch(refused.message, new RegExp(secret), 'a refusal never echoes the file')
  assert.match(on.get('memory_attach').description, /allowed source directories/)
  // Default roots: the working directory and the home directory — a temp
  // file outside both is refused, and the message names them.
  const defaults = await nextTurn(fresh)
  const defaultRefusal = await defaults.get('memory_attach').execute({ id, from_path: outsideFile, filename: 'other.md' }, {}).then(() => undefined, (error) => error)
  assert.match(defaultRefusal.message, /not under an allowed source directory/)
  assert.ok(defaultRefusal.message.includes(os.homedir()), 'home is a default root')
  assert.ok(defaultRefusal.message.includes(process.cwd()), 'the working directory is a default root')
  // Switched off: every from_path call is refused before anything is read,
  // even a file under an allowed root, and the schema says so.
  const off = await nextTurn(fresh, { attachFromPath: false, attachFromPathRoots: [allowed] })
  await assert.rejects(() => off.get('memory_attach').execute({ id, from_path: inside, filename: 'again.md' }, {}), /`from_path` is disabled in this deployment/)
  assert.match(off.get('memory_attach').parameters.properties.from_path.description, /disabled in this deployment/)
  // `content` still works with the switch off.
  const viaContent = await off.get('memory_attach').execute({ id, filename: 'typed.md', content: 'typed by hand' }, {})
  assert.equal(viaContent.status, 'created')
  await assert.rejects(() => off.get('memory_read_file').execute({ id, file: 'again.md' }, {}))
  await untouched()
  // Bad config fails loud at load; the filesystem root is never a root.
  for (const [config, pattern] of [
    [{ attachFromPath: 'yes' }, /`attachFromPath` must be a boolean/],
    [{ attachFromPathRoots: '~/notes' }, /`attachFromPathRoots` must be an array/],
    [{ attachFromPathRoots: [''] }, /`attachFromPathRoots` must be an array/],
    [{ attachFromPathRoots: ['/'] }, /must not include the filesystem root/],
  ]) {
    const { ctx } = fakeCtx()
    assert.throws(() => apply(ctx, { graphRoot: fresh, ...config }), pattern)
  }
  for (const dir of [fresh, allowed, elsewhere]) await fsp.rm(dir, { recursive: true, force: true })
})

// F38 (#58): the handoff banner is its own template slot above the index, and
// closing the handoff clears it.
test('the memory section pins open handoffs above the index until they are closed', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-pin-'))
  const { ctx, tools, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  // The slot sits immediately above the index heading in the section text.
  assert.match(renderSection({ sections, variables }, { keep: ['memory_handoffs'] }), /\{\{memory_handoffs\}\}Memory index/)
  const banner = () => variables.get('memory_handoffs')()
  assert.equal(banner(), '')
  const write = tools.get('memory_write')
  await write.execute({ description: 'plain fact', type: 'journal' }, {})
  assert.equal(banner(), '')
  const open = (await write.execute({ description: 'replay harness half wired, next: isolate.yml', type: 'handoff' }, {})).id
  const pinned = banner()
  assert.match(pinned, /^Open handoff — unfinished work left for this session/)
  assert.match(pinned, new RegExp(`  ${open} — replay harness half wired`))
  assert.match(pinned, /\n\n$/) // trailing blank line so the index heading stays separated
  // Superseding the handoff clears the banner on the next assembly.
  await write.execute({ description: 'replay harness wired and verified', type: 'journal', supersedes: open }, {})
  assert.equal(banner(), '')
  // Plural phrasing, and NO cap: search cannot filter by type, so a hidden
  // row would be unreachable — every open handoff is listed.
  for (let i = 0; i < 6; i++) await write.execute({ description: `open thread ${i}`, type: 'handoff' }, {})
  const many = banner()
  assert.match(many, /^Open handoffs — /)
  for (let i = 0; i < 6; i++) assert.match(many, new RegExp(`open thread ${i}`))
  assert.doesNotMatch(many, /more/)
  // Retyping one of them shrinks the census; the section bullet teaches this close-out.
  assert.match(renderSection({ sections, variables }), /type: handoff.*pinned above this index/s)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F53 (#89): three consecutive replays each stamped their OWN run date onto a
// reminder the conversation set on an explicit in-segment anchor ("今天是
// 2026-08-20") — v1 wrote 08-22, v2 08-24, v3 08-25. The rule is therefore
// unconditional (the stated anchor was there and lost every time), and a
// caller who knows when the conversation happened supplies the date for the
// segments that state none.
test('F53: the section separates the runtime clock from the events clock', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const text = renderSection({ sections, variables }, { keep: ['memory_today', 'memory_context_date'] })
  // The runtime clock keeps its slot and its meaning: bookkeeping, not events.
  assert.match(text, /Today is \{\{memory_today\}\} — your own clock, and the date for `created:`\/`updated:` bookkeeping\./)
  assert.equal(variables.get('memory_today')(), `${today()} (${weekdayName(today())})`)
  // The rule ships on every turn, contextDate or not, and states ONE
  // precedence: the date the conversation states beats a supplied one beats
  // today. A supplied date that could overrule a stated anchor would recreate
  // F53 with a different wrong date (a trace crossing midnight, a segment that
  // names its own day) — so the order is asserted, not just the words.
  assert.match(text, /Your clock is not the events' clock: date events from the date the conversation states for itself; failing that, from one supplied for it above; failing both, from today\./)
  // The relative-date bullet defers to that rule instead of naming "today".
  const bullet = text.split('\n').find((line) => line.includes('Write dates absolute'))
  assert.match(bullet, /resolve them against the conversation's date — the rule below says which date that is —/)
  assert.doesNotMatch(bullet, /against today's date/)
  // The supplied date is a template slot directly above the rule, so it reads
  // as the conversation's clock rather than as another bullet.
  assert.match(text, /\{\{memory_context_date\}\}Your clock is not the events' clock/)
  assert.ok(variables.has('memory_context_date'), 'the section references a variable it must also register')
  // Unset: nothing is supplied, so the assembled section is exactly what a
  // live turn saw before this feature existed.
  assert.equal(variables.get('memory_context_date')(), '')
})

test('F53: a configured contextDate is stated as the conversation\'s date', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, contextDate: '2026-08-20' })
  assert.equal(variables.get('memory_context_date')(), "This conversation's date: 2026-08-20 (Thursday) — date events against it, not against today.\n")
  // The runtime clock is untouched — `created:`/`updated:` stay bookkeeping.
  assert.equal(variables.get('memory_today')(), `${today()} (${weekdayName(today())})`)
  // Assembled, the two clocks sit on consecutive lines with the rule below —
  // and the rule below is what tells the writer that a date the conversation
  // states for itself outranks this supplied one.
  const assembled = sections[0].text.replace(/\{\{(\w+)\}\}/g, (_, key) => (variables.has(key) ? variables.get(key)() : ''))
  assert.match(assembled, new RegExp(`Today is ${today()} \\(${weekdayName(today())}\\) — your own clock[^\\n]*\\nThis conversation's date: 2026-08-20 \\(Thursday\\) — date events against it, not against today\\.\\nYour clock is not the events' clock: date events from the date the conversation states for itself; failing that, from one supplied for it above;`))
  // No date literal ever enters the section template itself (ledger #20) — the
  // supplied date reaches the prompt only through the variable.
  assert.doesNotMatch(sections[0].text, /\d{4}-\d{2}-\d{2}/)
})

test('F53: contextDate must be a real YYYY-MM-DD date', () => {
  for (const bad of [42, true, '', null, ['2026-08-20'], { date: '2026-08-20' }, '2026-8-20', '20260820', 'yesterday', '2026-08-20T00:00:00Z', ' 2026-08-20', '2026-08-20 ', '2026-08-20\n', '2026-08-20\n2026-08-21', '今天']) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, contextDate: bad }), /`contextDate` must be a YYYY-MM-DD date/)
  }
  // Well-shaped but impossible: Date rolls 02-30 into March, which would put a
  // date the caller never meant into the prompt.
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-08-32']) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, contextDate: bad }), /`contextDate` must be a real calendar date/)
  }
  // Real dates, leap day included, load fine.
  for (const good of ['2026-08-20', '2024-02-29', '1999-12-31']) apply(fakeCtx().ctx, { graphRoot: root, contextDate: good })
})

// F67 option 1.5 (#121): the calendar strip — weekday resolution becomes a
// lookup. Option 1's annotation fixed only plugin-rendered anchors; a
// conversation-STATED date has no parenthesis and CN weekday phrases against
// one still resolved +1 (0/3 across two QA rounds). The strip covers ±14 days
// around today AND the supplied date, Mon-first, full ISO per cell.
test('the calendar strip covers both anchors with correct weekdays (F67, #121)', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, contextDate: '2026-08-21' })
  assert.match(renderSection({ sections, variables }), /never compute a weekday in your head/)
  assert.match(renderSection({ sections, variables }, { keep: ['memory_calendar'] }), /\{\{memory_calendar\}\}/)
  const strip = variables.get('memory_calendar')()
  for (const row of strip.split('\n')) {
    if (row === '⋮ (weeks omitted)') continue // distant anchors intentionally omit intervening weeks
    const cells = row.split('  ')
    assert.equal(cells.length, 7, row)
    assert.match(cells[0], /^Mon /)
    for (const cell of cells) {
      const [name, iso] = cell.split(' ')
      assert.equal(weekdayName(iso).slice(0, 3), name, cell)
    }
  }
  assert.match(strip, new RegExp(`${today()} ←today`))
  assert.match(strip, /Fri 2026-08-21 ←conversation's date/)
  // The window reaches at least 14 days beyond both anchors in both directions.
  const isos = strip.match(/\d{4}-\d{2}-\d{2}/g)
  const DAY = 864e5
  assert.ok(Date.parse(`${isos[0]}T00:00:00Z`) <= Date.parse('2026-08-21T00:00:00Z') - 14 * DAY)
  assert.ok(Date.parse(`${isos[isos.length - 1]}T00:00:00Z`) >= Date.parse(`${today()}T00:00:00Z`) + 14 * DAY)
  // Unset contextDate: strip renders around today alone, no conversation marker.
  const solo = fakeCtx()
  apply(solo.ctx, { graphRoot: root })
  const soloStrip = solo.variables.get('memory_calendar')()
  assert.ok(!soloStrip.includes('←conversation'))
  assert.match(soloStrip, new RegExp(`${today()} ←today`))
  assert.ok(!soloStrip.includes('omitted'), 'a single anchor never needs a gap')
  // The off-calendar fallback is stated next to the lookup order.
  assert.match(renderSection({ sections, variables }), /do not guess: store the phrase with its anchor verbatim/)
  // ledger #20 still holds: the fallback example carries no date literal to copy.
  // The rendered strip is nothing BUT dates, so the check reads the section with
  // the strip and today's clock left as slots — the same source the assertion
  // examined before #263 moved the write-time bullets behind slots.
  assert.doesNotMatch(renderSection({ sections, variables }, { keep: ['memory_calendar', 'memory_today', 'memory_context_date'] }), /\d{4}-\d{2}-\d{2}/)
})

// The codex catch on #124: a far-away contextDate must yield two bounded
// windows with a gap marker, never every intervening week (a 1999 date would
// otherwise put ~1,400 rows into every prompt).
test('the calendar strip stays bounded for a distant contextDate (F67, #121)', async () => {
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, contextDate: '1999-12-31' })
  const strip = variables.get('memory_calendar')()
  const rows = strip.split('\n')
  assert.ok(rows.length <= 11, `rows=${rows.length}`)
  assert.equal(rows.filter((r) => r.includes('omitted')).length, 1)
  assert.match(strip, /Fri 1999-12-31 ←conversation's date/)
  assert.match(strip, new RegExp(`${today()} ←today`))
  const gap = rows.findIndex((r) => r.includes('omitted'))
  assert.ok(rows[gap - 1].includes('1999') || rows[gap - 1].includes('2000'))
  assert.ok(!rows[gap + 1].includes('1999') && !rows[gap + 1].includes('2000'))
})

// F70 (#149): the mega-hub disease — one node accreting topic after topic
// (~22% of a corpus in one 3-line roster hub, synthetic audit demo-01) — gets a
// write-time counterweight: the second-fact split rule in the guidance, a
// size/degree stat on the node just written, per-node read-back of the queued
// advisories, and a backlog threshold that calls the headless maintain pass.

test('F70: the second-fact split rule lives in the section and the write tool', async () => {
  const { ctx, sections, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.startsWith('- One node, one topic'))
  assert.ok(bullet, 'the split bullet is present')
  assert.match(bullet, /SECOND fact about that topic/)
  // The safe shape is stated: the child is created WITH links, never orphaned.
  assert.match(bullet, /`links` naming the old node/)
  assert.match(bullet, /born connected/)
  assert.match(tools.get('memory_write').description, /SECOND fact about that topic arrives, extract both into a new node created with `links`/)
})

test('F70: a body past the node-size cap draws the split-into-children advisory', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-nodesize-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const big = 'hardware roster staffing onboarding vendor detail\n'.repeat(100)
  const stored = await write.execute({ description: 'accreting roster hub', body: big }, {})
  assert.equal(stored.node_size, big.length)
  const text = write.output.render({}, stored)[0].text
  // The fix names the split rule's safe shape: a child born linked to this node.
  assert.match(text, new RegExp(`links: \\["${stored.id}"\\]`))
  assert.match(text, /several topics/)
  // Distinct from the F21 attachment nudge, which also fires here — different fix.
  assert.equal(stored.long_body, big.length)
  assert.match(text, /Long body/)
  // Mirrored to the journal like every advisory (F64): kind, node, payload.
  assert.match(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), new RegExp(` node_size ${stored.id} ${big.length} chars`))
  // AT the cap the advisory stays silent.
  const atCap = await write.execute({ description: 'exactly at the cap', body: 'x'.repeat(4000) }, {})
  assert.equal(atCap.node_size, undefined)
  assert.doesNotMatch(write.output.render({}, atCap)[0].text, /several topics/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F70: a node written past the degree cap draws the hub advisory, on every write shape', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-nodedegree-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const peers = []
  for (let i = 0; i < 13; i++) peers.push((await write.execute({ description: `distinct peer fact number ${i}` }, {})).id)
  // At the cap (12 edges): silent — a genuine index node is not yet a hub.
  const under = await write.execute({ description: 'index node at the cap', links: peers.slice(0, 12) }, {})
  assert.equal(under.node_degree, undefined)
  // Past it, on a create: the count and the render fire.
  const hub = await write.execute({ description: 'the accreting hub itself', links: peers }, {})
  assert.equal(hub.node_degree, 13)
  assert.match(write.output.render({}, hub)[0].text, /becoming a hub/)
  assert.match(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), new RegExp(` node_degree ${hub.id} 13 edges`))
  // And on a links-only update — links are exactly how a hub accretes.
  await tools.get('memory_read').execute({ id: under.id }, {})
  const grown = await write.execute({ id: under.id, links: [peers[12]] }, {})
  assert.equal(grown.node_degree, 13)
  // The peer's half (codex round 2): a symmetric edge grows BOTH ends, so a
  // child created pointing at a full node pushes it over the cap without it
  // ever being the written node — the child's own result must say so, journal
  // the finding about the PEER, and the peer's read must surface it.
  const child = await write.execute({ description: 'one more fact pointed at the full node', links: [under.id] }, {})
  assert.equal(child.node_degree, undefined, 'the child itself has one edge')
  assert.deepEqual(child.hub_links, [{ id: under.id, degree: 14 }])
  assert.match(write.output.render({}, child)[0].text, new RegExp(`This link pushed ${under.id} to 14 edges`))
  assert.match(await fsp.readFile(path.join(fresh, '.advisories'), 'utf8'), new RegExp(` node_degree ${under.id} 14 edges`))
  assert.ok((await tools.get('memory_read').execute({ id: under.id }, {})).advisories.some((row) => row.startsWith('node_degree (')))
  // Re-stating an existing link grows nothing, so it flags nothing.
  await tools.get('memory_read').execute({ id: child.id }, {})
  const restated = await write.execute({ id: child.id, links: [under.id] }, {})
  assert.equal(restated.hub_links, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F70: memory_read surfaces a node\'s queued advisories; clean nodes read as before', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-readback-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const bulk = 'oversized transcript payload line\n'.repeat(60)
  const stored = await write.execute({ description: 'node with findings', body: bulk }, {})
  const view = await read.execute({ id: stored.id }, {})
  assert.ok(Array.isArray(view.advisories), 'the queued finding rides the read result')
  assert.ok(view.advisories.some((row) => row.startsWith('long_body (')), JSON.stringify(view.advisories))
  assert.match(read.output.render({}, view)[0].text, /Maintenance advisories on this node/)
  // Bounded: only the newest NODE_ADVISORIES_SHOWN lines render. Each rewrite
  // journals long_body again (read first — the update path is gated).
  for (let i = 0; i < 5; i++) {
    await read.execute({ id: stored.id }, {})
    await write.execute({ id: stored.id, body: `${bulk}rev ${i}\n` }, {})
  }
  assert.equal((await read.execute({ id: stored.id }, {})).advisories.length, 5)
  // A node with no journal lines keeps its exact prior shape — no field at all.
  const clean = await write.execute({ description: 'clean tidy fact' }, {})
  const cleanView = await read.execute({ id: clean.id }, {})
  assert.equal(cleanView.advisories, undefined)
  assert.doesNotMatch(read.output.render({}, cleanView)[0].text, /Maintenance advisories/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F70: the read-back parses turn= lines and keeps spaced digests verbatim', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-readback-turn-'))
  const { ctx, tools } = fakeCtx()
  // A turnId carrying a space is the journal's hardest parse: it is escaped to
  // one token at write time (F64), and the read-back must skip it positionally
  // rather than swallow the kind or the node id.
  apply(ctx, { graphRoot: fresh, turnId: '420002/step 12' })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const stored = await write.execute({ description: 'pricing review still 检索中 for merchants', body: 'merchant pricing checkpoint: 检索中' }, {})
  await read.execute({ id: stored.id }, {})
  // The body resolves while the description keeps its placeholder — the F52
  // advisory fires, and its digest is the description VERBATIM, spaces and all.
  const revised = await write.execute({ id: stored.id, body: 'merchant pricing answer: tier A 0.6%, tier B 0.9%' }, {})
  assert.equal(revised.stale_description, 'pricing review still 检索中 for merchants')
  const view = await read.execute({ id: stored.id }, {})
  // The date is the journal's own (UTC) stamp — matched by shape, not
  // recomputed, so the assertion cannot straddle a midnight (codex round 2).
  assert.ok(view.advisories.some((row) => /^stale_description \(\d{4}-\d{2}-\d{2}\): pricing review still 检索中 for merchants$/.test(row)), JSON.stringify(view.advisories))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F70: the maintenance-due notice appears when the backlog crosses the threshold, not at N-1', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-backlog-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, maintenanceBacklog: 3 })
  await settle()
  const write = tools.get('memory_write')
  // Three writes, one journal line each (long_body; vocabularies fully
  // disjoint so no similar/link advisory adds a second line).
  const first = await write.execute({ description: 'alpha ingestion pipeline', body: 'alpha line\n'.repeat(200) }, {})
  assert.equal(first.maintenance_due, undefined)
  const second = await write.execute({ description: 'beta rollout checklist', body: 'beta step\n'.repeat(200) }, {})
  assert.equal(second.maintenance_due, undefined, 'at N-1 the write stays silent')
  const third = await write.execute({ description: 'gamma retro summary', body: 'gamma item\n'.repeat(200) }, {})
  assert.equal(third.maintenance_due, 3, 'the write that crosses the threshold says so')
  assert.match(write.output.render({}, third)[0].text, /Maintenance due: 3 advisories/)
  // The notice is a reading of the queue, never queued: a clean write reports
  // the same depth instead of growing it.
  const clean = await write.execute({ description: 'delta tidy note' }, {})
  assert.equal(clean.maintenance_due, 3)
  // 0 disables the trigger outright.
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: fresh, maintenanceBacklog: 0 })
  await settle()
  assert.equal((await off.tools.get('memory_write').execute({ description: 'epsilon quiet note' }, {})).maintenance_due, undefined)
  // And the config fails loud on a bad value, like every sibling.
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, maintenanceBacklog: -1 }), /`maintenanceBacklog` must be a non-negative integer/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: fresh, maintenanceBacklog: 'weekly' }), /`maintenanceBacklog` must be a non-negative integer/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F71 (#157): at turn granularity the writer invents assistant-failure
// episodes — "the assistant searched, found nothing, and honestly told the
// user" — on read-then-update of an open deliverable node whose turn resolved
// nothing. The plugin never sees the transcript, so the gate checks the
// assertion's SHAPE against the section's quote-or-nothing rule, never its
// truth.
test('F71: a new assistant-behaviour assertion with no quoted source draws the evidence-gate advisory', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-evidence-gate-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: 'batch2/turn-96' })
  await settle()
  const write = tools.get('memory_write')
  // The turn-96 fabrication, verbatim shape: a concrete searched-and-declined
  // episode nothing in the turn stated.
  const episode = '助手检索 2025-10-13～10-18 录音，仅找到10月17日两场，无相关录音。未生成报告，已如实告知。'
  const stored = await write.execute({ description: 'W42 综合分析报告状态', body: episode, type: 'thread' }, {})
  assert.equal(stored.created, true, 'the gate is advisory — the write always lands')
  assert.deepEqual(stored.unsourced_assertions, [episode], 'the unsupported line is named verbatim')
  const rendered = write.output.render({}, stored)[0].text
  assert.match(rendered, /asserts what the assistant did \(the line below\) without quoting a source/)
  assert.match(rendered, /Quote the EVENT verbatim/)
  assert.match(rendered, /状态未变/, 'the render names the sanctioned no-change line')
  assert.match(rendered, new RegExp(`\\n {2}${episode}$`))
  // F64: the gate rides the same journal as every sibling.
  const lines = (await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')).split('\n').filter((line) => line.includes(' unsourced_assertions '))
  assert.equal(lines.length, 1)
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=batch2/turn-96 unsourced_assertions ${stored.id} 助手检索`))
  // The cap: a body minting more than three episodes names exactly three.
  const four = await write.execute({
    description: 'W43 报告线程',
    body: ['助手检索了全部录音库。', '助手已告知用户无法继续。', '助手未生成周报。', '助手捏造内容后被用户纠正。'].join('\n'),
    type: 'thread',
  }, {})
  assert.equal(four.unsourced_assertions.length, 3)
  // #164's accepted miss, pinned so it stays a decision: a rule written as a
  // contingency draws the advisory. Five vocabulary definitions of
  // "conditional" were tried and each hid a real report (再次 frequency, 将
  // disposal, 需要的 noun modifier, 应 in 相应, 若 in a name), so the gate keeps
  // recall and eats this one.
  const rule = await write.execute({ description: '游泳馆提醒事件', body: '- 用户若再次提起，应如实告知助手无法设置系统提醒，并建议用户自行设置。' }, {})
  assert.deepEqual(rule.unsourced_assertions, ['- 用户若再次提起，应如实告知助手无法设置系统提醒，并建议用户自行设置。'], 'the accepted miss: a contingency rule still draws the advisory')
  // The reports those definitions used to swallow, each pinned by the reading
  // that broke its rule.
  const frequency = await write.execute({ description: 'W44 检索记录', body: '助手再次检索录音库并告知用户。' }, {})
  assert.deepEqual(frequency.unsourced_assertions, ['助手再次检索录音库并告知用户。'], '再次 is a frequency adverb, never a condition')
  const person = await write.execute({ description: '若曦会议记录检索', body: '助手搜索若曦的会议记录并告知用户，后续需要复核。' }, {})
  assert.deepEqual(person.unsourced_assertions, ['助手搜索若曦的会议记录并告知用户，后续需要复核。'], '若 is a name as readily as it is "if"')
  const english = await write.execute({ description: 'renewal archive search', body: 'The assistant searched the archive to determine if the customer will renew and informed the user.' }, {})
  assert.deepEqual(english.unsourced_assertions, ['The assistant searched the archive to determine if the customer will renew and informed the user.'], 'an if/will pair does not make a finished English report a rule')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F71: quoted sources, rules, no-change lines and other subjects all stay silent', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-evidence-silent-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const clean = await write.execute({
    description: 'W32 报告线程状态',
    body: [
      // A quoted span is the citation the rule asks for — provenance claimed.
      '助手已告知用户：「报告正文还在读取中」。',
      // A normative line states a rule, not an event (turn 6's gotcha shape).
      '严禁捏造会议记录；助手必须先检索真实材料。',
      // The sanctioned no-change close itself carries no assistant subject.
      '状态未变（turn 12 无新信息）。',
      // An event about someone else: subject required, 助手 absent.
      '用户确认已收到检索结果。',
    ].join('\n'),
    type: 'thread',
  }, {})
  assert.equal(clean.unsourced_assertions, undefined)
  // The English equivalents are the same shape and fire the same way.
  const english = await write.execute({ description: 'weekly report thread state', body: 'The assistant searched the archive and told the user nothing was found.' }, {})
  assert.deepEqual(english.unsourced_assertions, ['The assistant searched the archive and told the user nothing was found.'])
  // A quoted IDENTIFIER is a name, not an utterance (codex review): it must
  // not vouch for the assertion around it.
  const namedArtifact = await write.execute({ description: 'W42 检索状态', body: '助手检索了"W42"项目，未找到报告并已告知用户。' }, {})
  assert.deepEqual(namedArtifact.unsourced_assertions, ['助手检索了"W42"项目，未找到报告并已告知用户。'])
  // A quoted FILENAME is an artifact name in any script (codex pre-merge
  // review of #161): neither the CJK title nor the spaced name is the turn's
  // wording, so neither vouches for the sentence around it.
  const cjkFile = await write.execute({ description: '会议纪要检索状态', body: '助手检索了“会议纪要.pdf”但未找到结果。' }, {})
  assert.deepEqual(cjkFile.unsourced_assertions, ['助手检索了“会议纪要.pdf”但未找到结果。'])
  const spacedFile = await write.execute({ description: 'recording search state', body: 'The assistant searched "recording 17.mp3" but found nothing.' }, {})
  assert.deepEqual(spacedFile.unsourced_assertions, ['The assistant searched "recording 17.mp3" but found nothing.'])
  // The assistant as grammatical OBJECT is content, not a behaviour claim
  // (codex pre-merge review of #161): a request and a report both stay silent.
  const requested = await write.execute({ description: 'W42 检索请求', body: '用户要求助手检索 W42。' }, {})
  assert.equal(requested.unsourced_assertions, undefined, 'a request directed at the assistant is not an assertion about it')
  const reported = await write.execute({ description: 'search failure report', body: 'The user told the assistant that the search failed.' }, {})
  assert.equal(reported.unsourced_assertions, undefined, 'a report told TO the assistant is not an assertion about it')
  // But the assistant as ACTOR still fires, even beside an object mention,
  // and the was-corrected episode is a target shape, never a directed verb.
  const mixed = await write.execute({ description: 'W42 重新检索状态', body: '用户要求助手重新检索后，助手已检索并告知用户无结果。' }, {})
  assert.deepEqual(mixed.unsourced_assertions, ['用户要求助手重新检索后，助手已检索并告知用户无结果。'])
  const corrected = await write.execute({ description: '纪要说法更正', body: '用户纠正了助手关于会议纪要的说法。' }, {})
  assert.deepEqual(corrected.unsourced_assertions, ['用户纠正了助手关于会议纪要的说法。'])
  // A quoted single word is an utterance, not an id (codex pre-merge review
  // round 2): only a digit, a path character or caps make a quote a name.
  const shortQuote = await write.execute({ description: 'delivery confirmation state', body: 'The assistant told the user "Done".' }, {})
  assert.equal(shortQuote.unsourced_assertions, undefined, 'a quoted plain word is the citation the rule asks for')
  const capsQuote = await write.execute({ description: 'MAP regeneration state', body: 'The assistant told the user "MAP" was stale and found nothing else.' }, {})
  assert.deepEqual(capsQuote.unsourced_assertions, ['The assistant told the user "MAP" was stale and found nothing else.'], 'an all-caps quote is a name, not an utterance')
  // The aspect particle and the indefinite article direct just as much (codex
  // pre-merge review round 2).
  const particle = await write.execute({ description: '检索失败通报', body: '用户告诉了助手检索失败。' }, {})
  assert.equal(particle.unsourced_assertions, undefined, '了 after the directing verb still reads as directed AT the assistant')
  const article = await write.execute({ description: 'search failure relay', body: 'The user told an assistant that the search failed.' }, {})
  assert.equal(article.unsourced_assertions, undefined, 'an indefinite article still reads as directed AT the assistant')
  // Actor and event must share a CLAUSE (codex pre-merge review round 3):
  // line-wide co-occurrence flagged lines where the USER did the searching.
  const otherActor = await write.execute({ description: '配置与日志检索状态', body: '助手配置未变；用户搜索了日志。' }, {})
  assert.equal(otherActor.unsourced_assertions, undefined, 'the searcher is the user — a different clause, a different actor')
  const otherActorEnglish = await write.execute({ description: 'config and log search state', body: 'The assistant config is unchanged. The user searched the logs.' }, {})
  assert.equal(otherActorEnglish.unsourced_assertions, undefined, 'a latin sentence break separates actors too')
  // A description-only create was a clean bypass (codex round 3).
  const descOnly = await write.execute({ description: '助手检索档案后未找到报告并告知用户' }, {})
  assert.deepEqual(descOnly.unsourced_assertions, ['助手检索档案后未找到报告并告知用户'], 'the description is scanned with the body')
  // `never` describes history as often as it states a rule (codex review) —
  // it is not normative vocabulary, and the standalone found-nothing shape
  // is an event.
  const never = await write.execute({ description: 'archive search state', body: 'The assistant searched but never found the recording.' }, {})
  assert.deepEqual(never.unsourced_assertions, ['The assistant searched but never found the recording.'])
  const foundNothing = await write.execute({ description: '录音检索结论', body: '助手未找到任何相关录音。' }, {})
  assert.deepEqual(foundNothing.unsourced_assertions, ['助手未找到任何相关录音。'])
  // Logical lines split on every separator the graph layer recognizes (codex
  // review): a normative clause before U+2028 cannot vouch for the assertion
  // after it.
  const separated = await write.execute({ description: '材料规则与状态', body: '严禁捏造材料。\u2028助手检索后已告知用户无结果。' }, {})
  assert.deepEqual(separated.unsourced_assertions, ['助手检索后已告知用户无结果。'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F71: on update only the lines minted this write are flagged, never carried history', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-evidence-update-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const prior = '助手已告知用户 W32 报告初稿完成。'
  const node = await write.execute({ description: 'W32 报告交接', body: prior, type: 'handoff' }, {})
  assert.deepEqual(node.unsourced_assertions, [prior], 'the create names it once')
  await read.execute({ id: node.id }, {})
  // A faithful carry-forward plus a subjectless status line: nothing new.
  const carried = await write.execute({ id: node.id, body: `${prior}\n状态未变（turn 7 无新信息）。` }, {})
  assert.equal(carried.unsourced_assertions, undefined, 'carried history is not re-flagged')
  // A new episode appended to the same ledger is exactly the #157 shape.
  const minted = await write.execute({ id: node.id, body: `${prior}\n状态未变（turn 7 无新信息）。\n助手检索后发现无该周录音，无法生成，已告知用户。` }, {})
  assert.deepEqual(minted.unsourced_assertions, ['助手检索后发现无该周录音，无法生成，已告知用户。'], 'only the minted line is named')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F71: reading an open work-state node offers the sanctioned no-change close; closed and plain nodes read as before', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-nochange-close-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const handoff = await write.execute({ description: 'W32 报告交接', body: '- 报告正文 结果未返回', type: 'handoff' }, {})
  const marker = /状态未变（turn N 无新信息）/
  assert.match(read.output.render({}, await read.execute({ id: handoff.id }, {}))[0].text, marker)
  assert.match(read.output.render({}, await read.execute({ id: handoff.id }, {}))[0].text, /must quote the turn, or not be written at all/)
  const thread = await write.execute({ description: '演练许可调研线程', body: '7. KORVAL演示许可分类:检索中', type: 'thread' }, {})
  assert.match(read.output.render({}, await read.execute({ id: thread.id }, {}))[0].text, marker)
  // A plain node tracks no open work, and a superseded ledger is history.
  const plain = await write.execute({ description: 'Postgres 选型决定', body: '选择 Postgres。', type: 'decision' }, {})
  assert.doesNotMatch(read.output.render({}, await read.execute({ id: plain.id }, {}))[0].text, marker)
  // A body past the render cap shows only a prefix, and memory_write replaces
  // the WHOLE body — instructing an "append" there would order the blind tail
  // loss F62 guards against (codex review), so the truncated view stays quiet.
  const huge = await write.execute({ description: '超长交接账本', body: `- 报告 结果未返回\n${'x'.repeat(51000)}`, type: 'handoff' }, {})
  assert.doesNotMatch(read.output.render({}, await read.execute({ id: huge.id }, {}))[0].text, marker)
  await read.execute({ id: handoff.id }, {})
  await write.execute({ description: 'W32 报告已交付', body: '报告已交付，交接关闭。', supersedes: handoff.id }, {})
  assert.doesNotMatch(read.output.render({}, await read.execute({ id: handoff.id }, {}))[0].text, marker)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F71: the quote-or-nothing rule lives in the section beside the work-state bullets', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('A status line about what YOU, the assistant, did'))
  assert.ok(bullet, 'the status-line bullet is present')
  assert.match(bullet, /quote the turn's own words/)
  assert.match(bullet, /or it did not happen/)
  assert.match(bullet, /状态未变（turn N 无新信息）/, 'the bullet hands the writer the sanctioned no-change line')
})

// F72 (#152): the writer anchors vague user phrasing to specifics the user
// never gave — 「下周」 stored as a resolved week, 「暂不投广告」 grown a
// 「无时间表」. The plugin never sees the turn, so the gate checks the tell
// the evidence shows: the vague phrase surviving on the line beside the
// precision that resolved it.
test('F72: vague phrasing anchored to minted precision draws the advisory', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-minted-precision-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: 'audit/demo-01' })
  await settle()
  const write = tools.get('memory_write')
  // The synthetic anchored-date shape: the vague 下周 survives beside the resolved
  // week, in one clause, with no marker and no quote.
  const dated = '- **银行方案**：银行方将于**2026-09-02 起那周**（下周）给出方案'
  const stored = await write.execute({ description: '海外仓储银行开户排期变更', body: dated, type: 'decision' }, {})
  assert.equal(stored.created, true, 'the gate is advisory — the write always lands')
  assert.deepEqual(stored.minted_precision, [dated], 'the minted line is named verbatim')
  const rendered = write.output.render({}, stored)[0].text
  assert.match(rendered, /pairs a vague phrase with precision that resolves it \(the line below\)/)
  assert.match(rendered, /以<anchor date>为基准/, 'the render hands the writer the sanctioned anchor form')
  assert.ok(rendered.includes(`\n  ${dated}`), 'the render quotes the line')
  // The …F0BMTR shape: the minted qualifier is appended as its own clause,
  // so the qualifier arm is line-scoped.
  const qualified = await write.execute({ description: '贷款业务获客渠道', body: '- **广告投放**：暂时不投，无时间表', type: 'decision' }, {})
  assert.deepEqual(qualified.minted_precision, ['- **广告投放**：暂时不投，无时间表'])
  // The English equivalents are the same shape (an ASCII comma is not a
  // clause boundary, so the pair shares its clause).
  const english = await write.execute({ description: 'ads launch scheduling', body: 'Ads launch next week, the week of 2026-09-02.' }, {})
  assert.deepEqual(english.minted_precision, ['Ads launch next week, the week of 2026-09-02.'])
  // F64: the gate rides the same journal as every sibling.
  const journal = (await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')).split('\n').filter((line) => line.includes(' minted_precision '))
  assert.equal(journal.length, 3)
  assert.match(journal[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=audit/demo-01 minted_precision ${stored.id} `))
  // The cap: a body minting more than three pairs names exactly three.
  const four = await write.execute({
    description: '交付排期总览',
    body: ['下周一（2026-09-01）交付A方案', '下周二（2026-09-02）交付B方案', '下周三（2026-09-03）交付C方案', '下周四（2026-09-04）交付D方案'].join('\n'),
  }, {})
  assert.equal(four.minted_precision.length, 3)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: plain absolute dates, lone vague phrases, marked inferences, quotes and split clauses all stay silent', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-minted-silent-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const clean = await write.execute({
    description: '法务审核与排期决定记录',
    body: [
      // A bare absolute date is the CONVENTION, never a finding — the date
      // rules require resolved ISO dates, and nagging them would be a
      // regression.
      '项目截止 2026-09-05，已与团队确认。',
      '2026-08-26 决定：对外报价必须先经法务审核。',
      // Each half alone claims nothing the other minted.
      '下周给出银行方案。',
      '暂不投放广告。',
      '上线时间未定。',
      // 未定义 is the software word, 下周期 is "next cycle", 周年 is an
      // anniversary.
      '暂不上线：接口协议未定义。',
      '下周期报表汇总于 2026-09-02 生成。',
      '那周年庆活动定于 2026-09-02 举行。',
      // A dated ENTRY STAMP resolves nothing: the colon is a boundary for
      // the date arm.
      '更新于 2026-08-27：下周复盘投放安排。',
      // An inference marked as one IS the sanctioned fix, in both forms.
      '推断：下周 即 2026-09-02 起那周。',
      '下周三, 以2026-08-26为基准。',
      // A quoted utterance is provenance claimed, exactly as in F71.
      '用户原话「下周上线，2026-09-02 那周」。',
      // A date and a vague phrase in different clauses are different facts.
      '会议定于 2026-09-01；下周再讨论投放安排。',
      // 未定 only counts standalone (codex pre-merge review of #162): every
      // Han character after it makes a different word.
      '方案尚未定稿，暂不发布。',
      '字段未定义，暂时不接入。',
      // #164: 「<date>那周」 is "the week of <date>" — the date is the
      // anchor, 那周 its tail, and nothing was resolved. All 7 round-11
      // fires were this shape. 日/号 end a date too.
      '待交付：2025-09-22那周会议报告.md（ORBA续约+阿根廷议题）',
      '用户于2026-08-20要求整理2025年9月22日那周的会议报告，涵盖：',
      '9月22号那周的会议报告已于 2026-08-28 关闭。',
    ].join('\n'),
  }, {})
  assert.equal(clean.minted_precision, undefined)
  // The accepted miss on the other side of that lookbehind (#164): the
  // space-separated anchor still fires. The corpus's only instance is an
  // explicit 推断 line the inference marker already silences, and widening
  // the lookbehind over whitespace would start eating real resolutions.
  const spaced = await write.execute({ description: '交付排期', body: '交付定在 2026-09-08 那周。' }, {})
  assert.deepEqual(spaced.minted_precision, ['交付定在 2026-09-08 那周。'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: on update only the lines minted this write are flagged, never carried history', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-minted-update-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const prior = '银行方将于**2026-09-02 起那周**（下周）给出方案'
  const node = await write.execute({ description: '开户排期线程', body: prior, type: 'thread' }, {})
  assert.deepEqual(node.minted_precision, [prior], 'the create names it once')
  await read.execute({ id: node.id }, {})
  const carried = await write.execute({ id: node.id, body: `${prior}\n方案已于 2026-09-03 收到。` }, {})
  assert.equal(carried.minted_precision, undefined, 'carried history and a plain dated line are not flagged')
  const minted = await write.execute({ id: node.id, body: `${prior}\n方案已于 2026-09-03 收到。\n落地定在下周，即 2026-09-08 起那周。` }, {})
  assert.deepEqual(minted.minted_precision, ['落地定在下周，即 2026-09-08 起那周。'], 'only the minted line is named')
  // A description-only update was a clean bypass of both gates (codex
  // pre-merge review of #162): the description is the retrieval surface.
  const descOnly = await write.execute({ id: node.id, description: '交付定在下周（2026-09-09 起那周）' }, {})
  assert.deepEqual(descOnly.minted_precision, ['交付定在下周（2026-09-09 起那周）'], 'a changed description is scanned too')
  const descCarried = await write.execute({ id: node.id, description: '交付定在下周（2026-09-09 起那周）' }, {})
  assert.equal(descCarried.minted_precision, undefined, 'the prior description is carried history, not a fresh mint')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: one line stated in both description and body spends one advisory slot (#162 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-minted-dedup-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const repeated = '交付定在下周（2026-09-02 起那周）'
  const node = await write.execute({
    description: repeated,
    body: [repeated, '暂不投广告，无时间表。'].join('\n'),
  }, {})
  assert.deepEqual(node.minted_precision, [repeated, '暂不投广告，无时间表。'], 'the repeat is named once, leaving room for the distinct line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #164: both gates are pure functions over text, but every tuning round so
// far argued about hypothetical inputs. `fixtures/gate-lines.json` vendors the
// lines that actually mattered — the 10 anchored 「<date>那周」 lines the
// minted gate fired on in round 11, the two conditional-future rule lines the
// evidence gate fired on, the turn-8 line whose blindness is documented and
// the writer's own quoted repair of it, the three v1 fabrications, #152's
// evidence line, and ordinary corpus lines that must stay silent — so the fire
// set is asserted against synthetic text offline, with no server and no replay.
// The eight synthetic entries are the shapes codex's review of #166 found
// the two gates mishandling across three rounds — every one of the silencer's
// false negatives reached through 再次, which is a frequency adverb and no
// longer a marker, plus the markdown-wrapped anchored date.
test('F71/F72: the gates hold their fire set over the vendored corpus lines (#164)', async () => {
  const fixture = JSON.parse(await fsp.readFile(new URL('../fixtures/gate-lines.json', import.meta.url), 'utf8'))
  assert.equal(fixture.lines.length, 86, 'the fixture has not silently lost entries')
  for (const { source, prior, turn, line, fires, why } of fixture.lines) {
    // The contradiction gate (F76, #173) takes two operands, so its fixture
    // entries carry the prior body line beside the new one; an entry without
    // `prior` has nothing stored to contradict and the gate stays out of its
    // fire set by construction.
    const actual = [
      ...(contradictedFigures(prior ?? '', line).length > 0 ? ['contradicted_figures'] : []),
      ...(mintedPrecisionLines(line).length > 0 ? ['minted_precision'] : []),
      // The evidence gate takes a third operand since F71.2 (#167): entries
      // carrying a `turn` exercise the quote-coverage test, and every entry
      // without one asserts the unchanged behavior — which is what makes this
      // file a before/after measurement of that change rather than a rewrite
      // of its own expectations.
      ...(unsourcedAssertionLines(line, '', turn ?? '').length > 0 ? ['unsourced_assertions'] : []),
    ]
    assert.deepEqual(actual, fires, `${source} (${why}): ${line}`)
  }
  // F76 (#173), stated as counts like the shapes below: the turn-87
  // displacement is the ONLY pair that fires, and every legitimate-revision
  // pair from the corpus stays silent — a rejection that blocks an honest
  // correction would be worse than the fabrication it guards against.
  const pairs = fixture.lines.filter(({ prior }) => prior !== undefined)
  assert.equal(pairs.length, 6)
  assert.deepEqual(pairs.filter(({ fires }) => fires.includes('contradicted_figures')).map(({ source }) => source),
    ['v4 turn-086 → turn-087'], 'exactly one pair fires: the measured displacement')
  // The two shapes #164 fixed, stated as counts so a widening regression is
  // loud: nothing anchored fires, and every v1 fabrication still does.
  const anchored = fixture.lines.filter(({ why }) => why.startsWith('anchored'))
  assert.equal(anchored.length, 10)
  assert.ok(anchored.every(({ fires }) => fires.length === 0))
  // Six now, not four: #167 vendored two more v1 lines — uncited deliveries the
  // subject branch walked past — beside the original fabrications. Every v1
  // line in the fixture draws the evidence gate, which is the invariant.
  const fabrications = fixture.lines.filter(({ source }) => source.startsWith('v1 turn-'))
  assert.equal(fabrications.length, 6)
  assert.ok(fabrications.every(({ fires }) => fires.includes('unsourced_assertions')))
  // A completed claim stays eligible however conditional the rest of the line
  // reads — the silencer must never swallow one (codex review of #166).
  const raised = fixture.lines.filter(({ source }) => source.startsWith('codex review'))
  assert.equal(raised.length, 11)
  assert.ok(raised.filter(({ line }) => line.includes('助手')).every(({ fires }) => fires.includes('unsourced_assertions')))
  // F71.1 (#167): the artifact-subject branch, stated the same way — the
  // round-12 fabrication fires with no actor anywhere in the line, and the
  // shapes that surround it in the same corpus stay silent. Both halves are
  // asserted, because a branch that fires on everything would pass the first.
  const turn6 = fixture.lines.filter(({ source }) => source === 'v3 turn-006')
  assert.equal(turn6.length, 3)
  assert.ok(turn6.filter(({ line }) => /报告|文档/.test(line)).every(({ fires }) => fires.includes('unsourced_assertions')),
    'the fabricated delivery claims fire without 助手 appearing anywhere')
  assert.ok(turn6.every(({ line }) => !line.includes('助手')), 'none of them names an actor — that is the point')
  const silent = fixture.lines.filter(({ why }) => why.startsWith('the ledger label') || why.startsWith('an open question') || why.startsWith('an identifier IS') || why.startsWith('a plan, not'))
  assert.equal(silent.length, 4)
  assert.ok(silent.every(({ fires }) => fires.length === 0), 'the four shapes that must survive the widening stay silent')
  // Chinese has no word boundary, so the artifact nouns match inside longer
  // words; the gap window and the other-actor guard are what stop them, and
  // both are pinned here rather than in a comment.
  const traps = fixture.lines.filter(({ source }) => source === 'self-review (F71.1)')
  assert.equal(traps.length, 4)
  assert.ok(traps.every(({ fires }) => fires.length === 0), 'no substring trap or reported-on-another-actor line fires')
  // The two bugs review found, kept as a pair each: a distractor artifact noun
  // before the real claim must not lose it, and a quote must survive the
  // clause split whatever punctuation it holds.
  // Round two: the boundary mask must not become the text the checks read, and
  // a leftmost completion must not hide a later real pair. All four fire.
  const round2 = fixture.lines.filter(({ source }) => source === 'sonnet review 2 (#167)')
  assert.equal(round2.length, 4)
  assert.ok(round2.every(({ fires }) => fires.includes('unsourced_assertions')), 'the mask hides nothing the gate must read')
  const reviewed = fixture.lines.filter(({ source }) => source === 'sonnet review (#167)')
  assert.equal(reviewed.length, 4)
  assert.ok(reviewed.filter(({ line }) => line.startsWith('用户说')).every(({ fires }) => fires.length === 0), 'quoted utterances stay silent')
  assert.ok(reviewed.filter(({ line }) => !line.startsWith('用户说')).every(({ fires }) => fires.includes('unsourced_assertions')), 'a distractor noun does not hide the claim')
  // F71.2 (#167): the quote-coverage half, stated as the measurement it is.
  // Exactly the entries carrying a `turn` can read differently than F71.1 left
  // them, and the round-13 repair line is vendored TWICE — with its turn and
  // without — so the pair pins both the catch and the degradation in one file.
  const withTurn = fixture.lines.filter(({ turn }) => turn !== undefined)
  assert.equal(withTurn.length, 9)
  const round13 = fixture.lines.filter(({ source }) => source.startsWith('v4 turn-006'))
  assert.equal(round13.length, 3)
  const repair = round13.filter(({ line }) => line.startsWith('用户说'))
  assert.equal(repair.length, 2, 'the same repair line, with the turn and without it')
  assert.deepEqual(repair.map(({ fires }) => fires), [['unsourced_assertions'], []],
    'the turn is the whole difference: the quote of the request vouches for nothing the line claims')
  assert.ok(repair.every(({ line }) => line.includes('「先念给我听听你写的内容」')),
    'both carry the real quote — this line satisfied the advisory it was answering')
  // The two halves codex found once F71.2 was in review, each pinned as the
  // pair that separates them: the same CJK filename must vouch across two turns
  // that bound it differently while a DIFFERENT one must not, and the English
  // arm must take an object without letting bare `read` start matching.
  const codex189 = fixture.lines.filter(({ source }) => source === 'codex #189 (F71.2)')
  assert.equal(codex189.length, 4)
  assert.deepEqual(codex189.map(({ fires }) => fires.length > 0), [true, false, true, false],
    'each finding is pinned by the pair that isolates it, not by its catch alone')
})

// F71.2 (#167, round 13): the gate was quote-SATISFIABLE. Turn 6 drew the
// advisory, and the writer's next call put the turn's words in 「」 exactly as
// asked while keeping the invented delivery — a cited fabrication, worse than
// the bare one, surviving to turn 120. The quote has to cover the claimed
// EVENT, which needs the turn as a second operand; #174 established it is
// readable and F79 already reads it.
test('F71.2: a quote of the user request stops vouching for a delivery the turn never names (#167)', () => {
  const repair = '用户说「先念给我听听你写的内容」，助手念出了《物流×仓储业务对接会议纪要》全文（日期2026-08-19）。'
  assert.equal(unsourcedAssertionLines(repair, '', '先念给我听听你写的内容').length, 1,
    'the turn names no 纪要, so the quote of the request is not provenance for the delivery')
  assert.equal(unsourcedAssertionLines(repair).length, 0,
    'no turn, no change: without the second operand the line reads exactly as F71.1 left it')
  assert.equal(unsourcedAssertionLines(repair, '', '把物流×仓储会议纪要念给我听').length, 0,
    'a turn that names the artifact leaves the citation standing')
  // Reading a deliverable aloud is the delivery event in this corpus, and the
  // artifact branch already knew it (念给 sits in ARTIFACT_DONE_RE) — the actor
  // branch was the only one that could watch 助手念出了… go past.
  assert.equal(unsourcedAssertionLines('助手念出了《物流×仓储业务对接会议纪要》全文。').length, 1,
    'the uncited form fires with no turn at all — the vocabulary gap is closed independently')
  // The two fences, so the coverage test cannot reach past its evidence.
  assert.equal(unsourcedAssertionLines('用户说「查一下上周的录音」，助手检索录音库后告知用户。', '', '别的事').length, 0,
    'a claim naming no artifact has no anchor, so its quote vouches as before')
  const twoArtifacts = '用户「帮我出个周报」的要求已完成：助手已生成周报并写回 report.md'
  assert.equal(unsourcedAssertionLines(twoArtifacts, '', '帮我出个周报').length, 0,
    'one named artifact in the turn is enough — the writer naming the file it wrote is not a fabrication')
  assert.equal(unsourcedAssertionLines(twoArtifacts, '', '随便说点别的').length, 1,
    'and a turn naming neither still fires, so the fence is not a blanket pass')
  // A line the prior body already carried is history before any of this runs.
  assert.equal(unsourcedAssertionLines(repair, repair, '先念给我听听你写的内容').length, 0,
    'carry-forward suppression comes first, unchanged')
  // Both sides read artifacts by the SAME rule (fable review). Two asymmetries
  // let an unrelated turn vouch, which is the shape this change exists to stop.
  assert.equal(unsourcedAssertionLines('The user said "take a look", and the assistant searched the logs and delivered the report.', '', 'the reporter called me').length, 1,
    'a bare includes() found `report` inside `reporter`')
  assert.equal(unsourcedAssertionLines('用户说「先看看」，助手检索日志后已生成 summary.md。', '', '把 todo.md 给我').length, 1,
    'an extension anchor is widened to the filename token, so two attachments are two anchors')
  // The lookbehind covers every character that takes 念 as a noun tail; the
  // class being short by one is a false FIRE, the expensive direction here.
  for (const trap of ['助手表示很想念给他讲课的老师。', '助手指出这种观念给用户带来了误解。', '助手的回答留下悬念给读者。', '助手指出概念出现偏差。']) {
    assert.equal(unsourcedAssertionLines(trap).length, 0, `substring trap fires: ${trap}`)
  }
  // A CJK filename is a filename (codex review of #189): `\w` is ASCII, so
  // 总结.md and 计划.md collapsed to the bare `.md` the widening exists to
  // prevent. The stem has no left edge to capture, so the anchors agree on the
  // part the capture bounded correctly — enough to tell two files apart, and
  // enough to recognize one file across two turns that introduce it differently.
  const cjkFile = '用户说「先看看」，助手检索日志后已生成总结.md。'
  assert.equal(unsourcedAssertionLines(cjkFile, '', '把计划.md 给我').length, 1, 'a different CJK filename does not vouch')
  assert.equal(unsourcedAssertionLines(cjkFile, '', '把总结.md 给我').length, 0, 'the same one does')
  assert.equal(unsourcedAssertionLines(cjkFile, '', '发我总结.md').length, 0, 'and still does when the turn bounds it differently')
  assert.equal(unsourcedAssertionLines('用户说「先看看」，助手检索日志后已生成 summary.md。', '', '把 salary.md 给我').length, 1,
    'ASCII stems keep exact equality — the loosening reaches only the capture that needed it')
  // The English arm takes an object, and the particle stays required.
  assert.equal(unsourcedAssertionLines('The assistant read the report aloud.').length, 1, 'read <object> aloud is a delivery')
  assert.equal(unsourcedAssertionLines('The assistant read the summary out loud.').length, 1, 'out loud too')
  assert.equal(unsourcedAssertionLines('The assistant read the docs before answering.').length, 0, 'bare read never starts matching')
})

test('F71.2: the write path and the standalone attach route both read the turn (#167)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-coverage-'))
  const setup = await nextTurn(fresh, { turnId: '167/step-1' })
  const claim = '用户说「先念给我听听你写的内容」，助手念出了《物流×仓储业务对接会议纪要》全文。'
  const node = await setup.get('memory_write').execute({
    description: 'W42 会议纪要',
    body: claim,
  }, execWithTurn('先念给我听听你写的内容'))
  assert.ok(advisoryKinds(node).includes('unsourced_assertions'),
    'the write path threads the real turn, so the cited fabrication draws the advisory')
  // The same content with no exec is the shipped F71.1 behavior — the plugin
  // never fails a write because a runtime withheld the turn.
  const quiet = await nextTurn(fresh, { turnId: '167/step-2' })
  const silent = await quiet.get('memory_write').execute({ description: 'W43 会议纪要', body: claim }, {})
  assert.ok(!advisoryKinds(silent).includes('unsourced_assertions'), 'no turn, no change')
  // F78 shipped the standalone route so it reports what the inline path
  // reports on identical content; that property has to survive a second
  // operand, or the bypass is back for anything the turn can decide.
  // On a node whose body does NOT already carry the line: the attach path's
  // prior side is the node's own description and body, so an attachment
  // repeating what the node states is history, not a new claim.
  const attaching = await nextTurn(fresh, { turnId: '167/step-3' })
  const host = await attaching.get('memory_write').execute({
    description: 'W44 会议纪要',
    body: 'W44 会议纪要的归档记录。',
  }, {})
  await attaching.get('memory_read').execute({ id: host.id }, {})
  const attached = await attaching.get('memory_attach').execute({
    id: host.id,
    filename: 'reading.md',
    content: claim,
  }, execWithTurn('先念给我听听你写的内容'))
  assert.ok((attached.unsourced_assertions ?? []).length > 0,
    'the standalone attach route reads the same turn the write path does')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F71.1: the gates read the inline attachment, on create and on an attach-only update (#167)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-scan-'))
  const setup = await nextTurn(fresh, { turnId: '168/step-1' })
  // The body is clean; the claim rides the PAYLOAD, which no gate read before
  // #167 — round 12 stored a 1,274-char invented report exactly this way.
  const node = await setup.get('memory_write').execute({
    description: 'W42 报告归档',
    body: 'W42 报告的归档记录。',
    attach: { filename: 'w42.md', content: '# W42\n助手检索录音库后告知用户本周无相关录音。' },
  }, {})
  assert.ok(advisoryKinds(node).includes('unsourced_assertions'), 'the create scans the attachment')

  // An attach-only update supplies neither body nor description, and used to
  // skip the gates entirely — the condition, not just the text, had to widen.
  const turn = await nextTurn(fresh, { turnId: '168/step-2' })
  await turn.get('memory_read').execute({ id: node.id }, {})
  const updated = await turn.get('memory_write').execute({
    id: node.id,
    attach: { filename: 'w42-v2.md', content: '报告已交付并写回文档。' },
  }, {})
  assert.ok(advisoryKinds(updated).includes('unsourced_assertions'), 'an attach-only update scans it too')

  // ...and it loads `prior` to do it (sonnet review of #167): an attach-only
  // call used to skip the node load entirely, so the prior side was empty and
  // an attachment repeating a line the node already carried was flagged as
  // newly minted. Carried history is not a new assertion.
  const third = await nextTurn(fresh, { turnId: '167/step-3' })
  await third.get('memory_read').execute({ id: node.id }, {})
  await third.get('memory_write').execute({ id: node.id, body: 'W42 报告的归档记录。\n助手检索录音库后告知用户本周无相关录音。' }, {})
  const fourth = await nextTurn(fresh, { turnId: '167/step-4' })
  await fourth.get('memory_read').execute({ id: node.id }, {})
  const carried = await fourth.get('memory_write').execute({
    id: node.id,
    attach: { filename: 'w42-v3.md', content: '助手检索录音库后告知用户本周无相关录音。' },
  }, {})
  assert.ok(!advisoryKinds(carried).includes('unsourced_assertions'),
    'an attachment restating a line the node body already carries is history, not a new claim')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The standalone tool is the other half of the same bypass (#167, round 13):
// with memory_write's inline path gated by #170, turn 6's fabricated document
// simply arrived through memory_attach instead — the one write route no gate
// had ever read. Same scan, same advisories, same journal line, whichever
// door a payload uses.
test('F71.1: the standalone memory_attach route reaches the gates too (#167)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-standalone-attach-scan-'))
  const setup = await nextTurn(fresh, { turnId: '167/attach-1' })
  const node = await setup.get('memory_write').execute({ description: 'W42 报告归档', body: 'W42 报告的归档记录。' }, {})
  const attachTool = setup.get('memory_attach')
  // A clean attach carries no advisory fields, renders the one line it always
  // rendered, and journals nothing. (Descriptively named since F82, #191 — a
  // generic name is itself an advisory now, and this case is the silent one.)
  const clean = await attachTool.execute({ id: node.id, filename: 'w42-预算口径.md', content: '会上确认了预算口径。\n' }, {})
  assert.equal(clean.unsourced_assertions, undefined)
  assert.equal(clean.minted_precision, undefined)
  assert.equal(clean.generic_filename, undefined)
  assert.deepEqual(validate(attachTool.output.schema, clean), [])
  assert.equal(attachTool.output.render({}, clean)[0].text, `Attached w42-预算口径.md on ${node.id} (${clean.bytes} bytes).`)
  // A payload claiming an assistant episode draws the F71 gate exactly as the
  // same text does in a body or an inline attach — and the file still landed:
  // the gate is advisory here as everywhere.
  const flagged = await attachTool.execute({ id: node.id, filename: 'w42.md', content: '# W42\n助手检索录音库后告知用户本周无相关录音。' }, {})
  assert.deepEqual(validate(attachTool.output.schema, flagged), [])
  assert.equal(flagged.unsourced_assertions.length, 1)
  const text = attachTool.output.render({}, flagged)[0].text
  assert.match(text, /^Attached w42\.md on /)
  assert.match(text, /asserts what the assistant did/)
  assert.match(text, /re-attach the full corrected file/)
  // The F72 sibling rides the same scan.
  const minted = await attachTool.execute({ id: node.id, filename: 'ads.md', content: 'Ads launch next week, the week of 2026-09-02.' }, {})
  assert.deepEqual(minted.minted_precision, ['Ads launch next week, the week of 2026-09-02.'])
  assert.match(attachTool.output.render({}, minted)[0].text, /pairs a vague phrase with precision/)
  // Journaled like every advisory the writer is shown (F64, #109).
  const journal = await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')
  assert.match(journal, new RegExp(` turn=167/attach-1 unsourced_assertions ${node.id} `))
  assert.match(journal, new RegExp(` turn=167/attach-1 minted_precision ${node.id} `))
  // The prior side is the node's own description and body, exactly as an
  // inline attach scans on update: an attachment restating a line the body
  // already carries is history, not a new claim.
  const turn = await nextTurn(fresh, { turnId: '167/attach-2', attachFromPathRoots: [os.tmpdir()] })
  await turn.get('memory_read').execute({ id: node.id }, {})
  await turn.get('memory_write').execute({ id: node.id, body: 'W42 报告的归档记录。\n助手检索录音库后告知用户本周无相关录音。' }, {})
  const carriedFile = await turn.get('memory_attach').execute({ id: node.id, filename: 'w42-v2.md', content: '助手检索录音库后告知用户本周无相关录音。' }, {})
  assert.equal(carriedFile.unsourced_assertions, undefined)
  // A from_path attach is scanned from the file it just copied in — writing
  // the claim to a loose file first must not be the dodge that reopens the
  // route this test closes.
  const loose = path.join(os.tmpdir(), `memgraph-loose-claim-${process.pid}.md`)
  await fsp.writeFile(loose, '报告已生成并念给用户。\n', 'utf8')
  const moved = await turn.get('memory_attach').execute({ id: node.id, from_path: loose }, {})
  assert.equal(moved.copied_from, loose)
  assert.equal(moved.unsourced_assertions.length, 1)
  assert.deepEqual(validate(turn.get('memory_attach').output.schema, moved), [])
  // A binary from_path file is bytes, not text: it attaches as it always did
  // and the text gates keep quiet instead of scanning mangled decode output.
  const bin = path.join(os.tmpdir(), `memgraph-loose-bin-${process.pid}.bin`)
  await fsp.writeFile(bin, Buffer.from([0x00, 0xff, 0x01, 0x88, 0x02]))
  const binary = await turn.get('memory_attach').execute({ id: node.id, from_path: bin }, {})
  assert.equal(binary.status, 'created')
  assert.equal(binary.unsourced_assertions, undefined)
  assert.equal(binary.minted_precision, undefined)
  // A scan that cannot read its inputs must not unwind the attach it is
  // advisory ABOUT (sonnet review of this change): the file landed, so a
  // throw here would read as "not stored" when it was. The degraded report
  // is silence, exactly like a clean attach.
  const realReadFile = fsp.readFile
  fsp.readFile = async () => { throw new Error('injected scan failure') }
  let unscanned
  try {
    unscanned = await turn.get('memory_attach').execute({ id: node.id, filename: 'unscanned.md', content: '助手检索了会议记录并告知用户结论。' }, {})
  } finally {
    fsp.readFile = realReadFile
  }
  assert.equal(unscanned.status, 'created')
  assert.equal(unscanned.unsourced_assertions, undefined, 'the scan degrades to silence instead of throwing')
  assert.equal((await turn.get('memory_read_file').execute({ id: node.id, file: 'unscanned.md' }, {})).content, '助手检索了会议记录并告知用户结论。')
  // The from_path variant (review of #176), with the scan's read failing:
  // the attach must stand, the source must stay untouched, and the degrade
  // path must leave its stderr trace rather than disappear.
  const loose2 = path.join(os.tmpdir(), `memgraph-loose-claim2-${process.pid}.md`)
  await fsp.writeFile(loose2, '报告已生成并念给用户。\n', 'utf8')
  const stderrLines = []
  const realStderrWrite = process.stderr.write
  fsp.readFile = async () => { throw new Error('injected scan failure') }
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true }
  let movedUnscanned
  try {
    movedUnscanned = await turn.get('memory_attach').execute({ id: node.id, from_path: loose2 }, {})
  } finally {
    fsp.readFile = realReadFile
    process.stderr.write = realStderrWrite
  }
  assert.equal(movedUnscanned.status, 'created')
  assert.equal(movedUnscanned.copied_from, loose2)
  assert.equal(movedUnscanned.unsourced_assertions, undefined, 'the from_path scan degrades to silence too')
  assert.equal(await fsp.readFile(loose2, 'utf8'), '报告已生成并念给用户。\n', 'the source is copied, never consumed')
  assert.equal((await turn.get('memory_read_file').execute({ id: node.id, file: path.basename(loose2) }, {})).content, '报告已生成并念给用户。\n')
  assert.ok(stderrLines.some((line) => /memory-graph: could not run the fidelity gates over .+ — injected scan failure/.test(line)),
    'the degrade path warns on stderr instead of failing silently')
  for (const source of [loose, bin, loose2]) await fsp.rm(source, { force: true })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F76: a write contradicting a stored labeled figure is rejected with both values named (#173)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-contradicted-'))
  const setup = await nextTurn(fresh, { turnId: '173/step-1' })
  // Synthetic demo-fund figures, stored as a labeled report.
  const node = await setup.get('memory_write').execute({
    description: 'DEMO ETF 报告核心结论',
    body: '## 报告核心结论\n- 近半年涨幅 **+18.26%**，YTD +12.4%\n- 前10大持仓占 37.42%，Demo7合计约46%，SAMPLE单只占6.25%，科技板块权重58.25%',
  }, {})

  // Turn 87's shape: the rewritten body and the fabricated attachment both
  // assert 约62%, and the stored 37.42% appears nowhere in the write. This
  // REJECTS rather than advises — the advisory pattern is proven ignored
  // (#163 29/29, #167 turn 6) — and the node must still hold the user's own
  // figure afterwards, because nothing was written.
  const turn = await nextTurn(fresh, { turnId: '173/step-2' })
  await turn.get('memory_read').execute({ id: node.id }, {})
  await assert.rejects(() => turn.get('memory_write').execute({
    id: node.id,
    body: '## 报告核心结论\n- 风险：PE约28x（均值22x）、前十大持仓约62%、利率反复、AI泡沫担忧',
    attach: { filename: 'demo-fund-2030-04-17.md', content: '| 集中度风险 | 前十大持仓约62%权重 |' },
  }, {}), (error) => {
    assert.match(error.message, /contradicted figure/)
    assert.match(error.message, /37\.42%/, 'the stored value is named')
    assert.match(error.message, /62%/, 'the contradicting value is named')
    return true
  })
  assert.ok((await fsp.readFile(path.join(fresh, node.id, 'node.md'), 'utf8')).includes('37.42'),
    'the rejected write left the stored figure in place')

  // The explicit escape: the same revision NAMING the old value lands — that
  // is what an honest correction looks like, and it is deliberately the only
  // way through (a phrasing trick must not be).
  const retry = await nextTurn(fresh, { turnId: '173/step-3' })
  await retry.get('memory_read').execute({ id: node.id }, {})
  const landed = await retry.get('memory_write').execute({
    id: node.id,
    body: '## 报告核心结论\n- 前十大持仓 37.42% → 62%（2030-04-17 更正），科技板块权重58.25%',
  }, {})
  assert.equal(landed.id, node.id, 'the correction that names the stored value is a legitimate write')

  // The round after the correction (opus pre-merge review of #173): the node
  // now holds 「37.42% → 62%」, and a later write restating the CURRENT 62%
  // must land — the arrow chains both values under the label, two values is
  // ambiguity, and an ambiguous label is no baseline. Without the chaining,
  // the gate's own prescribed correction form would have pinned the
  // superseded 37.42% as the value it defends.
  const fourth = await nextTurn(fresh, { turnId: '173/step-4' })
  await fourth.get('memory_read').execute({ id: node.id }, {})
  const restated = await fourth.get('memory_write').execute({
    id: node.id,
    body: '## 报告核心结论\n- 前十大持仓约62%（2030-04-17 更正后口径），科技板块权重58.25%',
  }, {})
  assert.equal(restated.id, node.id, 'restating the corrected figure is not a contradiction')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F76: contradictedFigures under-fires by design on every ambiguous shape (#173)', () => {
  // The target pair, as the unit: label normalized across 前十大/前10大, both
  // values reported for the rejection message to name.
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%，科技板块权重58.25%', '- 前十大持仓约62%'),
    [{ label: '前10大持仓', prior: '37.42%', next: '62%' }])
  // A bare count carries no unit and never extracts — headcount revisions,
  // TPS estimates and list ordinals are where the noise lives.
  assert.deepEqual(contradictedFigures('- 30年4月1日 headcount 基准：160人', 'headcount 基准改为 165人'), [])
  // Labels match exactly, never by proximity or overlap: SAMPLE's own 50% is
  // not the fund's 涨幅, however close the vocabulary.
  assert.deepEqual(contradictedFigures('- 近半年涨幅 +18.26%', '- SAMPLE 半年涨幅约50%'), [])
  // A label that cannot be confidently normalized (a 百-form numeral) only
  // matches its verbatim twin — no confident bridge, no fire.
  assert.deepEqual(contradictedFigures('- 前一百大持仓占 37.42%', '- 前100大持仓约62%'), [])
  // A restated value at coarser precision is the same figure, not a
  // contradiction; a genuinely different one still is.
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%', '- 前10大持仓约37%'), [])
  // A unit mismatch is two different measurements, never compared.
  assert.deepEqual(contradictedFigures('- 跑赢SPY +11.6%', '- 跑赢SPY +6.34pp'), [])
  // A prior label carrying two distinct values is ambiguous, not a baseline.
  assert.deepEqual(contradictedFigures('- 毛利率 30%\n- 毛利率 50%', '- 毛利率 40%'), [])
  // A figure the new text merely drops is dropped_body's beat, not a
  // contradiction.
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%', '- 报告已交付，无其他数字'), [])
  // The explicit-correction escape: naming the stored value anywhere in the
  // new text passes the write, whatever the phrasing around it.
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%', '- 前10大持仓 62%（原 37.42%）'), [])
  // The shapes the pre-merge review round closed (opus, #173), pinned:
  // an arrow-corrected node holds BOTH values and is no baseline against its
  // own superseded figure — the gate's prescribed correction form must never
  // manufacture the next false rejection;
  assert.deepEqual(contradictedFigures('- 前十大持仓 37.42% → 62%（2030-04-17 更正）', '- 前十大持仓约62%'), [])
  // a truncated-suffix label never matches across subjects — the wide clause
  // context has to meet too, and two-char predicates are below the name floor;
  assert.deepEqual(contradictedFigures('- Q1 毛利率 40%', '- Q2 毛利率 45%'), [])
  assert.deepEqual(contradictedFigures('- DCQ：月租约 9万美元', '- DCR：月租约 6万美元'), [])
  // a range's lower bound is not a label, so revising the upper bound is
  // silent;
  assert.deepEqual(contradictedFigures('规模300-400万', '规模300-500万'), [])
  // a claim side splitting one stale figure into a per-period pair asserts
  // no single replacement — ambiguity forgives both sides;
  assert.deepEqual(contradictedFigures('- 毛利率 42%', '- 毛利率 40%（去年）\n- 毛利率 45%（今年）'), [])
  // a vague quantifier (三四, "three or four") never expands into a number
  // the writer did not write;
  assert.deepEqual(contradictedFigures('一两个月内成本 100万', '12个月内成本 200万'), [])
  // and the float tie: 8.17% IS the correct rounding of a stored 8.165%.
  assert.deepEqual(contradictedFigures('占比 8.165%', '占比 8.17%'), [])
  // The second review round (sonnet, #173), pinned the same way:
  // the ONE-LINE comparative pair — a close-bracket is neither junction nor
  // label char, so 45% used to drop and the pair read as a single-value
  // baseline. The slash chains like the arrow, and ambiguity engages on
  // whichever side carries the pair.
  assert.deepEqual(contradictedFigures('毛利率 40%（去年）/45%（今年）', '毛利率 50%'), [])
  assert.deepEqual(contradictedFigures('- 毛利率 42%', '毛利率 40%（去年）/45%（今年）'), [])
  // the escape is scoped to the figure it forgives: a stray 「净利润37.42万」
  // — different metric, different unit — no longer launders the contradiction,
  assert.deepEqual(contradictedFigures('前10大持仓占 37.42%的仓位', '前十大持仓约62%的权重。另外，净利润37.42万元。'),
    [{ label: '前10大持仓', prior: '37.42%', next: '62%' }])
  // while the stored number beside its own label and unit still passes;
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%', '- 前10大持仓 62%（原 37.42%）'), [])
  // and full-width digits are figures too — a ３７．４２％ prior body used to
  // extract nothing, turning the gate off wholesale for that write.
  assert.deepEqual(contradictedFigures('- 前10大持仓占 ３７．４２％', '- 前十大持仓约62%'),
    [{ label: '前10大持仓', prior: '37.42%', next: '62%' }])
  assert.deepEqual(contradictedFigures('- 前10大持仓占 37.42%', '- 前十大持仓约６２％'),
    [{ label: '前10大持仓', prior: '37.42%', next: '62%' }])
})

test('F72: memory_merge names absorbed lines the kept body already states; distinct content stays silent', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-restate-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, turnId: 'audit/dup2' })
  await settle()
  const write = tools.get('memory_write')
  const merge = tools.get('memory_merge')
  // The dup2 evidence verbatim: the 法务审核 rule near-identical — not
  // byte-identical — in both halves, plus absorbed bullets that carry their
  // own facts.
  const keep = await write.execute({
    description: '对外报价必须先经法务审核才能发出（2026-08-26起执行）',
    body: '规则（2026-08-26确立）：任何对外报价，必须先经法务部门审核通过后才能发出。未经法务审核的报价不得对外提交或发送。',
    type: 'preference',
  }, {})
  const rule = '**规则（2026-08-26起）：所有对外报价，必须先经法务审核，审核通过后方可对外发出。**'
  const absorb = await write.execute({
    description: '所有对外报价必须先经法务审核（老板要求，2026-08-26起）',
    body: `${rule}\n\n- 来源：老板明确要求\n- 无例外条款说明\n- 适用范围：所有对外报价（未限定业务线，视为全线适用）`,
    type: 'preference',
  }, {})
  const result = await merge.execute({ keep_id: keep.id, absorb_id: absorb.id }, {})
  assert.deepEqual(validate(merge.output.schema, result), [])
  assert.deepEqual(result.restated_lines, [rule], 'the restated rule is named; the absorbed bullets carry their own facts and are not')
  const rendered = merge.output.render({}, result)[0].text
  assert.match(rendered, /states the same fact twice/)
  assert.match(rendered, new RegExp(`memory_read ${keep.id}`), 'the nudge orders the read before the rewrite')
  assert.match(rendered, new RegExp(`Merged from ${absorb.id} on <date>`), 'the provenance line survives the synthesis')
  assert.ok(rendered.includes(`\n  ${rule}`), 'the render quotes the line')
  // F64: the nudge journals about the KEPT node.
  const journal = (await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')).split('\n').filter((line) => line.includes(' restated_lines '))
  assert.equal(journal.length, 1)
  assert.match(journal[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ turn=audit/dup2 restated_lines ${keep.id} `))
  // A merge whose halves are genuinely distinct stays silent — a short
  // exact-duplicate line under the unit floor carries too little identity to
  // order a rewrite over.
  const keepDistinct = await write.execute({ description: '市场预算审批流程', body: '来源：老板明确要求\n预算须走市场部批复流程。' }, {})
  const absorbDistinct = await write.execute({ description: '市场预算审批负责人', body: '来源：老板明确要求\n批复负责人是Jordan。' }, {})
  const distinct = await merge.execute({ keep_id: keepDistinct.id, absorb_id: absorbDistinct.id }, {})
  assert.equal(distinct.restated_lines, undefined)
  assert.doesNotMatch(merge.output.render({}, distinct)[0].text, /states the same fact twice/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: an absorbed body quoting an older merge divider still partitions correctly (#162 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-nested-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const merge = tools.get('memory_merge')
  const rule = '所有对外报价必须经过法务审核后才能发送给客户，任何例外都要留下书面记录。'
  const keep = await write.execute({ description: '报价流程规则', body: rule }, {})
  // The absorbed node carries a divider of its own — a restore-and-remerge
  // cycle produces exactly this, and the old lastIndexOf scan partitioned on
  // it instead of the divider this call appends.
  const absorb = await write.execute({
    description: '报价流程规则（重复）',
    body: [
      '旧的合并记录：',
      `\n\n---\nMerged from 01M0000000000000000000000 on 2026-08-01:\n`,
      '任何对外报价都要先过法务审核才可以发给客户，例外必须有书面记录。',
    ].join('\n'),
  }, {})
  const merged = await merge.execute({ keep_id: keep.id, absorb_id: absorb.id }, {})
  assert.ok(merged.restated_lines?.some((line) => line.includes('法务审核')), 'the restated rule is still found past the quoted divider')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: two lines differing only in an identifier are different facts, never restatements (#162 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-ids-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const merge = tools.get('memory_merge')
  const line = (id) => `W32 风控与 KYC 汇总报告已交付给用户，报告制品编号 ${id}，正文含六条风控与四条 KYC。`
  const keep = await write.execute({ description: 'W32 报告交付记录', body: line('300417582904613376') }, {})
  const absorb = await write.execute({ description: 'W32 报告交付记录（副本）', body: line('300442018876145664') }, {})
  const merged = await merge.execute({ keep_id: keep.id, absorb_id: absorb.id }, {})
  assert.equal(merged.restated_lines, undefined, 'a different artifact id is a different fact, whatever the prose overlap')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F72: a differing date is a differing fact, and one kept line must state it (#162 review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-precision-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh })
  await settle()
  const write = tools.get('memory_write')
  const merge = tools.get('memory_merge')
  // Same prose, different ISO date: two schedules, not one restatement.
  const sched = await write.execute({ description: '开户排期', body: '银行方确认开户材料将于 2026-09-01 提交给合规部门审核。' }, {})
  const other = await write.execute({ description: '开户排期（副本）', body: '银行方确认开户材料将于 2026-09-02 提交给合规部门审核。' }, {})
  const dated = await merge.execute({ keep_id: sched.id, absorb_id: other.id }, {})
  assert.equal(dated.restated_lines, undefined, 'a differing date is a differing fact')
  // Coverage is scored per kept LINE: a keeper whose lines each state
  // something else never covers the absorbed fact, however much vocabulary
  // the whole body shares with it.
  const split = await write.execute({
    description: '选型与容量',
    body: ['主库选型由平台组在 2026-08-10 决定，记录在架构评审纪要里。', '缓存命中率上月约 85%，由 Beta 服务上报。'].join('\n'),
  }, {})
  const claim = await write.execute({ description: 'Alpha 选型', body: 'Alpha 服务使用 Redis 作为主库，读写都走它，命中率无关。' }, {})
  const union = await merge.execute({ keep_id: split.id, absorb_id: claim.id }, {})
  assert.equal(union.restated_lines, undefined, 'no single kept line states the absorbed fact')
  await fsp.rm(fresh, { recursive: true, force: true })
})
test('F72: the resolving-is-not-minting rule lives in the dates bullet, and AGENTS.md carries its twin', async () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const bullet = renderSection({ sections, variables }).split('\n').find((line) => line.includes('Write dates absolute'))
  assert.ok(bullet, 'the dates bullet is present')
  assert.match(bullet, /resolving is not minting/)
  assert.match(bullet, /以<anchor date>为基准/)
  const agents = await fsp.readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  assert.match(agents, /resolving is not minting/, 'the raw-filesystem twin states the same rule')
})

// F79 (#180): the DEMO-V2 WRITE_MISS shape — a gist card written over a 100k-char
// accessibility-tree turn, every static UI enumeration discarded. #174 proved
// the prompting turn is readable at execute time; this captures it as
// observation.txt so the raw material the gist was distilled from survives.
const execWithTurn = (turnText) => ({
  agent: { session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: turnText }] },
    // A tool result is also role:user but a different source kind — must be skipped.
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'TOOL RESULT — not the turn' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'model reply' }] },
  ] } },
})

test('F79: a gist over a much larger prompting turn auto-attaches the raw observation', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const axtree = 'button "View all comments"\n'.repeat(200) // ~5.4k chars, dwarfs the gist
  const res = await write.execute(
    { description: 'Postmill nav gist', body: 'Reply then look for the blue banner link.' },
    execWithTurn(axtree),
  )
  assert.deepEqual(res.observation, { file: 'observation.txt', bytes: Buffer.byteLength(axtree, 'utf8'), status: 'created' })
  const stored = await fsp.readFile(path.join(fresh, res.id, 'observation.txt'), 'utf8')
  assert.equal(stored, axtree, 'the raw turn is stored verbatim, tool result excluded')
  const rendered = write.output.render({}, res).map((b) => b.text).join('\n')
  assert.match(rendered, /Captured the prompting turn as observation\.txt/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: no attach when the turn is small, absent, or the write volunteered its own payload', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79b-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')

  // Small turn: an ordinary "remember X" discarded nothing.
  const small = await write.execute({ description: 'a fact', body: 'a body' }, execWithTurn('remember this small thing'))
  assert.equal(small.observation, undefined)
  assert.equal((await fsp.readdir(path.join(fresh, small.id))).includes('observation.txt'), false)

  // No agent (direct callers, tests): degrade to no capture, same as sessionKeyOf.
  const bulky = 'x'.repeat(5000)
  const noExec = await write.execute({ description: 'b fact', body: 'b' }, {})
  assert.equal(noExec.observation, undefined)

  // An inline attach means the model volunteered a payload — no auto-observation.
  const volunteered = await write.execute(
    { description: 'c fact', body: 'gist', attach: { filename: 'report.txt', content: bulky } },
    execWithTurn(bulky),
  )
  assert.equal(volunteered.observation, undefined)
  assert.equal(volunteered.attached.file, 'report.txt')
  assert.equal((await fsp.readdir(path.join(fresh, volunteered.id))).includes('observation.txt'), false)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: a re-observed page dedups on the stable name instead of piling up copies', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79c-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const page1 = 'link "Profile"\n'.repeat(300)
  const created = await write.execute({ description: 'Account menu gist', body: 'six links under the avatar' }, execWithTurn(page1))
  assert.equal(created.observation.status, 'created')

  // Re-observe the identical page on update → unchanged, one file, no churn.
  await read.execute({ id: created.id }, {}) // satisfy the read-before-write gate
  const same = await write.execute({ id: created.id, body: 'six links under the avatar (confirmed)' }, execWithTurn(page1))
  assert.equal(same.observation.status, 'unchanged')

  // A changed page overwrites the same name — still one observation.txt.
  const page2 = 'link "Settings"\n'.repeat(300)
  await read.execute({ id: created.id }, {})
  const changed = await write.execute({ id: created.id, body: 'now seven links' }, execWithTurn(page2))
  assert.equal(changed.observation.status, 'overwritten')
  const files = (await fsp.readdir(path.join(fresh, created.id))).filter((f) => f === 'observation.txt')
  assert.deepEqual(files, ['observation.txt'])
  assert.equal(await fsp.readFile(path.join(fresh, created.id, 'observation.txt'), 'utf8'), page2)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: a links- or type-only update captures nothing — it distilled no gist this turn (codex #180)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79d-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const peer = await write.execute({ description: 'a peer node' }, {})
  const created = await write.execute({ description: 'a gist node', body: 'small gist' }, {})
  const bulky = 'link "x"\n'.repeat(400)
  // A links-only update: no new body or description, so the large turn belongs
  // to no gist this call stored and must not pollute the node.
  await read.execute({ id: created.id }, {})
  const linksOnly = await write.execute({ id: created.id, links: [peer.id] }, execWithTurn(bulky))
  assert.equal(linksOnly.observation, undefined)
  assert.equal((await fsp.readdir(path.join(fresh, created.id))).includes('observation.txt'), false)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: an oversized multibyte turn truncates on a UTF-8 boundary instead of dropping the capture (codex #180)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // A three-byte CJK char repeated past the cap: a naive byte slice would split
  // one and re-encode above the cap, and attach() would reject the whole thing.
  const huge = '观'.repeat(ATTACH_MAX_BYTES) // 3 bytes each, far over the cap
  const res = await write.execute({ description: '页面观察', body: '简短要点' }, execWithTurn(huge))
  assert.ok(res.observation, 'the capture still lands')
  assert.ok(res.observation.bytes <= ATTACH_MAX_BYTES, 'stored within the attachment cap')
  const stored = await fsp.readFile(path.join(fresh, res.id, 'observation.txt'), 'utf8')
  assert.doesNotMatch(stored, /�/, 'no split-character replacement in the stored file')
  assert.equal(Buffer.byteLength(stored, 'utf8'), res.observation.bytes)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: a create that supersedes carries its observation atomically and still supersedes (codex #180)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79f-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const old = await write.execute({ description: 'old decision: use Postgres' }, {})
  await read.execute({ id: old.id }, {}) // read-before-supersede gate
  const page = 'toolbar button\n'.repeat(300)
  const fresh2 = await write.execute({ description: 'new decision: use ClickHouse', body: 'switched for scan speed', supersedes: old.id }, execWithTurn(page))
  assert.equal(fresh2.observation.status, 'created')
  assert.equal(fresh2.superseded.id, old.id)
  assert.equal(await fsp.readFile(path.join(fresh, fresh2.id, 'observation.txt'), 'utf8'), page)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: the capture ratio measures the normalized stored gist, not the raw escaped argument (codex #180)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79g-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // Raw body is 2000 chars of `\n` escapes; normalized it is 1000 newlines.
  // Turn is 5000 chars: 5000/2000 = 2.5 (would miss on the raw length) but
  // 5000/1000 = 5 clears the ratio on the stored length.
  const body = '\\n'.repeat(1000)
  assert.equal(body.length, 2000)
  const turn = 'link "row"\n'.repeat(455) // ~5000 chars, > MIN_TURN
  assert.ok(turn.length >= 4000 && turn.length < 8000)
  const res = await write.execute({ description: 'g', body }, execWithTurn(turn))
  assert.ok(res.observation, 'measured against the 1000-char normalized gist, the turn qualifies')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F79: superseding a node that already has an observation preserves both, collision-renamed (codex #180)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f79h-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const page1 = 'menu "old page"\n'.repeat(300)
  const old = await write.execute({ description: 'old page gist', body: 'old' }, execWithTurn(page1))
  assert.equal(old.observation.status, 'created')
  await read.execute({ id: old.id }, {}) // read-before-supersede gate
  const page2 = 'menu "new page"\n'.repeat(300)
  const next = await write.execute({ description: 'new page gist', body: 'new', supersedes: old.id }, execWithTurn(page2))
  assert.equal(next.observation.status, 'created')
  // The successor keeps THIS turn's observation under the stable name, and the
  // inherited one follows the supersession under a collision-safe name — never
  // overwritten (AGENTS.md:41).
  assert.equal(await fsp.readFile(path.join(fresh, next.id, 'observation.txt'), 'utf8'), page2)
  const inherited = (await fsp.readdir(path.join(fresh, next.id))).filter((f) => f !== 'observation.txt' && f.endsWith('observation.txt'))
  assert.equal(inherited.length, 1, 'the old observation moved in under a renamed key')
  assert.equal(await fsp.readFile(path.join(fresh, next.id, inherited[0]), 'utf8'), page1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F81 (#182): the answer-side twin of F79. The write path preserves the raw
// observation; these lock that the RECALL path can find it, see it, and read it.
test('F81: the auto-attached observation is searchable, quoted on the row, and readable from the offset it reports', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-e2e-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // DEMO-V2 qid a1b2c3d4, end to end: the writer saw the whole account menu and
  // stored a gist naming one of its six links. F79 keeps the tree; before F81
  // the fact sat in the tree's unindexed middle and the row that did match said
  // only which file to open — a second call the failing answers never made.
  const noise = "row 'noise noise noise placeholder toolbar'\n".repeat(2500)
  const menu = "link 'Profile'\nlink 'My account'\nlink 'User settings'\nlink 'Block list'\nlink 'Dark mode'\nlink 'Log out'\n"
  const axtree = `${noise}${menu}${noise}`
  const res = await write.execute(
    { description: 'Postmill account menu', body: 'The avatar opens the account menu, which contains Profile.' },
    execWithTurn(axtree),
  )
  assert.equal(res.observation.status, 'created')

  const search = tools.get('memory_search')
  const hits = await search.execute({ query: 'block list dark mode log out' }, {})
  assert.deepEqual(validate(search.output.schema, hits), [])
  assert.equal(hits.unmatched, undefined, 'terms the observation carries verbatim are never reported missing')
  assert.equal(hits.matches[0].id, res.id)
  assert.deepEqual(hits.matches[0].matched_in, ['observation.txt'], 'the hit row says the match was in the file')

  const text = search.output.render({}, hits)[0].text
  assert.match(text, /matched in observation\.txt/)
  // The body snippet is the gist that dropped five links; the quote beside it
  // carries all six, so one search is enough to answer.
  assert.match(text, /which contains Profile\./)
  for (const link of ["link 'My account'", "link 'User settings'", "link 'Block list'", "link 'Dark mode'", "link 'Log out'"]) {
    assert.ok(text.includes(link), `the rendered row quotes ${link}`)
  }
  assert.match(text, /memory_read_file\(id: "01[0-9A-HJKMNP-TV-Z]{24}", file: "observation\.txt", offset: \d+\)/)

  // And the read path opens the file AT that offset rather than paging a
  // quarter-megabyte from byte zero to reach the same lines.
  const { offset } = hits.matches[0].file_matches[0]
  const readFile = tools.get('memory_read_file')
  const page = await readFile.execute({ id: res.id, file: 'observation.txt', offset }, {})
  assert.deepEqual(validate(readFile.output.schema, page), [])
  assert.ok(page.content.includes("link 'Log out'"), 'the reported offset lands on the passage the row quoted')
  // The window stops short of the file's end, and says so — a cut the reader
  // cannot see is the same as a miss (#186).
  assert.equal(page.next_offset, offset + page.bytes)
  assert.match(readFile.output.render({}, page)[0].text, /more bytes — call memory_read_file again with offset: \d+/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81: an observation cut at the attachment cap says so in the file itself (#182, overlaps #186)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-cap-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const huge = 'x'.repeat(ATTACH_MAX_BYTES * 2)
  const res = await write.execute({ description: 'a huge page', body: 'a short gist' }, execWithTurn(huge))
  const stored = await fsp.readFile(path.join(fresh, res.id, 'observation.txt'), 'utf8')
  assert.ok(Buffer.byteLength(stored, 'utf8') <= ATTACH_MAX_BYTES, 'still within the cap')
  assert.match(stored, /observation truncated at the \d+-byte attachment cap: \d+ more chars/)
  assert.equal(res.observation.bytes, Buffer.byteLength(stored, 'utf8'))
  // The count is the count actually dropped, not the one a first cut would have
  // dropped before the marker took its own room (codex review of #182).
  const dropped = Number(stored.match(/cap: (\d+) more chars/)[1])
  const kept = stored.slice(0, stored.indexOf('\n…[observation truncated'))
  assert.equal(kept.length + dropped, huge.length, 'kept + reported-dropped accounts for the whole turn')

  // The marker is deterministic, so F79's re-observation dedup still holds.
  await tools.get('memory_read').execute({ id: res.id }, {}) // satisfy the read-before-write gate
  const again = await write.execute({ id: res.id, body: 'a short gist, revised' }, execWithTurn(huge))
  assert.equal(again.observation.status, 'unchanged')

  // A turn that fits carries no marker at all.
  const fits = await write.execute({ description: 'an ordinary page', body: 'gist' }, execWithTurn('y'.repeat(5000)))
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, fits.id, 'observation.txt'), 'utf8'), /observation truncated/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F86 (#201): search rows were 64% of tool-result bytes. Three cuts halve the
// per-row size without touching ranking or which rows appear: the body snippet
// drops 200→120 chars (a graph.js length constant), the per-row `(matched: …)`
// echo is gone, and the F81 attachment excerpt block rides only the top 5 rows
// — rows 6+ keep the `[N files]` marker (memory_read_file stays discoverable)
// but shed the quote block and the "matched in …" line. The render takes the
// search-result shape directly, so these lock the contract on a synthetic
// result rather than 20 real nodes — the assembly in search() is untouched.
const f86Match = (n, extra = {}) => ({
  id: `01F86ROW${String(n).padStart(4, '0')}AAAAAAAAAAAA`,
  description: `row ${n} — postmill account menu and settings pane`,
  // A full 120-char snippet, the new cap, so the byte budget is measured at the
  // worst case a real row reaches.
  snippet: 'x'.repeat(120),
  ...extra,
})
const f86WithFiles = (n) => f86Match(n, {
  files: ['observation.txt'],
  matched_in: ['observation.txt'],
  file_matches: [{ file: 'observation.txt', offset: 4200, excerpt: 'y'.repeat(90) }],
})

// The pre-F86 render, reconstructed for the SAME fixture so the halving is
// measured, not asserted from a hand-picked ceiling: 200-char snippet, a
// `(matched: …)` echo on every row, and the quote/offset + "matched in …"
// blocks on all rows rather than the top 5.
const renderMatchesPreF86 = (value) => {
  const head = `${value.matches.length} shown — ${value.full} match every term, ${value.total} match at least one:`
  const rows = value.matches.map((m) => {
    const files = m.files && m.files.length > 0 ? ` [${m.files.length} file${m.files.length === 1 ? '' : 's'}]` : ''
    const inFiles = m.matched_in && m.matched_in.length > 0 ? `\n    matched in ${m.matched_in.join(', ')} — the snippet below is the body gist and may not carry the fact; open the file with memory_read_file` : ''
    const quotes = (m.file_matches ?? []).map((f) => `\n    ${JSON.stringify(f.file)} @ byte ${f.offset}: ${f.excerpt}\n      …more with memory_read_file(id: "${m.id}", file: ${JSON.stringify(f.file)}, offset: ${f.offset})`).join('')
    const why = m.matched && m.matched.length > 0 ? ` (matched: ${m.matched.join(', ')})` : ''
    return `${m.id} — ${m.description}${files}${why}${inFiles}${m.snippet ? `\n    ${m.snippet}` : ''}${quotes}`
  })
  return [head, ...rows, 'To update any node above, memory_read it first — updates to nodes not read this session are rejected.'].join('\n')
}

test('F86: a 20-row result renders at roughly half the pre-F86 byte cost, excerpts only on the top 5 (#201)', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const search = tools.get('memory_search') // render is pure over the value shape
  // Every row carries an attachment hit and the full 120-char snippet — the
  // heaviest row shape — so the top-5 excerpt gate is what keeps the result
  // small. Each row also carries a matched-term list, which the old render
  // echoed and the new one drops.
  const matches = Array.from({ length: 20 }, (_, i) => f86WithFiles(i + 1))
  const value = { tokens: 4, full: 20, total: 20, matches }
  const text = search.output.render({}, value)[0].text

  // The pre-F86 render of the same rows (200-char snippets, the matched echo,
  // and excerpt blocks on all 20) costs about twice as much.
  const before = renderMatchesPreF86({ ...value, matches: matches.map((m) => ({ ...m, snippet: 'x'.repeat(200), matched: ['block', 'list'] })) })
  assert.ok(text.length < before.length * 0.6, `F86 render ${text.length} vs pre-F86 ${before.length} — not the intended halving`)

  // A concrete ceiling this worst-case 20-row synthetic comfortably meets; the
  // per-row body target is ~190 chars, excerpts aside.
  assert.ok(text.length < 6500, `20-row render was ${text.length} chars, over the 6500 ceiling`)

  // The excerpt block (byte offset + the read-file resume call) appears exactly
  // 5 times — once per top-5 row — never on rows 6+.
  const excerptBlocks = text.match(/@ byte 4200:/g) ?? []
  assert.equal(excerptBlocks.length, 5, 'the file_matches excerpt rides only the top 5 rows')
  // But every row still advertises its attachments so memory_read_file stays
  // reachable from rows 6+.
  assert.equal((text.match(/\[1 file\]/g) ?? []).length, 20, 'all 20 rows keep the [N files] marker')
})

test('F86: rows 1 and 6 both have file_matches — row 1 shows the excerpt block, row 6 shows only [N files] (#201)', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const search = tools.get('memory_search')
  // Row 1 (top-5) and row 6 (first past the cut) both carry an identical
  // attachment hit; everything else about them is the same but the row number.
  const matches = [f86WithFiles(1), f86Match(2), f86Match(3), f86Match(4), f86Match(5), f86WithFiles(6)]
  const value = { tokens: 3, full: 6, total: 6, matches }
  const text = search.output.render({}, value)[0].text

  // Both rows keep the marker.
  assert.ok(text.includes('01F86ROW0001AAAAAAAAAAAA — row 1'))
  assert.ok(text.includes('01F86ROW0006AAAAAAAAAAAA — row 6'))
  assert.equal((text.match(/\[1 file\]/g) ?? []).length, 2, 'both rows show [1 file]')

  // Row 1 renders its excerpt/offset block and the "matched in …" line.
  const row1 = text.slice(text.indexOf('01F86ROW0001'), text.indexOf('01F86ROW0002'))
  assert.match(row1, /matched in observation\.txt/)
  assert.match(row1, /observation\.txt" @ byte 4200:/)
  assert.match(row1, /memory_read_file\(id: "01F86ROW0001AAAAAAAAAAAA", file: "observation\.txt", offset: 4200\)/)

  // Row 6 shows neither the excerpt block nor the "matched in …" line.
  const row6 = text.slice(text.indexOf('01F86ROW0006'))
  assert.doesNotMatch(row6, /@ byte 4200:/)
  assert.doesNotMatch(row6, /matched in observation\.txt/)
  assert.doesNotMatch(row6, /memory_read_file\(/)

  // And the header per-term summary is unchanged — a value with an unmatched
  // term still names it in the `No rows for: …` line.
  const withMiss = { tokens: 3, full: 6, total: 6, matches, unmatched: ['nonesuch'] }
  const missText = search.output.render({}, withMiss)[0].text
  assert.match(missText, /No rows for: nonesuch — reword these, not the terms that worked\./)
})

// F82 (#191): an attachment is the node's curated DETAIL TIER, and its filename
// is the only handle a later session — or the user asking「那份周报」— has on it
// before the file is opened. A generic name throws that handle away at the
// moment it is cheapest to keep, so it draws an advisory: never a rejection
// (the file is stored exactly as asked, fail-toward-silence), and the SAME
// advisory whichever of the three write routes stored it — the property #167
// and F78 shipped the standalone route to hold.
test('F82: a generic attachment name draws the same advisory on create, update and memory_attach (#191)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f82-generic-'))
  const tools = await nextTurn(fresh, { turnId: '191/f82-1', indexCacheMs: 0, attachFromPathRoots: [os.tmpdir()] })
  const write = tools.get('memory_write')
  const attachTool = tools.get('memory_attach')
  const payload = '| 列 | 含义 |\n|---|---|\n| Grand Total | 订单总额 |\n'
  // Only the advisory paragraph, with the name folded out — what must be
  // identical across routes is the wording, not the filename inside it.
  const advisory = (text, file) => {
    const rest = text.slice(text.indexOf(`Attached as ${file}`))
    const end = rest.indexOf('\n\n')
    return (end === -1 ? rest : rest.slice(0, end)).split(file).join('<file>')
  }

  // Create: the inline attach rides createNode's rename, and the name is judged
  // on what actually landed.
  const created = await write.execute({ description: 'Magento 订单列表列', body: '列清单见 notes.md。', attach: { filename: 'notes.md', content: payload } }, {})
  assert.equal(created.generic_filename, 'notes.md')
  assert.deepEqual(validate(write.output.schema, created), [])
  const createdText = write.output.render({}, created)[0].text
  assert.match(createdText, /^Attached notes\.md on /m, 'the advisory rides beside the outcome line, never instead of it')
  assert.match(createdText, /a generic name/)
  assert.match(createdText, /give detail files contentful names/, 'the fix states the naming rule')
  // The fix cannot loop (gpt-5.6 review): every route recomputes the advisory
  // from the landed name, so it never asks the writer to overwrite the file it
  // just fired on — it asks for the body line and the NEXT file's name.
  assert.ok(createdText.includes(`Say in ${created.id}'s body what notes.md holds`), 'the fix names the body line, not a re-attach that would fire again')
  assert.match(createdText, /give detail files contentful names/)
  assert.doesNotMatch(createdText, /re-attach this same content/)

  // Update: the same one-call shape on an existing node (read first — F68).
  await tools.get('memory_read').execute({ id: created.id }, {})
  const updated = await write.execute({ id: created.id, body: '列清单见 details.md。', attach: { filename: 'details.md', content: payload } }, {})
  assert.equal(updated.generic_filename, 'details.md')
  assert.deepEqual(validate(write.output.schema, updated), [])
  assert.equal(advisory(write.output.render({}, updated)[0].text, 'details.md'), advisory(createdText, 'notes.md'))

  // Standalone: the route that must never report differently on identical
  // content (#167, F78).
  const standalone = await attachTool.execute({ id: created.id, filename: 'attachment.md', content: payload }, {})
  assert.equal(standalone.generic_filename, 'attachment.md')
  assert.deepEqual(validate(attachTool.output.schema, standalone), [])
  assert.equal(advisory(attachTool.output.render({}, standalone)[0].text, 'attachment.md'), advisory(createdText, 'notes.md'))

  // The whole generic set, case-insensitively and with or without an extension
  // — `data`, `INFO.TXT` and `File.md` are as handle-free as `notes.md`.
  for (const name of ['file.md', 'data.md', 'info.md', 'attachment', 'notes', 'details', 'File.md', 'INFO.TXT', 'Data']) {
    const one = await attachTool.execute({ id: created.id, filename: name, content: `${name} content\n` }, {})
    assert.equal(one.generic_filename, name, `${name} is a generic name`)
  }

  // A filename may legally carry a newline — assertAttachmentName bars path
  // separators and dotfiles, not those — so the advisory folds it the way the
  // journal does instead of letting one forge lines in a model-facing result
  // (the codex finding behind #182's JSON-quoted search rows).
  const folded = await attachTool.execute({ id: created.id, filename: 'notes\n.md', content: 'folded\n' }, {})
  assert.equal(folded.generic_filename, 'notes\n.md', 'the field itself carries the name verbatim')
  const foldedLines = attachTool.output.render({}, folded)[0].text.split('\n').filter((line) => line.includes('a generic name'))
  assert.equal(foldedLines.length, 1, 'the advisory stays one line')
  assert.match(foldedLines[0], /^Attached as notes \.md — a generic name/)

  // A from_path attach is judged on the name it LANDED under — the source
  // basename it defaulted to, which is exactly where a stray details.md walks in.
  const looseDir = path.join(os.tmpdir(), `memgraph-f82-loose-${process.pid}`)
  const loose = path.join(looseDir, 'details.md')
  await fsp.mkdir(looseDir, { recursive: true })
  await fsp.writeFile(loose, payload, 'utf8')
  const moved = await attachTool.execute({ id: created.id, from_path: loose }, {})
  assert.equal(moved.generic_filename, 'details.md')
  assert.match(attachTool.output.render({}, moved)[0].text, /a generic name/)

  // Journaled like every advisory the writer is shown (F64, #109), from both
  // routes, so a replay can count generic names per corpus.
  const journal = await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')
  assert.match(journal, new RegExp(` turn=191/f82-1 generic_filename ${created.id} notes\\.md`))
  assert.match(journal, new RegExp(` turn=191/f82-1 generic_filename ${created.id} details\\.md`))
  assert.match(journal, new RegExp(` turn=191/f82-1 generic_filename ${created.id} attachment\\.md`))
  await fsp.rm(looseDir, { recursive: true, force: true })
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The silent half. An advisory that fired on names which DO say what the file
// holds would be read past within a session, taking the fires that matter with
// it — and F79's machine-made observation.txt is not a name any writer chose.
test('F82: a descriptive name is silent, and F79 observation.txt is exempt (#191)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f82-silent-'))
  const tools = await nextTurn(fresh, { turnId: '191/f82-2', indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attachTool = tools.get('memory_attach')

  const created = await write.execute({ description: 'Magento 订单列表列', body: '列清单见 magento-orders-grid-columns.md。', attach: { filename: 'magento-orders-grid-columns.md', content: '| 列 | 含义 |\n|---|---|\n| Grand Total | 订单总额 |\n' } }, {})
  assert.equal(created.generic_filename, undefined)
  assert.doesNotMatch(write.output.render({}, created)[0].text, /a generic name/)
  await tools.get('memory_read').execute({ id: created.id }, {})
  const updated = await write.execute({ id: created.id, body: '周报另附。', attach: { filename: '周报-2026W32.md', content: 'W32 周报全文\n' } }, {})
  assert.equal(updated.generic_filename, undefined)

  // Near-misses: a generic word INSIDE a descriptive name still says what the
  // file holds — only the whole stem is generic.
  for (const name of ['meeting-notes.md', 'order-details.md', 'notes-2026W32.md', 'datafile.md', 'w42-预算口径.md']) {
    const one = await attachTool.execute({ id: created.id, filename: name, content: `${name} content\n` }, {})
    assert.equal(one.generic_filename, undefined, `${name} says what the file holds`)
    assert.doesNotMatch(attachTool.output.render({}, one)[0].text, /a generic name/)
  }

  // F79's auto-capture is machine-made under a fixed name: it is reported as
  // `observation`, never as an attachment the writer named, and it draws no
  // naming advice — and no agent can supply that name at all (#255), because a
  // Session-authored `observation.txt` would make the next autosave skip its
  // `.prev` copy and destroy the bytes. So the exemption has nothing left to
  // fire on for a writer-chosen file.
  const observed = await write.execute({ description: 'Postmill account menu', body: 'The avatar opens the account menu.' }, execWithTurn("link 'Profile'\nlink 'Log out'\n".repeat(300)))
  assert.equal(observed.observation.file, 'observation.txt')
  assert.equal(observed.generic_filename, undefined)
  assert.doesNotMatch(write.output.render({}, observed)[0].text, /a generic name/)
  // The name is refused on every write route, in the preparation (so the
  // handler never runs and nothing lands) — see the dedicated #255 test.
  const prepare = trustedPreparationFor(attachTool)
  assert.match(prepare({ id: created.id, filename: 'observation.txt', content: 'raw capture\n' }).violations.join('; '), /reserved: observation\.txt is the framework's own capture/)

  // Nothing fired, so nothing is journaled under this kind.
  const journal = await fsp.readFile(path.join(fresh, '.advisories'), 'utf8').catch(() => '')
  assert.doesNotMatch(journal, /generic_filename/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F87 (#202): a memory_write result is a BOUNDED surface. The mean result is
// ~1.3k chars, but the tail hit 12,652 — all advisory text, re-sent on every
// later step of the turn. Three bounds, none of which changes which advisories
// FIRE (the detectors are untouched — only the render shrinks): the `similar`
// and `link_candidates` lists cap at five rows with a loud `… N more`, every
// advisory renders as one line, and the whole result has a hard 3000-char
// ceiling with a loud truncation marker (ADR 0006's bounded-surface rule).
function allAdvisoriesValue() {
  // dropped_body and replaced_body are mutually exclusive (one detector never
  // sets both), and node_degree shares hub_links' "becoming a hub" line, so this
  // value trips every advisory a single write can — the realistic maximum. The
  // two it leaves out are rendered on their own below.
  return {
    id: '01ABCDEFGHJKMNPQRSTVWXYZ01', created: false, description: 'all advisories',
    links: [{ to: 'aaa', status: 'ok' }],
    attached: { file: 'detail.md', bytes: 1234, status: 'created' },
    generic_filename: 'notes.md',
    similar: [{ id: '01SIMILARAAAAAAAAAAAAAAAA0', description: 'dup note', score: 9 }],
    long_body: 4200, verbatim_deliverable: 'a 10-item enumeration', node_size: 5200,
    hub_links: [{ id: '01HUBNODE0000000000000000', degree: 21 }],
    link_candidates: [{ id: '01RELATEDAAAAAAAAAAAAAAAA0', description: 'rel note', score: 9 }],
    blind_rewrite: 800, dropped_body: 300,
    dropped_ids: ['550e8400', 'worker-abc', 'artifact-xyz'],
    stale_description: 'ingest stall thread (pending)',
    unsourced_assertions: ['念了周报'], minted_precision: ['下周三 → 2026-09-16'],
    stale_pending: [{ id: '01PENDNODE000000000000000', line: '周报待交付' }], maintenance_due: 37,
  }
}

test('F87: a write that trips every advisory stays within the 3000 ceiling with each kind named', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const write = tools.get('memory_write')
  const value = allAdvisoriesValue()
  const text = write.output.render({}, value)[0].text
  assert.ok(text.length <= 3000, `the all-advisories result is ${text.length} chars, over the 3000 ceiling`)
  assert.doesNotMatch(text, /… truncated/, 'the realistic maximum fits without truncation, so every kind survives')
  // Every advisory KIND is still named — one keyword each, in render order.
  for (const keyword of [
    'a generic name', 'Similar node', 'Long body', 'verbatim deliverable',
    'several topics', 'becoming a hub', 'Related nodes', 'have not read this turn',
    'dropped a ~', 'dropped every identifier', 'advertises a pending state',
    'asserts what the assistant did', 'pairs a vague phrase', 'survives its own resolution',
    'Maintenance due',
  ]) assert.match(text, new RegExp(keyword), `"${keyword}" is missing from the bounded result`)
  // node_degree and replaced_body — the two the maximal write cannot co-trip —
  // still each render their own named line when they fire alone.
  assert.match(write.output.render({}, { id: value.id, created: false, description: 'x', links: [], node_degree: 14 })[0].text, /becoming a hub/)
  assert.match(write.output.render({}, { id: value.id, created: false, description: 'x', links: [], replaced_body: 900 })[0].text, /REPLACED the node's entire prior body/)
})

test('F87: an oversized result is cut at the ceiling with a loud marker naming the recovery', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const write = tools.get('memory_write')
  // Add the two extra advisory lines the realistic maximum leaves out; the raw
  // result now runs past 3000, so the ceiling engages.
  const oversized = { ...allAdvisoriesValue(), node_degree: 14, replaced_body: 900 }
  const text = write.output.render({}, oversized)[0].text
  assert.ok(text.length <= 3000, `the truncated result is ${text.length} chars, over its own ceiling`)
  assert.match(text, /… truncated/, 'the cut is loud, never silent')
  // The marker says the write LANDED (so it is not read as a failure) and does
  // NOT tell the writer to re-run the write — a memory_write is state-changing.
  assert.match(text, /the write landed; more advisories fired than fit here\.$/)
  assert.doesNotMatch(text, /re-run/, 'the marker must not advise a state-changing re-run')
})

test('F87: the ceiling truncates only the advisory tail, never the outcome head (codex #202)', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const write = tools.get('memory_write')
  // A description longer than the whole ceiling — bin/node-new permits it, and
  // an update preserves it. The head (id + full description + link count) must
  // survive intact; a naive whole-string cut would eat it and, with no advisory
  // firing, falsely stamp "… truncated" on a clean write.
  const hugeDescription = 'D'.repeat(3200)
  const text = write.output.render({}, { id: '01ABCDEFGHJKMNPQRSTVWXYZ01', created: false, description: hugeDescription, links: [] })[0].text
  assert.match(text, /^Updated 01ABCDEFGHJKMNPQRSTVWXYZ01 — D{3200} \(0 links\)/, 'the whole outcome head survives')
  assert.doesNotMatch(text, /… truncated/, 'a clean write with no advisories is never marked truncated')
})

test('F87: the similar and link_candidate blocks cap at five rows, highest score first, render-only', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const write = tools.get('memory_write')
  // Twelve candidates, arriving score-descending; the render keeps the top five.
  const twelve = (prefix) => Array.from({ length: 12 }, (_, i) => ({ id: `${prefix}${String(i).padStart(2, '0')}AAAAAAAAAAAAAAA`, description: `${prefix} ${i}`, score: 12 - i }))
  const similar = twelve('01SIM')
  const value = { id: '01ABCDEFGHJKMNPQRSTVWXYZ01', created: true, description: 'x', links: [], similar }
  const text = write.output.render({}, value)[0].text
  const rows = text.split('\n').filter((line) => line.startsWith('  01SIM'))
  assert.equal(rows.length, 5, 'five similar rows shown')
  assert.match(text, /… 7 more/, 'the remainder is named loudly')
  assert.match(text, /01SIM00/, 'the highest-score row is kept')
  assert.doesNotMatch(text, /01SIM11/, 'the lowest-score rows are the ones cut')
  // The cap is render-only — the detector still returns all twelve, so replay
  // fire counts are unchanged.
  assert.equal(value.similar.length, 12, 'render does not mutate the value it was handed')
  // link_candidates carries the same bound.
  const candidates = twelve('01REL')
  const linkText = write.output.render({}, { id: value.id, created: true, description: 'x', links: [], link_candidates: candidates })[0].text
  assert.equal(linkText.split('\n').filter((line) => line.startsWith('  01REL')).length, 5)
  assert.match(linkText, /… 7 more/)
  // A hand-built value out of score order is sorted before slicing, so the cap
  // never keeps a low-score row over a high-score one.
  const shuffled = [...similar].reverse()
  const shuffledText = write.output.render({}, { id: value.id, created: true, description: 'x', links: [], similar: shuffled })[0].text
  assert.match(shuffledText, /01SIM00/, 'score order wins over array order')
  assert.doesNotMatch(shuffledText, /01SIM11/)
})

// P7-C: write batching is a prompt-side opt-in. The T2 probe (2026-09-07)
// showed the batch half working (multi-write steps 7% → 21%) and the
// "search first" half it was paired with losing more than the batch saved, so
// the bullet carries the batch and nothing else, and ships off by default.
test('P7-C: batchWrites is off by default, boolean-validated, and adds exactly one bullet when on', () => {
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, batchWrites: 'yes' }), /`batchWrites` must be a boolean/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, batchWrites: 1 }), /`batchWrites` must be a boolean/)
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: root })
  assert.match(off.sections[0].text, /\{\{memory_batch_writes\}\}/, 'the slot is always in the section')
  assert.equal(off.variables.get('memory_batch_writes')(), '', 'off renders nothing')
  const on = fakeCtx()
  apply(on.ctx, { graphRoot: root, batchWrites: true })
  const bullet = on.variables.get('memory_batch_writes')()
  assert.match(bullet, /^- When this turn needs more than one `memory_write`/)
  assert.match(bullet, /ONE message as parallel tool calls/)
  assert.match(bullet, /`memory_read` in an earlier step/, 'read-before-update is not relaxed by the batch')
  assert.doesNotMatch(bullet, /search first|One memory_search|two phases/i, 'the forced-search half of T2 stays out')
  assert.ok(bullet.endsWith('\n'), 'the bullet closes its own line so the next bullet stays adjacent')
  assert.equal((bullet.match(/^- /gm) ?? []).length, 1, 'exactly one bullet')
  // The slot sits directly after the durable-fact write rule, so the rendered
  // section reads as one bullet list whether the variable is '' or the bullet.
  // #263 W2.1: the unknown bullet it precedes now has its own slot, so the
  // assertion reads the RENDERED text (which is byte-identical to before) with
  // only the batch slot left visible.
  assert.match(renderSection(on, { keep: ['memory_batch_writes'] }), /unfindable later\.\n\{\{memory_batch_writes\}\}- A tool result/)
  assert.equal(off.sections[0].text, on.sections[0].text, 'only the variable differs, never the section string')
})

test('handsOffRule is off by default, boolean-validated, and adds exactly one bullet when on', () => {
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, handsOffRule: 'yes' }), /`handsOffRule` must be a boolean/)
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: root })
  assert.equal(off.variables.get('memory_hands_off')(), '', 'off renders nothing, so the default prompt is unchanged')
  const on = fakeCtx()
  apply(on.ctx, { graphRoot: root, handsOffRule: true })
  const bullet = on.variables.get('memory_hands_off')()
  assert.match(bullet, /^- Only the memory tools write the memory graph: never create, change or delete anything inside its directory with shell, file or script tools, and never write your own import script\./)
  assert.ok(bullet.endsWith('\n'))
  assert.equal((bullet.match(/^- /gm) ?? []).length, 1, 'exactly one bullet')
  assert.equal(renderSection(on), renderSection(off).replace('- When you learn something durable', `${bullet}- When you learn something durable`))
  assert.equal(off.sections[0].text, on.sections[0].text, 'only the variable differs, never the section string')
})

// The batch is safe only because dsh serializes calls from a tool that has not
// declared itself concurrency-safe: write #2's `similar` scan sees write #1
// because #1 landed first. A later latency optimisation that flips the flag
// would silently kill in-batch dedup, so the absence is pinned here.
test('P7-C invariant: no memory tool declares itself concurrency-safe — batched writes must serialize', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root, batchWrites: true })
  assert.ok(tools.has('memory_write'))
  for (const [toolName, definition] of tools) {
    assert.equal(definition.isConcurrencySafe, undefined, `${toolName} must not opt into concurrent execution`)
  }
})

// F88 (#157): the attachment fabrication class. Round 12 invented a 1,274-char
// report on a turn whose whole input was 先念给我听听你写的内容 / 让我调出文档内容，稍等一下。
// and drew ZERO advisories; the 09-08 relapse drew `unsourced_assertions` and
// stored the file anyway. Measured separation on the replay corpora: the five
// known fabricated attachments cover 0.0–1.1% of their own turn, seventeen
// genuine ones 50.0–100%, and all 667 DEMO `_m` curated attachments at least
// 16.5%. So the precondition is traceability, checked before anything is
// written, on BOTH attach routes.
const TRACEABLE_TURN = 'The Demo access review covered CedarCheck and MapleCheck as vendors, the sandbox permit timeline, and the risk table for the training-workshop route. Morgan owns the Northcard exercise packet; the grace period is six weeks.'
// Same length class as the corpus fabrications, sharing nothing with the turn.
// The turn's own sentences, reordered and headed — capture, not invention.
const TRACEABLE_ATTACHMENT = '# Demo access review\n\n- Vendors evaluated: CedarCheck and MapleCheck\n- The training-workshop route carries the risk table\n- Morgan owns the Northcard exercise packet\n- Grace period: six weeks\n- The sandbox permit timeline was covered\n'
const UNTRACEABLE = '# 季度营收复盘\n\n昨天的董事会确认了三项决议：一是把仓储合约续到明年三月，二是把配送半径缩到八公里，三是把客服排班改成两班制。\n'.repeat(4)

test('F88: an attachment the turn does not carry is refused on the inline route, and nothing lands (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-inline-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  await assert.rejects(
    () => write.execute(
      { description: 'Demo access review', body: 'gist', attach: { filename: 'kyc-review.md', content: UNTRACEABLE } },
      execWithTurn(TRACEABLE_TURN),
    ),
    /memory_write: this attachment is not traceable to this conversation — 0\.0% of its content appears in what was said, under the 15% floor/,
  )
  // The whole write rejects: no node, so no body naming a document nobody can produce.
  assert.deepEqual((await fsp.readdir(fresh)).filter((entry) => ULID_RE.test(entry)), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: the standalone memory_attach route is checked too — one route only would be a bypass (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-standalone-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const id = (await write.execute({ description: 'Demo access review', body: 'gist' }, execWithTurn(TRACEABLE_TURN))).id
  await assert.rejects(
    () => attach.execute({ id, filename: 'kyc-review.md', content: UNTRACEABLE }, execWithTurn(TRACEABLE_TURN)),
    /memory_attach: this attachment is not traceable to this conversation/,
  )
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((entry) => entry.endsWith('.md') && entry !== 'node.md'), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: an attachment the turn does carry lands on both routes (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-pass-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  // The detail tier of the turn itself: its own sentences, reordered and headed.
  const traceable = '# Demo access review\n\n- Vendors evaluated: CedarCheck and MapleCheck\n- The training-workshop route carries the risk table\n- Morgan owns the Northcard exercise packet\n- Grace period: six weeks\n- The sandbox permit timeline was covered\n'
  const res = await write.execute(
    { description: 'Demo access review', body: 'gist', attach: { filename: 'kyc-review.md', content: traceable } },
    execWithTurn(TRACEABLE_TURN),
  )
  assert.equal(res.attached.status, 'created')
  const second = await attach.execute({ id: res.id, filename: 'kyc-vendors.md', content: traceable }, execWithTurn(TRACEABLE_TURN))
  assert.equal(second.status, 'created')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: three exemptions keep the check fail-toward-silence — no turn, short content, and a zeroed floor (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-exempt-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // No turn text (direct callers, tests, other runtimes): a missing operand is
  // never evidence of fabrication.
  const noTurn = await write.execute({ description: 'a', body: 'b', attach: { filename: 'x.md', content: UNTRACEABLE } }, {})
  assert.equal(noTurn.attached.status, 'created')
  // Under the character floor: one shared word would swing the ratio.
  const short = await write.execute(
    { description: 'b', body: 'c', attach: { filename: 'y.md', content: '一句与本轮无关的短句。' } },
    execWithTurn(TRACEABLE_TURN),
  )
  assert.equal(short.attached.status, 'created')
  await fsp.rm(fresh, { recursive: true, force: true })

  // attachTraceMin: 0 — the deployment opted out, same payload lands.
  const opted = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-off-'))
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: opted, indexCacheMs: 0, attachTraceMin: 0 })
  const res = await off.tools.get('memory_write').execute(
    { description: 'a', body: 'b', attach: { filename: 'x.md', content: UNTRACEABLE } },
    execWithTurn(TRACEABLE_TURN),
  )
  assert.equal(res.attached.status, 'created')
  await fsp.rm(opted, { recursive: true, force: true })
})

test('F88: from_path is exempt — those bytes came from disk, not from the turn (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-frompath-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, attachFromPathRoots: [os.tmpdir()] })
  const id = (await tools.get('memory_write').execute({ description: 'thread', body: 'gist' }, execWithTurn(TRACEABLE_TURN))).id
  // The loose file must live OUTSIDE the graph — attachFromPath refuses a
  // source that already travels with a node.
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-loose-'))
  const loose = path.join(elsewhere, 'loose-report.md')
  await fsp.writeFile(loose, UNTRACEABLE)
  const moved = await tools.get('memory_attach').execute({ id, from_path: loose }, execWithTurn(TRACEABLE_TURN))
  assert.equal(moved.status, 'created')
  assert.equal(moved.file, 'loose-report.md')
  await fsp.rm(elsewhere, { recursive: true, force: true })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: attachTraceMin must be a number in [0,1] (#157)', () => {
  for (const bad of [1.5, -0.1, 'x']) {
    assert.throws(
      () => apply(fakeCtx().ctx, { graphRoot: root, attachTraceMin: bad }),
      /`attachTraceMin` must be a number in \[0,1\]/,
      `${JSON.stringify(bad)} must be refused`,
    )
  }
})

test('F88: turnCoverage reads words and unspaced-script bigrams, and vouches for what it cannot judge (#157)', () => {
  const wordy = (words) => words.join(' ')
  const TWENTY = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango']
  // Word boundaries must survive — gluing the text before extracting words was
  // the bug that scored every English payload at zero.
  assert.equal(turnCoverage(wordy(TWENTY), wordy(TWENTY)), 1)
  assert.equal(turnCoverage(wordy(TWENTY), wordy(TWENTY.slice(0, 10))), 0.5)
  // Unspaced scripts are read as character bigrams — Han beyond the BMP range
  // a hand-written class would have missed, plus kana, Hangul and Thai.
  assert.equal(turnCoverage('风控方案与合规路径的讨论记录', '本轮讨论了风控方案与合规路径的讨论记录细节'), 1)
  assert.ok(turnCoverage('风控方案与合规路径的讨论记录', '完全无关的另一个话题的内容') < 0.15)
  assert.ok(turnCoverage('회의록 초안 검토 의견 정리 자료', '전혀 관계없는 다른 주제의 내용') < 0.15, 'Hangul is read, not silently vouched for')
  // Long enough to clear the token floor — the point is that Cyrillic is READ,
  // where an ASCII-only word class scored it 1 and waved it through.
  assert.ok(
    turnCoverage(
      'Протокол совещания по управлению рисками: проверка контрагентов, мониторинг транзакций, ручная верификация документов и сроки внедрения',
      'Совсем другая тема без всякой связи с предыдущим обсуждением',
    ) < 0.15,
    'Cyrillic is read too',
  )
  // What it cannot judge, it vouches for: too few tokens, none at all, and
  // non-string arguments (the exported function's fail-toward-silence).
  assert.equal(turnCoverage('alpha bravo', 'zulu'), 1, 'under the token floor')
  assert.equal(turnCoverage('', 'anything'), 1)
  assert.equal(turnCoverage('!!! --- 123 456', 'anything'), 1)
  assert.equal(turnCoverage(undefined, 'anything'), 1)
  assert.equal(turnCoverage('alpha bravo charlie delta echo foxtrot golf hotel', undefined), 1)
})

// The threshold's placement, pinned by behaviour rather than by the error
// string: 20 distinct tokens, so each one present is worth exactly 0.05.
const TWENTY_TOKENS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango']
// Repeats add no distinct tokens; the dots pad to clear the byte floor.
const twentyTokenPayload = () => `${TWENTY_TOKENS.join(' ')} `.repeat(4) + '.'.repeat(600)

test('F88: the floor is inclusive — coverage exactly at attachTraceMin stores, below it refuses (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-boundary-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const payload = twentyTokenPayload()
  // 3 of 20 tokens present = 0.15 exactly.
  const at = await write.execute(
    { description: 'a', body: 'b', attach: { filename: 'at-floor.md', content: payload } },
    execWithTurn('alpha bravo charlie and nothing else that matches'),
  )
  assert.equal(at.attached.status, 'created', '0.15 is not under 0.15')
  // 2 of 20 = 0.10, one token below.
  await assert.rejects(
    () => write.execute(
      { description: 'c', body: 'd', attach: { filename: 'under-floor.md', content: payload } },
      execWithTurn('alpha bravo and nothing else that matches'),
    ),
    /10\.0% of its content appears in what was said/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: the update route is checked too, not only create (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-update-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const id = (await write.execute({ description: 'Demo access review', body: 'gist' }, execWithTurn(TRACEABLE_TURN))).id
  await assert.rejects(
    () => write.execute({ id, body: 'gist, revised', attach: { filename: 'kyc-review.md', content: UNTRACEABLE } }, execWithTurn(TRACEABLE_TURN)),
    /memory_write: this attachment is not traceable to this conversation/,
  )
  const files = (await fsp.readdir(path.join(fresh, id))).filter((entry) => entry.endsWith('.md') && entry !== 'node.md')
  assert.deepEqual(files, [], 'the update stored no file')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: the size floor is measured in UTF-8 bytes, so a dense script gets no free pass (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-bytes-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const tokens = `${TWENTY_TOKENS.join(' ')} `
  const under = tokens + '.'.repeat(599 - Buffer.byteLength(tokens, 'utf8'))
  const over = tokens + '.'.repeat(601 - Buffer.byteLength(tokens, 'utf8'))
  assert.equal(Buffer.byteLength(under, 'utf8'), 599)
  assert.equal(Buffer.byteLength(over, 'utf8'), 601)
  const stored = await write.execute({ description: 'a', body: 'b', attach: { filename: 'under.md', content: under } }, execWithTurn('nothing shared whatsoever'))
  assert.equal(stored.attached.status, 'created', 'under the byte floor, unmeasured')
  await assert.rejects(
    () => write.execute({ description: 'c', body: 'd', attach: { filename: 'over.md', content: over } }, execWithTurn('nothing shared whatsoever')),
    /not traceable to this conversation/,
    'one byte over the floor, measured',
  )
  // 200 characters of Chinese is ~570 bytes — under a character floor it would
  // have been a complete invented card, exempt.
  assert.ok(Buffer.byteLength('会议纪要'.repeat(50), 'utf8') > 500)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: a payload with too few tokens to judge is exempt, not vouched for by accident (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-tokens-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  // A numeric table: three column headers and a thousand digits. The
  // denominator is too small for the ratio to mean anything either way.
  const table = 'date | amount | vendor\n' + '2026-09-01 | 1,284,500 | 17.3%\n'.repeat(40)
  const res = await tools.get('memory_write').execute(
    { description: 'ledger', body: 'gist', attach: { filename: 'ledger.md', content: table } },
    execWithTurn('save the table we just pulled'),
  )
  assert.equal(res.attached.status, 'created')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: the traceability window reads the exchange, not just the tail user turn (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-window-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  // The canonical flow: the assistant produced the material, the user turn is
  // two words. Scored against the tail turn alone this genuine attachment
  // measures 0% and is refused.
  const material = '风控方案包括三个环节：交易监控、名单筛查与人工复核。KYC 实现思路分为身份采集、证件核验与活体检测三步。'
  const exec = { agent: { session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把风控和 KYC 的讨论讲一遍' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: material }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'TOOL RESULT — excluded from the window' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '存一下' }] },
  ] } } }
  const res = await tools.get('memory_write').execute(
    { description: '风控与 KYC 讨论', body: '要点见附件', attach: { filename: 'risk-kyc.md', content: `# 风控与 KYC\n\n${material}\n`.repeat(3) } },
    exec,
  )
  assert.equal(res.attached.status, 'created', 'the assistant half of the exchange vouches for the detail tier')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: the window stops at the last user message — this turn\'s own text cannot vouch for itself (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-selfvouch-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  // The fabrication route with the window in hand: narrate the invented report
  // in this turn's assistant text, then attach it. If the window reached past
  // the user's request into the writer's own output, coverage would be ~1.
  const invented = '# 物流×仓储会议纪要\n\n联合贷款方案确定为仓储账户授信加物流风控，灰度节奏定在十一月中旬，坏账科目单列。\n'.repeat(4)
  const exec = { agent: { session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '先念给我听听你写的内容' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: invented }] },
  ] } } }
  await assert.rejects(
    () => tools.get('memory_write').execute(
      { description: '会议纪要', body: '详见附件', attach: { filename: 'meeting-minutes.md', content: invented } },
      exec,
    ),
    /not traceable to this conversation/,
    'the assistant\'s own current-turn text is not evidence',
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.1: after a refusal the node takes no narrative for the rest of the turn — the demo-freeze laundering route (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-freeze-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const exec = execWithTurn(TRACEABLE_TURN)
  const id = (await write.execute({ description: 'Demo access review', body: '待交付：KYC 审核汇总' }, exec)).id

  // 1. the invented attachment is refused
  await assert.rejects(
    () => write.execute({ id, body: '待交付：KYC 审核汇总', attach: { filename: 'kyc.md', content: UNTRACEABLE } }, exec),
    /not traceable to this conversation/,
  )
  // 2. the retry that drops the file and keeps the claim in prose is refused too —
  //    this is exactly what demo-freeze's turn 6 did (body 233 -> 459 chars).
  await assert.rejects(
    () => write.execute({ id, body: `状态：草稿已生成并念出，待用户确认。${'助手念出草稿全文后提问有没有需要调整或补充的地方。'.repeat(14)}` }, exec),
    /this node is closed for the rest of this turn/,
  )
  // 3. the sanctioned no-change line still lands, so the writer keeps one legal
  //    move — APPENDED to the stored body (F88.4, #219): the line alone would
  //    replace the body with itself, the deletion the freeze used to reward.
  const ok = await write.execute({ id, body: '待交付：KYC 审核汇总\n状态未变（turn 6 无新信息）' }, exec)
  assert.equal(ok.id, id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.1: the freeze lifts on the next user turn, and never touches another node (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-thaw-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const turnOne = execWithTurn(TRACEABLE_TURN)
  const id = (await write.execute({ description: 'Demo access review', body: 'gist' }, turnOne)).id
  const other = (await write.execute({ description: 'unrelated thread', body: 'gist' }, turnOne)).id
  await assert.rejects(
    () => write.execute({ id, body: 'gist', attach: { filename: 'kyc.md', content: UNTRACEABLE } }, turnOne),
    /not traceable/,
  )
  const long = `本轮讨论了 KYC 与风控的实现细节。${'补充说明与后续安排。'.repeat(20)}`
  // A different node is not frozen.
  assert.ok((await write.execute({ id: other, body: long }, turnOne)).id === other)
  // A second user turn re-arms the counter, so the node is writable again.
  const turnTwo = { agent: { session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: TRACEABLE_TURN }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续，把 KYC 的结论写清楚' }] },
  ] } } }
  assert.ok((await write.execute({ id, body: long }, turnTwo)).id === id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F88.4 (#219, Finding 6): the freeze bounded the TOTAL body, and `body`
// replaces the whole body — so on demo-delta-v2 t20 the 612/567/560-char writes
// that carried the handoff forward were refused and the 94-char write holding
// only the 状态未变 line was accepted, cutting 2,443 chars to 94. The bound is
// on what the write ADDS, and a write that does not carry the stored body
// forward is refused whatever its size.
test('F88.4: the post-refusal freeze measures the delta — an append lands, a shrink is refused, a large append is refused (#219)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-demo-delta-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const exec = execWithTurn(TRACEABLE_TURN)
  // A handoff well past the 200-char bound, as the destroyed node was.
  const stored = `# 演练交接\n\n${'- 待办：向 Morgan 确认 Northcard 演练包的校验时间，并把沙盒许可时间线同步给教练。\n'.repeat(12)}`
  assert.ok(stored.length > 600)
  const id = (await write.execute({ description: 'Demo access handoff', body: stored, type: 'handoff' }, exec)).id
  await assert.rejects(
    () => write.execute({ id, body: stored, attach: { filename: 'kyc.md', content: UNTRACEABLE } }, exec),
    /not traceable to this conversation/,
  )
  // The t20 regression: the line alone passed the old bound and deleted the body.
  await assert.rejects(
    () => write.execute({ id, body: '状态未变（turn 20 无新信息）' }, exec),
    /drops stored content: it does not begin with the \d+ characters the node holds/,
    'a write that shrinks the body to the line is a deletion, not the sanctioned move',
  )
  assert.equal((await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')).includes(stored.trim()), true, 'nothing was written')
  // A body that keeps the prior text and rewrites its head is a drop too.
  await assert.rejects(
    () => write.execute({ id, body: `${stored.slice(20)}\n状态未变（turn 20 无新信息）` }, exec),
    /drops stored content/,
  )
  // Preserving the body and appending a narrative past the bound is the
  // laundering F88.1 exists to stop — refused on the ADDED characters.
  await assert.rejects(
    () => write.execute({ id, body: `${stored}\n${'助手念出草稿全文后提问有没有需要调整或补充的地方。'.repeat(10)}` }, exec),
    /adds \d+ characters to the body/,
  )
  // The sanctioned move — the t20 writes the old bound refused — lands.
  const ok = await write.execute({ id, body: `${stored}\n状态未变（turn 20 无新信息）` }, exec)
  assert.equal(ok.id, id)
  const after = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  assert.ok(after.includes(stored.trim()), 'the prior body survived')
  assert.match(after, /状态未变（turn 20 无新信息）$/m, 'the line was appended')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.4: a frozen node the session has not read, or that changed underneath it, is the read gate\'s to refuse (#219)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-demo-delta-gate-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const read = tools.get('memory_read')
  const a = { ...execWithTurn(TRACEABLE_TURN), agent: { ...execWithTurn(TRACEABLE_TURN).agent, id: 'session-A' } }
  const b = { ...execWithTurn(TRACEABLE_TURN), agent: { ...execWithTurn(TRACEABLE_TURN).agent, id: 'session-B' } }
  const id = (await write.execute({ description: 'Demo access handoff', body: '待交付：KYC 审核汇总', type: 'handoff' }, a)).id
  await read.execute({ id }, b)
  await write.execute({ id, body: '待交付：KYC 审核汇总。B 补充了两条结论。' }, b)
  await assert.rejects(() => write.execute({ id, body: '待交付：KYC 审核汇总', attach: { filename: 'kyc.md', content: UNTRACEABLE } }, a), /not traceable/)
  // A's expectation is stale: a "drops stored content" verdict here would be
  // measured against B's bytes, which A never read — the fix is to re-read,
  // and only the gate says so.
  await assert.rejects(
    () => write.execute({ id, body: '待交付：KYC 审核汇总\n状态未变（turn 6 无新信息）' }, a),
    /changed since it was read — a Stale Write/,
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F89 (#219; ADR-0014): `memory_write` replaces the whole body, so revising a
// node re-emits every unchanged character — 48% of everything written on
// demo-delta-v2, 72% on demo-delta — and the same replace semantics turned the F88.1
// freeze into a delete-by-rewrite engine (F88.4 above). `append` is a
// body-only route: the plugin joins; the read and hash gates are moot on the
// work-state types that carry 26/26, 45/46 and 17/17 of observed appends; and
// body-only IS the safety property — no description refresh and no supersede
// can ride it, so no fact change can either.
const f89Graph = async (name) => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), `memgraph-f89-${name}-`))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, appendWrites: true })
  return { fresh, write: tools.get('memory_write'), read: tools.get('memory_read') }
}

test('F89: appendWrites is off by default, boolean-validated, and the field exists only when on (#219)', async () => {
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, appendWrites: 'yes' }), /`appendWrites` must be a boolean/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, appendWrites: 1 }), /`appendWrites` must be a boolean/)
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: root })
  const exec = { sessionId: 'f89-flag' }
  const ledger = (await off.tools.get('memory_write').execute({ description: 'flag ledger', body: '第一条', type: 'handoff' }, exec)).id
  assert.equal(off.tools.get('memory_write').parameters.properties.append, undefined, 'off: the schema does not advertise the field')
  await assert.rejects(
    () => off.tools.get('memory_write').execute({ id: ledger, append: '第二条' }, exec),
    ToolArgsError,
    'off: the boundary rejects it like any undeclared property, and nothing lands',
  )
  const offView = await off.tools.get('memory_read').execute({ id: ledger }, exec)
  assert.equal(offView.body.trim(), '第一条')
  assert.match(off.tools.get('memory_read').output.render({}, offView)[0].text, /— via memory_write with this id, never a narrative/)
  assert.equal(off.variables.get('memory_append_line')(), 'appended line')
  const on = fakeCtx()
  apply(on.ctx, { graphRoot: root, appendWrites: true })
  const field = on.tools.get('memory_write').parameters.properties.append
  assert.equal(field.type, 'string')
  // #219 Finding 5: a schema is re-sent on every step, so the field pays ~200 chars, not a tool's 500-1,500.
  assert.ok(field.description.length <= 210, `the description is budgeted at ~200 chars, got ${field.description.length}`)
  assert.match(field.description, /handoff\/thread\/journal/)
  assert.equal(on.variables.get('memory_append_line')(), 'line, via `append`')
  // #263 W2.1: the phrase slot now sits inside a rendered block rather than in
  // SECTION_TEXT, so this asserts the RENDERED sentence — the text the model
  // actually reads, in both shapes — instead of the template token.
  assert.match(renderSection(on), /exactly one line, via `append` — 状态未变（turn N 无新信息）/)
  assert.match(renderSection(off), /exactly one appended line — 状态未变（turn N 无新信息）/)
  assert.equal(on.sections[0].text, off.sections[0].text, 'only the slot differs, never the section string')
  await on.tools.get('memory_read').execute({ id: ledger }, exec)
  assert.match(on.tools.get('memory_read').output.render({}, offView)[0].text, /— via memory_write `append` with this id, never a narrative/)
  assert.equal(on.tools.get('memory_read').output.render({}, offView)[0].text.length - off.tools.get('memory_read').output.render({}, offView)[0].text.length, '`append` '.length, 'the reminder grows by the route\'s name and nothing else')
})

test('F89: append joins with exactly one blank line, is the body when the body is empty, and is unescaped once (#219)', async () => {
  const { fresh, write, read } = await f89Graph('join')
  const exec = { sessionId: 'f89-join' }
  const id = (await write.execute({ description: 'ledger', body: '- 2030-04-15 开工\n\n\n', type: 'thread' }, exec)).id
  const one = await write.execute({ id, append: '\n- 2030-04-16 待办：确认 Morgan 的演练包\n' }, exec)
  assert.equal(one.created, false)
  const joined = '- 2030-04-15 开工\n\n- 2030-04-16 待办：确认 Morgan 的演练包'
  assert.equal((await read.execute({ id }, exec)).body.trim(), joined, 'both sides trimmed, one blank line between')
  assert.equal(one.body_chars, joined.length, 'the result carries the body\'s new size')
  assert.match(write.output.render({}, one)[0].text, /^Appended to \S+ — ledger \(0 links, body now \d+ chars\)/, 'the outcome head confirms the size')
  // A writer that escapes its newlines must not land literal \n (F63): decoded
  // exactly once, like `body`.
  await write.execute({ id, append: '状态未变（turn 3 无新信息）\\n补充：无' }, exec)
  const body = (await read.execute({ id }, exec)).body
  assert.match(body, /\n\n状态未变（turn 3 无新信息）\n补充：无\s*$/)
  assert.doesNotMatch(body, /\\n/)
  // An empty body: the append IS the body, no leading separator.
  const empty = (await write.execute({ description: 'empty ledger', body: '', type: 'journal' }, exec)).id
  await write.execute({ id: empty, append: '首条记录' }, exec)
  assert.equal((await read.execute({ id: empty }, exec)).body.trim(), '首条记录')
  // Decoded exactly once on the empty-body route too (terra review of
  // 73b020c): a doubly-escaped newline loses ONE layer, not both, and
  // body_chars is the length on disk.
  const twice = (await write.execute({ description: 'empty twice', body: '', type: 'journal' }, exec)).id
  const once = await write.execute({ id: twice, append: 'line one\\\\nline two' }, exec)
  const stored = (await read.execute({ id: twice }, exec)).body.trim()
  assert.equal(stored, 'line one\\nline two', 'one layer decoded — a literal \\n survives, no real newline minted')
  assert.equal(once.body_chars, stored.length)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F89: append is body-only — a companion field, or a missing id, rejects before anything is written (#219)', async () => {
  const { fresh, write } = await f89Graph('bodyonly')
  const exec = { sessionId: 'f89-bodyonly' }
  const other = (await write.execute({ description: 'peer', body: 'peer' }, exec)).id
  const id = (await write.execute({ description: 'ledger', body: 'stored', type: 'handoff' }, exec)).id
  const before = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  await assert.rejects(() => write.execute({ id, append: 'x', body: 'y' }, exec), /`append` and `body` cannot be combined — `append` adds below the stored body, `body` replaces it/)
  await assert.rejects(() => write.execute({ append: 'x', description: 'd' }, exec), /`append` needs `id` — it extends a node that already exists/)
  for (const [field, value] of [
    ['description', 'refreshed'],
    ['type', 'journal'],
    ['links', [other]],
    ['typed_links', [{ id: other, type: 'relates-to' }]],
    ['attach', { filename: 'detail.md', content: 'detail' }],
  ]) {
    await assert.rejects(
      () => write.execute({ id, append: 'x', [field]: value }, exec),
      new RegExp(`\`append\` cannot carry \`${field}\` — an append only adds text below the body\\. To change what the node says .* memory_read it and write the full \`body\` with \`id\``),
      field,
    )
  }
  // Two at once are both named; `supersedes`+`id` is already its own contradiction.
  await assert.rejects(() => write.execute({ id, append: 'x', description: 'd', type: 'journal' }, exec), /cannot carry `description`, `type`/)
  await assert.rejects(() => write.execute({ id, append: 'x', supersedes: other }, exec), /`supersedes` cannot be combined with `id` — nothing was written/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8'), before, 'every rejection left the node untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F89: on handoff/thread/journal an append needs neither a prior read nor a current hash; every other type keeps both gates (#219)', async () => {
  const { fresh, write, read } = await f89Graph('gates')
  const a = { sessionId: 'f89-gates-A' }
  const b = { sessionId: 'f89-gates-B' }
  // Reads below go through C: a read IS what seeds an expectation, and this
  // test is about sessions that have none.
  const c = { sessionId: 'f89-gates-C' }
  for (const type of ['handoff', 'thread', 'journal']) {
    const id = (await write.execute({ description: `${type} ledger`, body: '第一条', type }, a)).id
    // B has never read the node.
    const res = await write.execute({ id, append: `第二条（${type}）` }, b)
    assert.equal(res.body_chars, `第一条\n\n第二条（${type}）`.length, `${type}: an unread append lands`)
    // A's expectation is now stale — B wrote — and an append still lands,
    // while a full-body write from the same expectation is still a Stale Write.
    await write.execute({ id, append: '第三条' }, a)
    assert.equal((await read.execute({ id }, c)).body.trim(), `第一条\n\n第二条（${type}）\n\n第三条`, `${type}: appends never clobber`)
    await assert.rejects(() => write.execute({ id, body: '改写' }, a), /changed since it was read — a Stale Write/, `${type}: the exemption is append-only`)
    // Nor does an unread append seed an expectation: B still has not read the
    // body, so B's full-body write still meets the read gate.
    await assert.rejects(() => write.execute({ id, body: '改写' }, b), /has not been read this session/, `${type}: appending is not reading`)
  }
  // The one `decision` append in demo-delta-v2 takes the full route — a decision
  // changing is exactly the supersede case.
  const decision = (await write.execute({ description: 'chose X because Y', body: '因为 Y', type: 'decision' }, a)).id
  await assert.rejects(() => write.execute({ id: decision, append: '补充' }, b), /has not been read this session — memory_read it before updating/)
  await read.execute({ id: decision }, b)
  assert.equal((await write.execute({ id: decision, append: '补充' }, b)).body_chars, '因为 Y\n\n补充'.length, 'read, it lands like any update')
  await assert.rejects(() => write.execute({ id: decision, append: '再补充' }, a), /changed since it was read — a Stale Write/, 'and the hash gate holds too')
  const untyped = (await write.execute({ description: 'untyped', body: 'p' }, a)).id
  await assert.rejects(() => write.execute({ id: untyped, append: 'q' }, b), /has not been read this session/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F89: an append the body already carries past 70% draws restated_append; the noise floor, a short text and the no-change line do not (#219)', async () => {
  const { fresh, write } = await f89Graph('restate')
  const exec = { sessionId: 'f89-restate' }
  const para = '待办：向 Morgan 确认 Northcard 演练包的校验时间，并把沙盒许可时间线同步给教练，风险表由 MapleCheck 试验路线承担。'
  const id = (await write.execute({ description: 'Demo access ledger', body: para, type: 'thread' }, exec)).id
  const dup = await write.execute({ id, append: `${para}（重复记录）` }, exec)
  assert.ok(dup.restated_append >= 70, `fires past the threshold: ${dup.restated_append}`)
  assert.match(write.output.render({}, dup)[0].text, /This append restates the body — \d+% of it was already there\. memory_read \S+ before appending again, and add only what the node does not yet say\./)
  const journal = (await fsp.readFile(path.join(fresh, '.advisories'), 'utf8')).split('\n').filter((line) => line.includes(' restated_append '))
  assert.equal(journal.length, 1, 'the finding is journaled')
  assert.match(journal[0], new RegExp(` restated_append ${id} \\d+%$`))
  // Shared dates and topic vocabulary are the noise floor (median 29-40% on
  // the corpus), and an ordinary next entry sits under it.
  const next = await write.execute({ id, append: '2030-04-18 与教练核对了演练供应商验收规则，CedarCheck 样例待回复。' }, exec)
  assert.equal(next.restated_append, undefined)
  // The mandated no-change line is exempt however often the ledger takes one.
  await write.execute({ id, append: '状态未变（turn 20 无新信息）' }, exec)
  const again = await write.execute({ id, append: '状态未变（turn 21 无新信息）' }, exec)
  assert.equal(again.restated_append, undefined)
  // Too short to judge is not a restatement — turnCoverage would vouch 1.0.
  const short = await write.execute({ id, append: '已完成' }, exec)
  assert.equal(short.restated_append, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F89: the freeze admits an append under the bound and refuses one over it — the sanctioned path through it, not an exemption (#219)', async () => {
  const { fresh, write } = await f89Graph('freeze')
  const exec = execWithTurn(TRACEABLE_TURN)
  const stored = `# 演练交接\n\n${'- 待办：向 Morgan 确认 Northcard 演练包的校验时间，并把沙盒许可时间线同步给教练。\n'.repeat(12)}`
  const id = (await write.execute({ description: 'Demo access handoff', body: stored, type: 'handoff' }, exec)).id
  await assert.rejects(() => write.execute({ id, body: stored, attach: { filename: 'kyc.md', content: UNTRACEABLE } }, exec), /not traceable/)
  await assert.rejects(
    () => write.execute({ id, append: '助手念出草稿全文后提问有没有需要调整或补充的地方。'.repeat(10) }, exec),
    /a \d+-character append is a restatement of it rather than a correction\. Append only one 状态未变/,
  )
  // With the route on, the drop refusal names it as the way out.
  await assert.rejects(() => write.execute({ id, body: '状态未变（turn 6 无新信息）' }, exec), /or pass just that line as `append` with this id/)
  const ok = await write.execute({ id, append: '状态未变（turn 6 无新信息）' }, exec)
  assert.equal(ok.body_chars, `${stored.trim()}\n\n状态未变（turn 6 无新信息）`.length, 'the frozen writer gets its confirmation — what demo-delta t6 never did')
  assert.match(write.output.render({}, ok)[0].text, /^Appended to/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F89: long_body fires on the joined body, so accretion by append is still seen (#219)', async () => {
  const { fresh, write } = await f89Graph('long')
  const exec = { sessionId: 'f89-long' }
  const id = (await write.execute({ description: 'sink', body: 'x'.repeat(1400), type: 'journal' }, exec)).id
  const res = await write.execute({ id, append: 'y'.repeat(200) }, exec)
  assert.equal(res.body_chars, 1400 + 2 + 200)
  assert.equal(res.long_body, res.body_chars, 'LONG_BODY_CHARS measures the body the append produced')
  assert.equal(res.blind_rewrite, undefined, 'an append is never a blind rewrite')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F88.5 (#219; terra review of 426933d, twice independently): F88.4 newly
// ACCEPTS a frozen retry that keeps the prose — and, because the writer read
// the node before F88.3's correction landed, the comparison forgives a body
// that omits that line. `body` replaces, so without this the freeze fix would
// delete its sibling guard's line in the same turn. The framework's own lines
// go back: the correction at the bottom, a top banner back on top.
test('F88.5: a frozen retry that omits the F88.3 correction or a supersede banner lands with both restored (#219)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f885-restore-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const read = tools.get('memory_read')
  const exec = execWithTurn(TRACEABLE_TURN)
  // 1. The correction class: the body names the file, the standalone attach is
  //    refused, F88.3 appends its line; the writer never saw it.
  const promise = '周报完整内容存于附件 weekly.md。'
  const id = (await write.execute({ description: '周报', body: promise, type: 'handoff' }, exec)).id
  await assert.rejects(() => attach.execute({ id, filename: 'weekly.md', content: UNTRACEABLE }, exec), /body already named/)
  assert.match(await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8'), /附件 weekly\.md 未写入/)
  const ok = await write.execute({ id, body: `${promise}\n状态未变（turn 6 无新信息）` }, exec)
  assert.equal(ok.id, id)
  const after = (await read.execute({ id }, exec)).body
  assert.match(after, /^周报完整内容存于附件 weekly\.md。\n状态未变（turn 6 无新信息）\n\n（\d{4}-\d{2}-\d{2}：上文提到的附件 weekly\.md 未写入/, 'the writer\'s text first, the correction restored below it')
  assert.equal((after.match(/未写入/g) ?? []).length, 1, 'restored once, never duplicated')
  // 2. The banner class: a superseded node is frozen, the retry omits the banner.
  const old = (await write.execute({ description: '旧决定', body: '选 A，因为成本低。', type: 'handoff' }, exec)).id
  await read.execute({ id: old }, exec)
  const successor = (await write.execute({ description: '新决定', body: '改选 B。', supersedes: old }, exec)).id
  assert.match((await read.execute({ id: old }, exec)).body, new RegExp(`^Superseded by ${successor} on \\d{4}-\\d{2}-\\d{2}\\.`))
  await assert.rejects(() => write.execute({ id: old, body: '选 A，因为成本低。', attach: { filename: 'cost.md', content: UNTRACEABLE } }, exec), /not traceable/)
  await write.execute({ id: old, body: '选 A，因为成本低。\n状态未变（turn 6 无新信息）' }, exec)
  const bannered = (await read.execute({ id: old }, exec)).body
  assert.match(bannered, new RegExp(`^Superseded by ${successor} on \\d{4}-\\d{2}-\\d{2}\\.\\n\\n选 A，因为成本低。\\n状态未变（turn 6 无新信息）`), 'the banner is back on top, where supersededBy reads it')
  assert.equal((bannered.match(/Superseded by/g) ?? []).length, 1)
  // 3. A retry that KEEPS the lines is stored as written — nothing is added twice.
  await write.execute({ id: old, body: `${bannered.trim()}\n状态未变（turn 6 再次无新信息）` }, exec)
  assert.equal(((await read.execute({ id: old }, exec)).body.match(/Superseded by/g) ?? []).length, 1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.3: a body already promising the refused file is marked, not left lying (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-promise-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const exec = execWithTurn(TRACEABLE_TURN)
  // A synthetic write-then-attach sequence: the body lands FIRST naming the file, and only the
  // separate attach meets the gate — so the promise is already on disk.
  const id = (await write.execute({ description: '周报', body: '周报完整内容存于附件 weekly-2025W32.md。' }, exec)).id
  await assert.rejects(
    () => attach.execute({ id, filename: 'weekly-2025W32.md', content: UNTRACEABLE }, exec),
    /body already named/,
    'the refusal says the promise was marked',
  )
  const node = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  assert.match(node, /附件 weekly-2025W32\.md 未写入/, 'the node carries the correction')
  assert.match(node, /周报完整内容存于附件/, "the writer's own line is kept, never rewritten")
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((e) => e === 'weekly-2025W32.md'), [], 'and no file was created')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.3: a body that promises nothing, and a name the node already has, are left alone (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-promise-quiet-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const exec = execWithTurn(TRACEABLE_TURN)
  const id = (await write.execute({ description: '周报', body: '本轮没有可存的附件。' }, exec)).id
  await assert.rejects(() => attach.execute({ id, filename: 'weekly.md', content: UNTRACEABLE }, exec), /not traceable/)
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8'), /未写入/, 'no promise, no correction')

  // A refused REPLACEMENT for a file the node really has: the body's mention
  // is true, so nothing is marked.
  const kept = (await write.execute({ description: '纪要', body: '详见附件 real.md', attach: { filename: 'real.md', content: TRACEABLE_ATTACHMENT } }, exec)).id
  await assert.rejects(() => attach.execute({ id: kept, filename: 'real.md', content: UNTRACEABLE }, exec), /not traceable/)
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, kept, 'node.md'), 'utf8'), /未写入/, 'the existing file makes the promise true')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.3: the correction does not strand the caller behind its own version gate (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-gate-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const exec = execWithTurn(TRACEABLE_TURN)
  const id = (await write.execute({ description: '周报', body: '周报完整内容存于附件 weekly.md。' }, exec)).id
  await assert.rejects(() => attach.execute({ id, filename: 'weekly.md', content: UNTRACEABLE }, exec), /body already named/)
  // F88.1 promises exactly one legal move after a refusal. The correction
  // rewrote node.md underneath the caller, so without refreshing this
  // session's expectation that move would fail as a Stale Write. The move is
  // the stored body plus the line (F88.4, #219) — and the caller never saw the
  // correction line, so the freeze must not count its absence as a drop.
  const ok = await write.execute({ id, body: '周报完整内容存于附件 weekly.md。\n状态未变（turn 6 无新信息）' }, exec)
  assert.equal(ok.id, id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.3: an invalid attachment name is rejected before anything can be marked (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-badname-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const exec = execWithTurn(TRACEABLE_TURN)
  const id = (await tools.get('memory_write').execute({ description: '周报', body: '详见附件 .weekly.md' }, exec)).id
  const before = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  await assert.rejects(
    () => tools.get('memory_attach').execute({ id, filename: '.weekly.md', content: UNTRACEABLE }, exec),
    /filename/,
    'the name fails first, not the traceability floor',
  )
  assert.equal(await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8'), before, 'a rejected name leaves the node untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88.3: the correction never refreshes an expectation another session already invalidated (#157)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f88-crosssession-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')
  const a = { ...execWithTurn(TRACEABLE_TURN), agent: { ...execWithTurn(TRACEABLE_TURN).agent, id: 'session-A' } }
  const b = { ...execWithTurn(TRACEABLE_TURN), agent: { ...execWithTurn(TRACEABLE_TURN).agent, id: 'session-B' } }
  const id = (await write.execute({ description: '周报', body: '周报完整内容存于附件 weekly.md。' }, a)).id
  // B rewrites the body A is holding an expectation for — and keeps the promise line.
  await tools.get('memory_read').execute({ id }, b)
  await write.execute({ id, body: '周报完整内容存于附件 weekly.md。B 补充了两条结论。' }, b)
  // A's attach is refused and the correction lands, but A still has not read B's body.
  await assert.rejects(() => attach.execute({ id, filename: 'weekly.md', content: UNTRACEABLE }, a), /not traceable/)
  await assert.rejects(
    () => write.execute({ id, body: '状态未变（turn 6 无新信息）' }, a),
    /changed since it was read|has not been read/,
    'the correction must not vouch for bytes this session never read',
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F78.1: salvage fails closed on both ambiguities rather than storing a guess (#171)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f78-failclosed-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const exec = execWithTurn(TRACEABLE_TURN)
  // A third property is indistinguishable from content — whatever the key is
  // spelled like, ASCII identifier or not (terra round 2).
  for (const raw of [
    '{"filename": "a.md", "content": "a "q" b", "note": "v"}',
    '{"filename": "a.md", "content": "a "q" b", "备注": "v"}',
    '{"filename": "a.md", "content": "a "q" b", "x-y": "v"}',
  ]) {
    await assert.rejects(() => write.execute({ description: 'x', attach: raw }, exec), /attach/, `left for the boundary: ${raw}`)
  }
  // A literal backslash-quote may be a correct escape or a broken one; either
  // reading silently corrupts embedded JSON or code, so neither is taken.
  await assert.rejects(
    () => write.execute({ description: 'x', attach: '{"filename": "a.md", "content": "code: {\\"k\\": 1} and "loose" quotes"}' }, exec),
    /attach/,
    'ambiguous escapes are never reconstructed',
  )
  // Pretty-printed whitespace before the closing brace is just formatting.
  const payload = 'CedarCheck and MapleCheck were the vendors; someone said "MapleCheck is the pilot choice" out loud. Morgan owns the Northcard exercise packet, and the grace period is six weeks.'
  const ok = await write.execute({ description: 'ok', body: 'gist', attach: `{"filename": "v.md", "content": "${payload}"  }` }, exec)
  assert.equal(ok.attached.status, 'created')
  assert.equal((await tools.get('memory_read_file').execute({ id: ok.id, file: 'v.md' }, {})).content, payload)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F78.1: a serialized attach whose payload quotes were never escaped is salvaged (#171)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f78-salvage-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // A synthetic serialization break: the object was serialized AND the
  // payload's own ASCII quotes were left unescaped, so F78's JSON.parse died
  // mid-content and the call was rejected at the boundary. The model then fell
  // back to write-then-attach — the split that lets a body naming the file
  // land before the gate ever sees the file.
  const payload = `# Demo access review\n\n- Vendors evaluated: CedarCheck and MapleCheck, and someone said "MapleCheck is the pilot choice" out loud\n- Morgan owns the Northcard exercise packet; the grace period is six weeks\n- The training-workshop route carries the risk table\n`
  const raw = `{"filename": "kyc-review.md", "content": "${payload.replaceAll('\n', '\\n')}"}`
  assert.throws(() => JSON.parse(raw), 'the fixture really is invalid JSON, exactly as the model emitted it')
  const stored = await write.execute({ description: 'Demo access review', body: '详见附件 kyc-review.md', attach: raw }, execWithTurn(TRACEABLE_TURN))
  assert.equal(stored.attached.status, 'created', 'the one-call path survives the bad serialization')
  const back = (await tools.get('memory_read_file').execute({ id: stored.id, file: 'kyc-review.md' }, {})).content
  assert.equal(back, payload, 'the unescaped quotes round-trip verbatim')
  // Anything that is not this exact shape is left for the boundary to reject,
  // with the same violation it always drew.
  await assert.rejects(() => write.execute({ description: 'x', attach: 'not json at all' }, execWithTurn(TRACEABLE_TURN)), /attach/)
  // Fail closed rather than guess: a third property after `content` would be
  // folded into the payload, and silently-wrong content is worse than a loud
  // rejection (terra review of 1bdaca8).
  await assert.rejects(
    () => write.execute({ description: 'x', attach: '{"filename": "a.md", "content": "a "q" b", "note": "v"}' }, execWithTurn(TRACEABLE_TURN)),
    /attach/,
    'an ambiguous salvage candidate is left for the boundary to reject',
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F88: attachTraceMin rejects NaN and Infinity, and treats null as absent (#157)', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -0.1, 'x', true, []]) {
    assert.throws(
      () => apply(fakeCtx().ctx, { graphRoot: root, attachTraceMin: bad }),
      /`attachTraceMin` must be a number in \[0,1\]/,
      `${JSON.stringify(bad)} must be refused`,
    )
  }
  // NaN is the load-bearing case: `NaN < 0` and `NaN > 1` are both false, and a
  // NaN floor makes `coverage >= floor` always false — every attachment refused.
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root, attachTraceMin: null }), 'null is absent, so the default applies')
})

// demo-quarantine (quarantine safety): the dsh runtime wrapper must be able to tell a
// call rejected at the argument boundary from one whose handler already ran and
// then threw. The only trusted source is the CALL, so `defineTool` publishes its
// private coerce+validate preparation through a registry keyed by the definition
// object itself — not through an exception class, code or message.
test('defineTool publishes its preparation, keyed by the definition object (quarantine safety)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prepare-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  try {
    // Every real registered tool is instrumented.
    for (const definition of tools.values()) {
      assert.equal(
        typeof trustedPreparationFor(definition),
        'function',
        `${definition.name} must expose a trusted preparation`,
      )
    }
    const prepare = trustedPreparationFor(tools.get('memory_write'))
    // The FULL pipeline: coercion first, exactly as execute runs it.
    const serialized = prepare({
      description: 'gist',
      body: 'body',
      attach: JSON.stringify({ filename: 'a.md', content: 'payload\n' }),
    })
    assert.equal(typeof serialized.args.attach, 'object', 'preparation exposes the coerced arguments')
    assert.equal(serialized.args.attach.filename, 'a.md')
    assert.deepEqual(serialized.violations, [], 'a repairable call is admitted')
    // The incident shape, and coercion's unrepairable leftovers, report the
    // same violations execute would have raised. #263 A2: the undeclared
    // property violation now also names the declared set — the retry needs to
    // know what the call MAY carry, not just what it may not.
    const incident = prepare({ description: 'gist', dependencies: [] })
    assert.equal(incident.violations.length, 1)
    assert.match(incident.violations[0], /^arguments\.dependencies is not a declared property/)
    assert.match(incident.violations[0], /— declared properties: id, description, body,/)
    assert.match(incident.violations[0], /supersedes/)
    assert.doesNotMatch(incident.violations[0], /append/, 'off: the undeclared route is not advertised')
    assert.deepEqual(prepare({ description: 'gist', body: 'b', attach: '[1, 2]' }).violations, [
      'arguments.attach must be object',
    ])
    // Preparation is a read-only check: nothing was written.
    assert.deepEqual(await fsp.readdir(fresh), [], 'preparation must not touch the graph')
  } finally {
    await fsp.rm(fresh, { recursive: true, force: true })
  }
})

test('preparation mirrors execute (violations and handler entry) without invoking the handler', async () => {
  let calls = 0
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['n'],
      properties: { n: { type: 'integer' } },
    },
    output: { schema: { type: 'object' }, render: () => '' },
    execute: async () => {
      calls += 1
      return { ok: true }
    },
  })
  const prepare = trustedPreparationFor(definition)
  assert.equal(typeof prepare, 'function')
  await assert.rejects(() => definition.execute({ n: 'x' }, {}), (error) => error instanceof ToolArgsError)
  assert.equal(calls, 0, 'a boundary rejection never reaches the handler')
  assert.deepEqual(prepare({ n: 'x' }).violations, ['arguments.n must be integer'])
  assert.deepEqual(prepare({ n: 1 }).violations, [])
  assert.deepEqual(await definition.execute({ n: 1 }, {}), { ok: true })
  assert.equal(calls, 1)
  // A hand-built/legacy definition is unknown to the registry: no evidence.
  assert.equal(trustedPreparationFor({ execute: async () => ({}) }), undefined)
  assert.equal(trustedPreparationFor(undefined), undefined)
  assert.equal(trustedPreparationFor(null), undefined)
})

// demo-boundary: pure argument contradictions are a boundary concern, not a handler
// one. They live in `defineTool`'s trusted preparation (`semantic`), run only
// AFTER the schema passes, and therefore reject a call before the handler can
// run — which is what makes `executionStarted: false` provable. The hook gets
// no graph, filesystem or session access by contract; that is enforced by
// review and by these tests, not by a sandbox.
test('semantic violations reject inside the trusted preparation, after the schema, without the handler (demo-boundary)', async () => {
  let handlerCalls = 0
  let semanticCalls = 0
  const definition = defineTool({
    name: 'semantic-probe',
    description: 'probe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string' }, supersedes: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: () => '' },
    semantic: (args) => {
      semanticCalls += 1
      return args.supersedes === undefined ? [] : ['`supersedes` is only valid when creating a node, not with `id`']
    },
    execute: async () => {
      handlerCalls += 1
      return { ok: true }
    },
  })
  const prepare = trustedPreparationFor(definition)
  // Schema first: an ill-typed call is rejected on the schema alone and the
  // semantic hook is never consulted (it would have to assume types otherwise).
  assert.deepEqual(prepare({ id: 5 }).violations, ['arguments.id must be string'])
  assert.equal(semanticCalls, 0)
  assert.deepEqual(prepare({ id: 'x', supersedes: 'y' }).violations, [
    '`supersedes` is only valid when creating a node, not with `id`',
  ])
  assert.equal(semanticCalls, 1)
  // The same verdict reaches execute: ToolArgsError, handler not entered.
  await assert.rejects(
    () => definition.execute({ id: 'x', supersedes: 'y' }, {}),
    (error) => error instanceof ToolArgsError && error.code === 'INVALID_ARGS',
  )
  assert.equal(handlerCalls, 0, 'a semantic rejection never reaches the handler')
  // A coherent call still runs, exactly once.
  assert.deepEqual(await definition.execute({ id: 'x' }, {}), { ok: true })
  assert.equal(handlerCalls, 1)
  // And the preparation stayed synchronous and repeatable: same input, same
  // verdict, no accumulation between the precheck and the execution pass.
  assert.deepEqual(prepare({ id: 'x', supersedes: 'y' }).violations, prepare({ id: 'x', supersedes: 'y' }).violations)
})

test('presentCall falls back to the generic card for a semantically invalid replay (demo-boundary)', () => {
  const definition = defineTool({
    name: 'semantic-present',
    description: 'probe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['n'],
      properties: { n: { type: 'integer' } },
    },
    output: { schema: { type: 'object' }, render: () => '' },
    semantic: (args) => (args.n < 0 ? ['arguments.n must not be negative'] : []),
    execute: async () => ({ ok: true }),
    presentCall: (args) => ({ card: 'generic', title: `n=${args.n}`, rawInput: args }),
  })
  assert.equal(definition.presentCall({ n: -1 }), undefined, 'a rejected replay renders the generic card')
  assert.deepEqual(definition.presentCall({ n: 2 }), { card: 'generic', title: 'n=2', rawInput: { n: 2 } })
})

// #247: an attachment could be REPLACED without ever being read. The A2A
// demo replay agent listed a node's `demo-weekly-summary-format.md` (1,696 B),
// never opened it, and a body-less memory_write replaced it with 11 bytes; a
// second call took it to 2 bytes. Both reported success, and `.node.md.prev`
// snapshots only the body, so the original was gone. The invariant pinned here:
// replacing an existing attachment with DIFFERENT bytes requires that this
// Session read the file in full at its current bytes, or wrote those bytes
// itself — and a refusal writes NOTHING, which is asserted against disk bytes
// rather than against the message.
test('#247: an unread attachment overwrite is refused on every route, and nothing is written', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-unseen-overwrite-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-unseen-source-'))
  const name = 'demo-weekly-summary-format.md'
  // The incident's exact size, so the message quotes the number the issue
  // recorded (ASCII only, so chars and bytes agree).
  const original = `# Demo weekly summary format\n${'format row\n'.repeat(100)}`.padEnd(1696, '.')
  assert.equal(Buffer.byteLength(original, 'utf8'), 1696)

  const first = await nextTurn(fresh, { attachFromPathRoots: [loose] })
  const id = (await first.get('memory_write').execute({ description: 'Notion 周报格式', body: `周报格式见 ${name}。`, attach: { filename: name, content: original } }, {})).id
  // A prior body version, so a `.node.md.prev` exists and must survive too.
  await first.get('memory_read').execute({ id }, {})
  await first.get('memory_write').execute({ id, body: `周报格式见 ${name}（已核对）。` }, {})
  const nodeFile = path.join(fresh, id, 'node.md')
  const attachment = path.join(fresh, id, name)
  const before = {
    node: await fsp.readFile(nodeFile),
    prev: await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE)),
    file: await fsp.readFile(attachment),
  }

  // A LATER Session, shaped exactly like the incident's agent: it reads the
  // NODE — which lists the file and its size — and never opens the file.
  const later = await nextTurn(fresh, { attachFromPathRoots: [loose] })
  await later.get('memory_read').execute({ id }, {})
  const refused = await later.get('memory_write').execute({ id, attach: { filename: name, content: '11 bytes!!!' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, new RegExp(`^memory_write: ${name} on ${id} holds 1696 bytes you have not fully read this session \\(or it changed since you read it\\) — attaching that name REPLACES the file\\. Nothing was written\\.`))
  // The message names every way out: read it all, use body/append, or rename.
  assert.match(refused.message, /memory_read_file every page and pass the full revised text/)
  assert.match(refused.message, /to add to the node, use body\/append/)
  assert.match(refused.message, /to keep both, use a new filename/)
  assert.deepEqual(await fsp.readFile(nodeFile), before.node, 'no body landed')
  assert.deepEqual(await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE)), before.prev, 'the body snapshot was not burned')
  assert.deepEqual(await fsp.readFile(attachment), before.file, 'the attachment is byte-identical')

  // The standalone route refuses the same overwrite…
  const viaContent = await later.get('memory_attach').execute({ id, filename: name, content: '2 bytes..' }, {}).then(() => undefined, (error) => error)
  assert.match(viaContent.message, new RegExp(`^memory_attach: ${name} on ${id} holds 1696 bytes`))
  // …and so does from_path, where the incoming bytes are the SOURCE file's.
  const source = path.join(loose, name)
  await fsp.writeFile(source, 'tiny\n')
  const viaPath = await later.get('memory_attach').execute({ id, from_path: source }, {}).then(() => undefined, (error) => error)
  assert.match(viaPath.message, new RegExp(`^memory_attach: ${name} on ${id} holds 1696 bytes`))
  assert.deepEqual(await fsp.readFile(attachment), before.file, 'neither route wrote a byte')
  assert.deepEqual(await fsp.readFile(nodeFile), before.node)
  assert.equal(await fsp.readFile(source, 'utf8'), 'tiny\n', 'the source is still untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

test('#247: a full read authorizes the replacement, and .prev keeps the prior bytes', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-then-overwrite-'))
  // The files are authored by a FIRST session, so the reading session has not
  // written them: its overwrite is a real overwrite and must keep a snapshot.
  const author = await nextTurn(fresh)
  const original = `${'format row\n'.repeat(100)}`.padEnd(1696, '.')
  const id = (await author.get('memory_write').execute({ description: '周报格式', body: '格式见 report.md。', attach: { filename: 'report.md', content: original } }, {})).id
  const big = 'x'.repeat(ATTACH_READ_BYTES + 10_000)
  const wideId = (await author.get('memory_write').execute({ description: '长转录', body: '全文见 transcript.md。', attach: { filename: 'transcript.md', content: big } }, {})).id

  const tools = await nextTurn(fresh)
  const write = tools.get('memory_write')
  // The node read is the body gate; only the FILE read authorizes the overwrite.
  await tools.get('memory_read').execute({ id }, {})
  const page = await tools.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  assert.equal(page.bytes, 1696)
  assert.ok(!('next_offset' in page), 'a 1,696-byte file is one page')
  const shrunk = await write.execute({ id, attach: { filename: 'report.md', content: 'short\n' } }, {})
  assert.equal(shrunk.attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'short\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), original, 'the prior bytes are recoverable, byte for byte')

  // A multi-page file: one page is not a read of the file, every page is.
  const firstPage = await tools.get('memory_read_file').execute({ id: wideId, file: 'transcript.md' }, {})
  assert.equal(firstPage.bytes, ATTACH_READ_BYTES)
  assert.equal(firstPage.next_offset, ATTACH_READ_BYTES)
  await tools.get('memory_read').execute({ id: wideId }, {})
  const trimmed = 'x'.repeat(big.length - 1)
  const partial = await write.execute({ id: wideId, attach: { filename: 'transcript.md', content: trimmed } }, {}).then(() => undefined, (error) => error)
  assert.match(partial.message, new RegExp(`holds ${big.length} bytes you have not fully read this session`))
  assert.equal((await fsp.readFile(path.join(fresh, wideId, 'transcript.md'), 'utf8')).length, big.length, 'the partial read changed nothing')
  const rest = await tools.get('memory_read_file').execute({ id: wideId, file: 'transcript.md', offset: firstPage.next_offset }, {})
  assert.equal(rest.content.length, big.length - ATTACH_READ_BYTES)
  const whole = await write.execute({ id: wideId, attach: { filename: 'transcript.md', content: trimmed } }, {})
  assert.equal(whole.attached.status, 'overwritten', 'every page read in order covers the file')
  assert.equal((await fsp.readFile(path.join(fresh, wideId, 'transcript.md'), 'utf8')).length, big.length - 1)
  assert.equal(await fsp.readFile(path.join(fresh, wideId, '.transcript.md.prev'), 'utf8'), big)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#247: a file changed out of band after the read is refused until it is read again', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-changed-after-read-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 report.md。', attach: { filename: 'report.md', content: `${'row\n'.repeat(20)}` } }, {})).id
  const tools = await nextTurn(fresh)
  await tools.get('memory_read').execute({ id }, {})
  await tools.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  // Somebody else rewrote the file behind this Session's back.
  await fsp.writeFile(path.join(fresh, id, 'report.md'), 'a different version\n')
  const refused = await tools.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'mine\n' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /holds 20 bytes you have not fully read this session \(or it changed since you read it\)/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'a different version\n')
  // Reading the CURRENT bytes authorizes it.
  await tools.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  assert.equal((await tools.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'mine\n' } }, {})).attached.status, 'overwritten')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#247: a file this Session authored needs no read, and a double overwrite keeps the pre-session prior', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-authored-overwrite-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 report.md。', attach: { filename: 'report.md', content: 'the original\n' } }, {})).id
  const prev = path.join(fresh, id, '.report.md.prev')

  // A second Session, which DOES read the file before replacing it: `.prev` is
  // born here and holds the version from before the session.
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'second\n' } }, {})
  assert.equal(await fsp.readFile(prev, 'utf8'), 'the original\n')

  // The incident's SECOND overwrite: same Session, no read in between, and the
  // bytes being replaced are its own — allowed, and `.prev` stays the
  // pre-session version instead of chasing the 7-byte intermediate.
  const again = await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: '3\n' } }, {})
  assert.equal(again.attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), '3\n')
  assert.equal(await fsp.readFile(prev, 'utf8'), 'the original\n', 'one deep, anchored to the session')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#247: a new filename and an identical-bytes re-attach need no read', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-new-name-overwrite-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: 'thread', body: 'v1', attach: { filename: 'a.md', content: 'A\n' } }, {})).id
  const second = (await author.get('memory_write').execute({ description: 'thread two', body: 'v1', attach: { filename: 'c.md', content: 'C\n' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  // Different bytes on a file this Session never read still refuse.
  const refused = await later.get('memory_write').execute({ id, attach: { filename: 'a.md', content: 'A2\n' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /holds 2 bytes you have not fully read this session/)
  // Identical bytes destroy nothing, so no read is owed — and no snapshot is
  // written, because there is nothing for THIS call to keep.
  const same = await later.get('memory_write').execute({ id, attach: { filename: 'a.md', content: 'A\n' } }, {})
  assert.equal(same.attached.status, 'overwritten')
  await assert.rejects(() => fsp.lstat(path.join(fresh, id, '.a.md.prev')), 'an identical overwrite writes no snapshot of its own')
  // A name the node does not carry yet needs no read either.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'b.md', content: 'B\n' } }, {})).attached.status, 'created')
  // Review finding 3: authorization and SNAPSHOT OBLIGATION are separate. The
  // identical-bytes write authorized replacing 'A\n' (this Session wrote it as
  // far as the guard is concerned) but it preserved nothing — so this changed
  // write must still put the pre-session bytes aside. Conflating the two used to
  // leave the original with no copy at all.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'a.md', content: 'A2\n' } }, {})).attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.a.md.prev'), 'utf8'), 'A\n', 'the pre-session bytes are kept even though an identical write preceded this one')
  // c.md was never touched by this Session, so it still needs its own read.
  await later.get('memory_read').execute({ id: second }, {})
  const unseen = await later.get('memory_write').execute({ id: second, attach: { filename: 'c.md', content: 'C2\n' } }, {}).then(() => undefined, (error) => error)
  assert.match(unseen.message, /holds 2 bytes you have not fully read this session/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// Review finding 3 + review-2: knowledge is per FILE. Equal bytes in a
// different file authorize nothing for this one, and an entry for that other
// file must never lend its `preserved` flag — the snapshot obligation is this
// file's own.
test('#247: an unrelated file holding equal bytes neither authorizes nor exempts (#247 review 3)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-unrelated-equal-bytes-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 report.md。', attach: { filename: 'report.md', content: 'same\n' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  // This Session writes the identical byte string under a different name: it has
  // `sha('same\n')` for the WRONG file, and that must buy nothing here.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'unrelated.md', content: 'same\n' } }, {})).attached.status, 'created')
  const refused = await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'changed\n' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /holds 5 bytes you have not fully read this session/, 'another file\'s bytes authorize nothing')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'same\n')
  // Once THIS file is read in full the replacement is authorized — and the
  // snapshot is still owed, because the other file's `preserved` does not cross.
  await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'changed\n' } }, {})).attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), 'same\n', 'a snapshot was owed and taken')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The same rule stated the way the review does (#247 review 2, Blocker): a FULL
// read of one file must not authorize replacing a DIFFERENT file that happens to
// hold the same bytes. Distinct inodes, distinct entries.
test('#247: reading a.md in full does not authorize replacing b.md (#247 review 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-two-equal-files-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({
    description: 'two equal files',
    body: '见 a.md 与 b.md。',
    attach: { filename: 'a.md', content: 'equal bytes\n' },
  }, {})).id
  // A second file with identical content, written out-of-band so neither the
  // create path nor an attach recorded it.
  await fsp.writeFile(path.join(fresh, id, 'b.md'), 'equal bytes\n')
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  const page = await later.get('memory_read_file').execute({ id, file: 'a.md' }, {})
  assert.equal(page.content, 'equal bytes\n')
  const refused = await later.get('memory_write').execute({ id, attach: { filename: 'b.md', content: 'replacement\n' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /b\.md on .* holds 12 bytes you have not fully read this session/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'b.md'), 'utf8'), 'equal bytes\n', 'b.md is untouched')
  // b.md has to earn its own read.
  await later.get('memory_read_file').execute({ id, file: 'b.md' }, {})
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'b.md', content: 'replacement\n' } }, {})).attached.status, 'overwritten')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #247 review 2, Blocker: a PARTIAL read must not become full authorization
// through another spelling of the same file. On APFS `report.md` and `Report.md`
// share one inode, so they share one entry — and that entry's ranges still have
// to cover the file.
test('#247: a partial read of one spelling does not authorize the other (#247 review 2)', async (t) => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-partial-alias-'))
  await fsp.writeFile(path.join(fresh, 'probe'), 'x')
  const caseInsensitive = await fsp.access(path.join(fresh, 'PROBE')).then(() => true, () => false)
  await fsp.rm(path.join(fresh, 'probe'))
  if (!caseInsensitive) {
    await fsp.rm(fresh, { recursive: true, force: true })
    return t.skip('case-sensitive filesystem: the two spellings are two files here')
  }
  const big = 'y'.repeat(ATTACH_READ_BYTES + 10_000)
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '长转录', body: '全文见 report.md。', attach: { filename: 'report.md', content: big } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  const firstPage = await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  assert.equal(firstPage.next_offset, ATTACH_READ_BYTES, 'only the first page was read')
  // The other spelling is the same file, so it sees the same partial entry — and
  // must still be refused, because the tail was never read.
  const refused = await later.get('memory_write').execute({ id, attach: { filename: 'Report.md', content: 'y'.repeat(1000) } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, new RegExp(`holds ${big.length} bytes you have not fully read this session`))
  assert.equal((await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8')).length, big.length, 'the file is untouched')
  // Reading the rest through the same alias authorizes it.
  await later.get('memory_read_file').execute({ id, file: 'Report.md', offset: firstPage.next_offset }, {})
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'Report.md', content: 'y'.repeat(1000) } }, {})).attached.status, 'overwritten')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #247 review 2, Major: an out-of-band rewrite that KEEPS the inode and the
// length must still invalidate a prior full read — the record requires its sha
// to match the bytes on disk, not just the identity.
test('#247: an in-place rewrite that keeps the inode invalidates a prior read (#247 review 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-inplace-rewrite-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '方形文件', body: '见 quad.md。', attach: { filename: 'quad.md', content: 'AAAA' } }, {})).id
  const file = path.join(fresh, id, 'quad.md')
  const before = await fsp.stat(file)
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  assert.equal((await later.get('memory_read_file').execute({ id, file: 'quad.md' }, {})).content, 'AAAA')
  // Same inode, same 4-byte length, different bytes (an editor saving in place).
  const handle = await fsp.open(file, 'r+')
  try {
    await handle.write(Buffer.from('BBBB'), 0, 4, 0)
  } finally {
    await handle.close()
  }
  const after = await fsp.stat(file)
  assert.equal(after.ino, before.ino, 'the rewrite kept the inode, or this is not the case under test')
  const refused = await later.get('memory_write').execute({ id, attach: { filename: 'quad.md', content: 'CCCC' } }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /holds 4 bytes you have not fully read this session \(or it changed since you read it\)/)
  assert.equal(await fsp.readFile(file, 'utf8'), 'BBBB', 'the in-place edit is untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// Review finding 2: the loose source is not covered by the node lock, so a
// separate pre-read can authorize bytes that are not the bytes published. The
// authorization must run on the exact Buffer `attachFromPath` is about to write.
test('#247: a from_path copy is authorized on the bytes it publishes, not on an earlier read (#247 review 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-toctou-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-toctou-src-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 notes.md。', attach: { filename: 'notes.md', content: 'original\n' } }, {})).id
  const source = path.join(loose, 'notes.md')
  await fsp.writeFile(source, 'original\n')
  // `attachFromPath` reads the REAL path (symlinks resolved), and `/var` vs
  // `/private/var` differ on macOS — so match on the resolved spelling.
  const realSource = await fsp.realpath(source)
  const later = await nextTurn(fresh, { attachFromPathRoots: [loose] })
  await later.get('memory_read').execute({ id }, {})

  // Swap the loose source on any read AFTER the first. A design that authorizes
  // an independently-read copy performs that second read and then publishes
  // bytes nobody approved; this design reads the source once, for both.
  const realOpen = fsp.open
  let opens = 0
  fsp.open = async (file, ...rest) => {
    if (file === realSource) {
      opens += 1
      if (opens > 1) await fsp.writeFile(realSource, 'different\n')
    }
    return realOpen.call(fsp, file, ...rest)
  }
  try {
    await later.get('memory_attach').execute({ id, from_path: source }, {})
  } finally {
    fsp.open = realOpen
  }
  assert.equal(opens, 1, 'the source is read once: the decision and the copy share that read')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'original\n', 'the bytes published are the bytes authorized')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

// And the refusal side of the same hook: a source that is DIFFERENT from the
// unread destination by the time the copy is read is refused, with nothing
// written — the guard now sees exactly what would land.
test('#247: a from_path source that differs when read is refused on the published buffer', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-refuse-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-refuse-src-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 notes.md。', attach: { filename: 'notes.md', content: 'original\n' } }, {})).id
  const source = path.join(loose, 'notes.md')
  await fsp.writeFile(source, 'a different page\n')
  const later = await nextTurn(fresh, { attachFromPathRoots: [loose] })
  await later.get('memory_read').execute({ id }, {})
  const refused = await later.get('memory_attach').execute({ id, from_path: source }, {}).then(() => undefined, (error) => error)
  assert.match(refused.message, /^memory_attach: notes\.md on .* holds 9 bytes you have not fully read this session/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'original\n', 'nothing was written')
  await assert.rejects(() => fsp.lstat(path.join(fresh, id, '.notes.md.prev')), 'a refused overwrite writes no snapshot')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

// Review finding 4: the window a Session is SHOWN and the hash that later
// authorizes replacing the file must describe one version. Reading the window
// through one handle and hashing the pathname afterwards lets an out-of-band
// replacement between the two open() calls credit the NEW file's hash to the OLD
// window — and for same-sized one-page files the range then covers it, so the
// next overwrite destroys bytes the Session never received.
test('#247: the read window and its hash come from one version (#247 review 4)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-one-version-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 a.md。', attach: { filename: 'a.md', content: 'AAAA' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  const file = path.join(fresh, id, 'a.md')
  const real = await fsp.realpath(file)
  // Swap the file on any SECOND open of it. A second open is exactly the read
  // that would be hashed without being shown.
  const realOpen = fsp.open
  let opens = 0
  fsp.open = async (target, ...rest) => {
    // The reader opens the joined node path; `/var` and `/private/var` differ on
    // macOS, so accept either spelling of the same file.
    if (target === real || target === path.join(fresh, id, 'a.md')) {
      opens += 1
      if (opens === 2) await fsp.writeFile(real, 'BBBB')
    }
    return realOpen.call(fsp, target, ...rest)
  }
  try {
    const page = await later.get('memory_read_file').execute({ id, file: 'a.md' }, {})
    assert.equal(page.content, 'AAAA', 'the caller is shown the version that was read')
    assert.equal(page.bytes, 4)
  } finally {
    fsp.open = realOpen
  }
  assert.equal(opens, 1, 'the window and its hash come from ONE read of one version')
  assert.equal(await fsp.readFile(file, 'utf8'), 'AAAA', 'nothing swapped the file out from under the read')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// Review finding 1: the F79 observation autosave stays ungated (it is the
// framework's own capture, F79/#180), but it must inherit the SESSION ANCHOR —
// otherwise a later Session's second changed capture overwrites `.prev` with its
// own first capture and the pre-session observation is gone.
test('#247: a repeated observation autosave keeps the pre-session snapshot (#247 review 1)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-observation-anchor-'))
  const page1 = 'link "Profile"\n'.repeat(300)
  const first = await nextTurn(fresh, { indexCacheMs: 0 })
  const created = await first.get('memory_write').execute({ description: 'Account menu gist', body: 'six links under the avatar' }, execWithTurn(page1))
  assert.equal(created.observation.status, 'created')
  const id = created.id
  const prevFile = path.join(fresh, id, '.observation.txt.prev')

  // A later Session, which never opens the pre-session observation, captures two
  // CHANGED pages in a row.
  const later = await nextTurn(fresh, { indexCacheMs: 0 })
  await later.get('memory_read').execute({ id }, {})
  const page2 = 'link "Settings"\n'.repeat(300)
  assert.equal((await later.get('memory_write').execute({ id, body: 'now seven links' }, execWithTurn(page2))).observation.status, 'overwritten')
  assert.equal(await fsp.readFile(prevFile, 'utf8'), page1, 'the pre-session capture is put aside')
  await later.get('memory_read').execute({ id }, {})
  const page3 = 'link "Help"\n'.repeat(300)
  assert.equal((await later.get('memory_write').execute({ id, body: 'now eight links' }, execWithTurn(page3))).observation.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'observation.txt'), 'utf8'), page3)
  assert.equal(await fsp.readFile(prevFile, 'utf8'), page1, 'the anchor holds the PRE-session capture, not this Session\'s first')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// Review finding 5: on a case-insensitive filesystem the two spellings are one
// file, so a stale entry for the spelling used FIRST must not shadow the current
// evidence recorded under the other — and the snapshot must not chase its own
// write back over the pre-session copy.
test('#247: a case alias of one file keeps its read knowledge and its snapshot (#247 review 5)', async (t) => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-case-alias-'))
  await fsp.writeFile(path.join(fresh, 'probe'), 'x')
  const caseInsensitive = await fsp.access(path.join(fresh, 'PROBE')).then(() => true, () => false)
  await fsp.rm(path.join(fresh, 'probe'))
  if (!caseInsensitive) {
    await fsp.rm(fresh, { recursive: true, force: true })
    return t.skip('case-sensitive filesystem: the two spellings are two files here')
  }
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 report.md。', attach: { filename: 'report.md', content: 'original\n' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  // Replace through the SAME spelling first, so the record lives under
  // `report.md` — the pre-session bytes are put aside here.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'second\n' } }, {})).attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), 'original\n')
  // An IDENTICAL re-attach through the OTHER spelling (review 2's exact
  // sequence): one file, one record, so it must neither be refused nor drop the
  // preservation this Session earned. Under per-spelling bookkeeping the entry
  // was absent under `Report.md`, the identical write recorded preserved:false,
  // and the next write then burned the original snapshot with 'second'.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'Report.md', content: 'second\n' } }, {})).attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), 'original\n', 'an identical alias write writes no snapshot either')
  // And the following replacement through the alias still keeps the original.
  assert.equal((await later.get('memory_write').execute({ id, attach: { filename: 'Report.md', content: 'third\n' } }, {})).attached.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'Report.md'), 'utf8'), 'third\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), 'original\n', 'the alias did not re-snapshot this Session\'s own write')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#247: an overwrite whose snapshot cannot be written leaves the attachment untouched', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-fail-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: '周报', body: '见 report.md。', attach: { filename: 'report.md', content: 'the original\n' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  // `.report.md.prev` as a DIRECTORY makes the snapshot rename fail.
  await fsp.mkdir(path.join(fresh, id, '.report.md.prev'))
  const result = await later.get('memory_write').execute({ id, body: '更新后的说明', attach: { filename: 'report.md', content: 'replacement\n' } }, {})
  // The update path reports a failed attachment rather than unwinding the body
  // (F74's trade-off), and the file it would have replaced is exactly as it was.
  assert.equal(result.attached, undefined)
  assert.ok(result.attach_failed, 'the failure is reported, not silent')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'the original\n', 'the target was never touched')
  assert.equal((await fsp.stat(path.join(fresh, id, '.report.md.prev'))).isDirectory(), true)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#247: the .prev snapshot is hidden from the read listing and from search', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-hidden-'))
  const author = await nextTurn(fresh)
  const id = (await author.get('memory_write').execute({ description: 'weekly report', body: 'The report is attached.', attach: { filename: 'report.md', content: 'zqxpriortoken lives only in the replaced version\n' } }, {})).id
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  await later.get('memory_read_file').execute({ id, file: 'report.md' }, {})
  await later.get('memory_write').execute({ id, attach: { filename: 'report.md', content: 'current version\n' } }, {})
  assert.equal(await fsp.readFile(path.join(fresh, id, '.report.md.prev'), 'utf8'), 'zqxpriortoken lives only in the replaced version\n')
  // The node view lists the attachment and nothing else…
  assert.deepEqual((await later.get('memory_read').execute({ id }, {})).files.map((file) => file.name), ['report.md'])
  // …search never scans the snapshot…
  assert.equal((await later.get('memory_search').execute({ query: 'zqxpriortoken' }, {})).total, 0)
  // …and the dot name is not an attachment the read tool will open.
  await assert.rejects(() => later.get('memory_read_file').execute({ id, file: '.report.md.prev' }, {}), /start with a dot/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// #255: what an AGENT may attach, and what the overwrite guard says to a target
// it can never authorize. Two independent holes, one section:
//   - `observation.txt` was attachable by an agent, and because the Session's
//     write is recorded as authorship the very next F79 autosave passed
//     `snapshot: false` — the agent's bytes had no copy anywhere. The refusal
//     lives in the tool's semantic prepare (not RESERVED_FILES), so it is
//     provably pre-write, and the autosave plus reads are untouched.
//   - a name past the cap, and the guard's messages for targets no read could
//     ever authorize (symlink/FIFO, over the cap, shrank mid-read).
// ---------------------------------------------------------------------------

test('#255: observation.txt and over-long names are refused in the preparation, on every write route', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-agent-name-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const attachTool = tools.get('memory_attach')
  const id = (await write.execute({ description: 'agent-name target', body: 'gist' }, {})).id

  const prepareWrite = trustedPreparationFor(write)
  const prepareAttach = trustedPreparationFor(attachTool)
  const observationViolation = (violations) => violations.find((v) => /observation\.txt is the framework's own capture/.test(v))

  // The inline route: a schema-valid call, refused by the pure rule — nothing
  // in the handler runs, which is what executionStarted:false rests on.
  const inline = prepareWrite({ description: 'k', body: 'b', attach: { filename: 'observation.txt', content: 'agent capture\n' } })
  assert.ok(observationViolation(inline.violations), 'memory_write.attach refuses observation.txt')
  await assert.rejects(
    () => write.execute({ description: 'k', body: 'b', attach: { filename: 'observation.txt', content: 'agent capture\n' } }, {}),
    (error) => {
      assert.ok(error instanceof ToolArgsError, 'a boundary rejection, not a handler throw')
      assert.ok(observationViolation(error.violations))
      return true
    },
  )
  // Case-insensitive: on default APFS `Observation.txt` is the same file.
  assert.ok(observationViolation(prepareWrite({ description: 'k', attach: { filename: 'Observation.TXT', content: 'x' } }).violations))

  // The standalone route, both spellings of the filename: explicit `filename`,
  // and the basename `from_path` would land under when `filename` is omitted.
  assert.ok(observationViolation(prepareAttach({ id, filename: 'observation.txt', content: 'agent capture\n' }).violations))
  assert.ok(observationViolation(prepareAttach({ id, from_path: '/tmp/whatever/observation.txt' }).violations))
  // An explicit descriptive filename for a `from_path` copy is fine — the
  // content lands under a name the writer chose, so nothing is overwritten.
  assert.deepEqual(prepareAttach({ id, filename: 'monthly-report-2026W32.md', from_path: '/tmp/whatever/observation.txt' }).violations, [])

  // The byte cap is on WRITES only: 200 ASCII bytes land, 201 are refused, and
  // a 67-character Han name is 201 BYTES and refused too.
  const exact = 'a'.repeat(200)
  const tooLong = 'a'.repeat(201)
  assert.deepEqual(prepareAttach({ id, filename: exact, content: 'x' }).violations, [], '200 bytes is admitted')
  assert.match(prepareAttach({ id, filename: tooLong, content: 'x' }).violations.join('; '), /over the 200-byte limit/)
  assert.match(prepareAttach({ id, filename: '周'.repeat(67), content: 'x' }).violations.join('; '), /201 UTF-8 bytes/)
  assert.deepEqual(prepareWrite({ description: 'k', attach: { filename: exact, content: 'x' } }).violations, [])
  assert.match(prepareWrite({ description: 'k', attach: { filename: tooLong, content: 'x' } }).violations.join('; '), /over the 200-byte limit/)
  assert.equal((await attachTool.execute({ id, filename: exact, content: 'ok\n' }, {})).status, 'created', 'the admitted boundary still writes')
  await assert.rejects(() => attachTool.execute({ id, filename: tooLong, content: 'no\n' }, {}), ToolArgsError)
  assert.equal(await fsp.readdir(path.join(fresh, id)).then((names) => names.includes(tooLong)), false)

  // Reads are NOT capped: an existing file past the cap stays openable, and so
  // does an existing observation.txt (the F79 capture, or a pre-#255 file).
  const longName = `${'r'.repeat(246)}.md`
  await fsp.writeFile(path.join(fresh, id, longName), 'long-named but readable\n')
  assert.equal((await tools.get('memory_read_file').execute({ id, file: longName }, {})).content, 'long-named but readable\n')
  await fsp.writeFile(path.join(fresh, id, 'observation.txt'), 'the framework capture\n')
  assert.equal((await tools.get('memory_read_file').execute({ id, file: 'observation.txt' }, {})).content, 'the framework capture\n')

  // And F79's own autosave still lands: the refusal is the tool boundary's, not
  // the capture's. Run it on the SAME node, which already holds the stand-in
  // capture — the autosave overwrites it and keeps the replaced bytes aside.
  await tools.get('memory_read').execute({ id }, {})
  const observed = await write.execute({ id, body: 'The avatar opens the account menu.' }, execWithTurn("link 'Profile'\nlink 'Log out'\n".repeat(300)))
  assert.equal(observed.observation.status, 'overwritten', 'the autosave replaced the stand-in capture')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'observation.txt'), 'utf8'), "link 'Profile'\nlink 'Log out'\n".repeat(300))
  assert.equal((await fsp.readFile(path.join(fresh, id, '.observation.txt.prev'), 'utf8')), 'the framework capture\n', 'the replaced capture was snapshotted')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// 7a (#252): the guard must reject BEFORE F88's refusal path appends its
// correction line to node.md. Both routes order it that way; this pins the
// ordering, because an untraceable payload on an unseen overwrite is exactly
// the pair a reordering would turn into "file exists, body says it does not".
test('#255: an unread overwrite is refused by the guard, and no F88 correction line is appended', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-guard-before-f88-'))
  const author = await nextTurn(fresh)
  const name = 'kyc-review.md'
  const original = '# Demo access review\n\n- Vendors evaluated: CedarCheck and MapleCheck\n- Grace period: six weeks\n'
  const id = (await author.get('memory_write').execute({ description: 'Demo access review', body: `见 ${name}。`, attach: { filename: name, content: original } }, execWithTurn(TRACEABLE_TURN))).id

  // A later Session reads the NODE only — so the body's mention of the file is
  // exactly what F88.3 would append a correction about — and never the file,
  // then tries to replace it with invented content.
  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  const nodeBefore = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')

  for (const [label, call] of [
    ['memory_write', () => later.get('memory_write').execute({ id, attach: { filename: name, content: UNTRACEABLE } }, execWithTurn(TRACEABLE_TURN))],
    ['memory_attach', () => later.get('memory_attach').execute({ id, filename: name, content: UNTRACEABLE }, execWithTurn(TRACEABLE_TURN))],
  ]) {
    const error = await call().then(() => undefined, (thrown) => thrown)
    assert.match(error.message, new RegExp(`^${label}: ${name} on ${id} holds ${Buffer.byteLength(original)} bytes you have not fully read this session`), `${label}: the unread-overwrite refusal, not F88's`)
    assert.doesNotMatch(error.message, /not traceable to this conversation/, `${label}: F88 never ran`)
  }
  // The unpaid promise F88.3 would have recorded is now absent, because nothing
  // reached it — and the body still names a file that is still there.
  const nodeAfter = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  assert.equal(nodeAfter, nodeBefore, 'node.md is byte-identical: no correction line')
  assert.doesNotMatch(nodeAfter, /未写入/)
  assert.equal(await fsp.readFile(path.join(fresh, id, name), 'utf8'), original, 'the attachment is untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// 7b (#252): the pre-check is unlocked, so the authoritative decision is the
// re-check under the node lock. When a peer replaces the file in that gap, the
// re-check must refuse — and must leave node.md and .node.md.prev untouched even
// though a body update was already in hand.
test('#255: a peer write between the pre-check and the lock is caught, leaving node.md and .node.md.prev untouched', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-guard-lock-race-'))
  const author = await nextTurn(fresh)
  const name = 'report.md'
  const id = (await author.get('memory_write').execute({ description: '周报', body: `格式见 ${name}。`, attach: { filename: name, content: 'the original\n' } }, {})).id
  // A prior body version, so `.node.md.prev` exists and must survive the refusal.
  await author.get('memory_read').execute({ id }, {})
  await author.get('memory_write').execute({ id, body: `格式见 ${name}（已核对）。` }, {})

  const later = await nextTurn(fresh)
  await later.get('memory_read').execute({ id }, {})
  await later.get('memory_read_file').execute({ id, file: name }, {})
  const nodeFile = path.join(fresh, id, 'node.md')
  const before = {
    node: await fsp.readFile(nodeFile),
    prev: await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE)),
  }

  // The peer's attach lands at lock-acquisition time — after this call's
  // unlocked pre-check said the bytes were the ones it read.
  const lock = path.join(fresh, '.locks', `${id}.lock`)
  const realMkdir = fsp.mkdir
  let raced = false
  fsp.mkdir = async (...args) => {
    if (args[0] === lock && !raced) {
      raced = true
      await fsp.writeFile(path.join(fresh, id, name), "the peer's version\n")
    }
    return realMkdir.apply(fsp, args)
  }
  const error = await (async () => {
    try {
      await later.get('memory_write').execute({ id, body: '更新后的说明', attach: { filename: name, content: 'mine\n' } }, {})
      return undefined
    } catch (thrown) {
      return thrown
    } finally {
      fsp.mkdir = realMkdir
    }
  })()
  assert.ok(raced, 'the peer write must land inside the lock queue, or the race was not exercised')
  assert.match(error.message, /holds 19 bytes you have not fully read this session \(or it changed since you read it\)/)
  assert.deepEqual(await fsp.readFile(nodeFile), before.node, 'no body landed under the lock')
  assert.deepEqual(await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE)), before.prev, 'the body snapshot was not burned')
  assert.equal(await fsp.readFile(path.join(fresh, id, name), 'utf8'), "the peer's version\n", 'the peer retains its bytes')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// The F79 autosave is best-effort, but "best-effort" was implemented as a bare
// catch: a capture that failed (ENAMETOOLONG, ENOSPC) left no trace anywhere.
// It must still not fail the write; it must say so.
test('#255: a failed F79 autosave is surfaced on stderr and does not fail the write', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-observation-log-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  // The capture is only best-effort on the UPDATE path (the create path lands it
  // atomically with the node), so that is the route whose failure this pins.
  const id = (await write.execute({ description: 'Postmill account menu', body: 'The avatar opens the account menu.' }, {})).id
  await tools.get('memory_read').execute({ id }, {})
  const realWriteFile = fsp.writeFile
  const realStderrWrite = process.stderr.write
  const logged = []
  fsp.writeFile = async (file, ...rest) => {
    if (typeof file === 'string' && path.basename(file).includes('observation.txt')) {
      const error = new Error('simulated ENAMETOOLONG while staging the capture')
      error.code = 'ENAMETOOLONG'
      throw error
    }
    return realWriteFile.call(fsp, file, ...rest)
  }
  process.stderr.write = (chunk, ...rest) => {
    logged.push(String(chunk))
    return realStderrWrite.call(process.stderr, chunk, ...rest)
  }
  let result
  try {
    result = await write.execute({ id, body: 'The avatar opens the account menu.' }, execWithTurn("link 'Profile'\nlink 'Log out'\n".repeat(300)))
  } finally {
    fsp.writeFile = realWriteFile
    process.stderr.write = realStderrWrite
  }
  assert.equal(result.observation, undefined, 'the capture did not land')
  assert.equal(result.created, false, 'the write itself landed normally')
  assert.equal((await loadNodeFor(fresh, result.id)).description, 'Postmill account menu')
  const line = logged.find((entry) => entry.includes('could not auto-capture observation.txt'))
  assert.ok(line, `the failure was logged; got: ${logged.join('')}`)
  assert.match(line, /simulated ENAMETOOLONG/)
  assert.match(line, /The write itself landed/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

/** The parsed node, so the assertion above reads disk rather than the result. */
async function loadNodeFor(dir, id) {
  return parseNode(await fsp.readFile(path.join(dir, id, 'node.md'), 'utf8'))
}

// #255 review 1: the diagnostic must not be able to fail a write that already
// landed. `updateNode` has committed by the time the F79 catch runs, so a host
// whose stderr sink throws would have turned a successful best-effort update
// into a throw — and the wrapper latches its write fence on an unaudited
// failure. The log is best-effort, like `journalAdvisories`'.
test('#255 review 1: a throwing diagnostic sink cannot turn a landed write into a failure', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-observation-sink-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const write = tools.get('memory_write')
  const id = (await write.execute({ description: 'Postmill account menu', body: 'The avatar opens the account menu.' }, {})).id
  await tools.get('memory_read').execute({ id }, {})
  const realWriteFile = fsp.writeFile
  const realStderrWrite = process.stderr.write
  let logged = 0
  // Force the capture to fail…
  fsp.writeFile = async (file, ...rest) => {
    if (typeof file === 'string' && path.basename(file).includes('observation.txt')) {
      const error = new Error('simulated ENAMETOOLONG while staging the capture')
      error.code = 'ENAMETOOLONG'
      throw error
    }
    return realWriteFile.call(fsp, file, ...rest)
  }
  // …and give the host a stderr sink that throws.
  process.stderr.write = () => {
    logged += 1
    throw new Error('stderr is gone')
  }
  let result
  try {
    result = await write.execute({ id, body: 'The avatar opens the account menu, revised.' }, execWithTurn("link 'Profile'\nlink 'Log out'\n".repeat(300)))
  } finally {
    fsp.writeFile = realWriteFile
    process.stderr.write = realStderrWrite
  }
  assert.ok(logged > 0, 'the diagnostic was attempted')
  assert.equal(result.created, false, 'the update returned normally')
  assert.equal(result.observation, undefined, 'the capture did not land')
  assert.equal((await loadNodeFor(fresh, id)).body, 'The avatar opens the account menu, revised.', 'the write itself landed on disk')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #255 review 2 (blocker): the semantic preparation derived the from_path
// default name from the RAW string, while the handler expands `~` with
// `path.join` — which drops a trailing `/.`. So `~/observation.txt/.` passed the
// guard (`path.basename` said `.`) and the handler then created observation.txt,
// reopening the F79 data-loss hole in one call. Both sides now derive the name
// from the same pure function.
test('#255 review 2: the from_path default name is normalized the way the handler normalizes it', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-name-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-home-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, attachFromPathRoots: [loose] })
  const attachTool = tools.get('memory_attach')
  const id = (await tools.get('memory_write').execute({ description: 'from_path naming', body: 'gist' }, {})).id
  const prepare = trustedPreparationFor(attachTool)
  const longName = `${'n'.repeat(197)}.md` // 200 bytes: admitted

  // Every shape whose EFFECTIVE basename is the framework's capture, or over the
  // cap, is refused at the boundary — including the ones whose raw basename is
  // `.` or `.`-dropped.
  for (const from_path of ['~/observation.txt/.', '~/obſervation.txt/.', '~//observation.txt', '~/x/../observation.txt', '/tmp/x/../observation.txt', 'observation.txt/']) {
    assert.match(
      prepare({ id, from_path }).violations.join('; '),
      /observation\.txt is the framework's own capture/,
      `${from_path} resolves to observation.txt and must be refused`,
    )
  }
  // Same normalization, over the byte cap: the raw basename is `.` here too.
  assert.match(prepare({ id, from_path: `~/${'n'.repeat(201)}.md/.` }).violations.join('; '), /over the 200-byte limit/)
  // And the refusals really are pre-mutation.
  const before = await fsp.readdir(path.join(fresh, id))
  await assert.rejects(
    () => attachTool.execute({ id, from_path: '~/observation.txt/.' }, {}),
    (error) => {
      assert.ok(error instanceof ToolArgsError, 'refused before the handler ran')
      assert.match(error.violations.join('; '), /observation\.txt is the framework's own capture/)
      return true
    },
  )
  assert.deepEqual(await fsp.readdir(path.join(fresh, id)), before, 'nothing was created')

  // The positive half: the handler and the preparation agree on the LANDED name,
  // so an ordinary `~` path with a trailing `/.` still works. Patch the home so
  // the fixture can live in a temp dir.
  const realHomedir = os.homedir
  os.homedir = () => loose
  try {
    await fsp.writeFile(path.join(loose, 'report.md'), 'home report\n')
    const landed = await attachTool.execute({ id, from_path: '~/report.md/.' }, {})
    assert.equal(landed.file, 'report.md', 'expanded, normalized, and named as the handler opens it')
    assert.equal(landed.status, 'created')
    assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'home report\n')
  } finally {
    os.homedir = realHomedir
  }
  // A 200-byte name (the boundary) lands, so the cap is not accidentally strict.
  await fsp.writeFile(path.join(loose, longName), 'boundary\n')
  const atCap = await attachTool.execute({ id, from_path: path.join(loose, longName) }, {})
  assert.equal(atCap.file, longName)
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

// #263 W2.1: the A2A prompt profile. One section source with slots; `full` is
// the default and renders byte-identically to the pre-profile section, `read`
// removes every write-only surface while keeping every read rule, and `manage`
// is `full` minus the two surfaces naming tools the restricted wrapper strips.
// The lists below are the contract: a bullet that moves between them must move
// here too, which is why each KEEP entry is asserted by its own phrase rather
// than by a count.
const READ_KEEPS = [
  ['search-before-answer', 'call `memory_search` first'],
  ['reword uses the words a note was written with', 'the terms a note would have been WRITTEN with'],
  ['targeted reword, not a blind one', 'That is one targeted retry instead of a blind reword'],
  ['reword floor: one search is never a miss', 'ONE search is never a miss'],
  ['follow-through before a miss', 'only once the promising rows have been followed through'],
  ['follow-through gates a positive answer', 'gates a POSITIVE answer too'],
  ['follow-through opens attachments', 'open it with `memory_read_file`'],
  ['abstention: never bridge with world knowledge', 'Never bridge the miss with what you generally know'],
  ['scoped not-found beats invention', 'there is no such element'],
  ['superseded rows point at the successor', 'Read the successor for what is true now'],
  ['attachment paging', 'When the answer could be in one, open it with `memory_read_file`'],
  ['identifiers quoted verbatim', 'quote an identifier exactly as the node records it'],
  ['unknown results are reported as unknown', 'is an UNKNOWN, not something you learned'],
  ['the `from` traversal hint', 'pass `from`: traversals rank the graph over time'],
]

const READ_REMOVES = [
  ['the durable-fact write rule', 'When you learn something durable'],
  ['the update-turn-always-writes rule', 'A memory-update turn ALWAYS ends in a write'],
  ['the end-of-turn write report', 'End the turn by reporting what you actually wrote'],
  ['the `similar` follow-up', 'When a create returns `similar`'],
  ['the `link_candidates` follow-up', 'When a create returns `link_candidates`'],
  ['one topic per node', 'One node, one topic'],
  ['why-in-description', 'put the why in the `description` itself'],
  ['write dates absolute', 'Write dates absolute'],
  ['session write-back', 'Before finishing a session that advanced a thread'],
  ['read-before-replace', 'Before you replace a node\'s body'],
  ['description refresh on update', 'both are revisable on update'],
  ['the handoff write', 'Write ONE `type: handoff` node'],
  ['in-flight work state', 'Unfinished work is not only YOUR session'],
  ['the status-line write-back', 'A status line about what YOU, the assistant, did'],
  ['the write form of the identifier rule', 'copy it into the `body` exactly as it appeared'],
  ['linking existing nodes', 'To connect two existing nodes directly'],
  ['typed links', 'To name a relationship, pass `typed_links`'],
  ['the do-not-store exemption', 'Do not store what the repository, the shell, or this conversation already answers'],
  ['retractions', 'A retraction ("ignore what I said about X"'],
  ['the detail-tier / attach rule', 'A node has two tiers and one `memory_write` stores both'],
  ['write-time `type` tagging', 'When a write clearly fits one kind'],
  ['supersede-instead-of-rewrite', 'When new information contradicts or replaces a stored decision'],
  ['retiring a fact', 'The same rule covers REMOVING a fact'],
  ['the batch-writes bullet', 'plan them together and issue them in ONE message'],
  ['the calendar strip and its weekday rule', 'never compute a weekday in your head'],
  ['the event-clock rule', 'Your clock is not the events\' clock'],
]

test('#263 W2.1: promptProfile is validated, defaults to full, and only the profile varies', () => {
  for (const bad of ['FULL', 'write', '', 1, true, null, ['read'], { profile: 'read' }]) {
    assert.throws(
      () => apply(fakeCtx().ctx, { graphRoot: root, promptProfile: bad }),
      /`promptProfile` must be 'full', 'read' or 'manage'/,
    )
  }
  // The default and an explicit 'full' are the same section STRING: the profile
  // never edits SECTION_TEXT, it only decides what the slots render.
  const implicit = fakeCtx()
  apply(implicit.ctx, { graphRoot: root })
  const explicit = fakeCtx()
  apply(explicit.ctx, { graphRoot: root, promptProfile: 'full' })
  assert.equal(implicit.sections[0].text, explicit.sections[0].text, 'the default is full, byte for byte')
  for (const profile of ['read', 'manage']) {
    const other = fakeCtx()
    apply(other.ctx, { graphRoot: root, promptProfile: profile })
    assert.equal(other.sections[0].text, implicit.sections[0].text, `${profile} never edits the section source either`)
  }
})

test('#263 W2.1: the default (full) prompt is byte-identical to the pre-profile section', async () => {
  // The golden is the RENDERED full prompt on an empty graph, with the clock and
  // the calendar strip left as slots so the comparison is deterministic. It was
  // captured from the section as it shipped BEFORE the profile existed, so a
  // failure here means the default output changed — which is the one thing this
  // lever promised not to do. Regenerate it only when the change is intended:
  //   node test/regen-full-prompt-golden.mjs
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root })
  const rendered = renderSection({ sections, variables }, { keep: ['memory_calendar', 'memory_today', 'memory_handoffs', 'memory_index'] })
  const golden = await fsp.readFile(new URL('./fixtures/full-prompt.golden.txt', import.meta.url), 'utf8')
  assert.equal(rendered, golden, 'the default prompt drifted from the pre-profile golden')
  // An explicit 'full' is the same bytes, and so is a config that predates the key.
  const explicit = fakeCtx()
  apply(explicit.ctx, { graphRoot: root, promptProfile: 'full' })
  assert.equal(renderSection({ sections: explicit.sections, variables: explicit.variables }, { keep: ['memory_calendar', 'memory_today', 'memory_handoffs', 'memory_index'] }), golden)
})

test('#263 W2.1: the read profile keeps every read rule and removes every write-only surface', () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, promptProfile: 'read' })
  const text = renderSection({ sections, variables })
  for (const [label, phrase] of READ_KEEPS) {
    assert.ok(text.includes(phrase), `read profile must keep ${label}`)
  }
  for (const [label, phrase] of READ_REMOVES) {
    assert.ok(!text.includes(phrase), `read profile must remove ${label}`)
  }
  // No write tool is named anywhere in the read surface, and neither is a tool
  // the restricted wrapper never registers.
  for (const tool of ['memory_write', 'memory_attach', 'memory_merge', 'memory_restore']) {
    assert.ok(!text.includes(tool), `read profile must not name ${tool}`)
  }
  // The index blocks that exist only to prompt a write are gone from the result,
  // not merely from the template.
  for (const block of ['Possible duplicate memories', 'unlinked memor', 'exited without writing anything']) {
    assert.ok(!text.includes(block), `read profile must drop the ${block} block`)
  }
  // It is substantially smaller — the whole point of the profile.
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: root })
  const fullText = renderSection({ sections: full.sections, variables: full.variables })
  assert.ok(text.length < fullText.length * 0.4, `read ${text.length} vs full ${fullText.length}`)
})

test('#263 W2.1: the read profile drops the write-time reminders that ride tool RESULTS', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-profile-results-'))
  const read = fakeCtx()
  apply(read.ctx, { graphRoot: fresh, promptProfile: 'read' })
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: fresh })
  await settle()
  // Seed through a full-profile instance: the read profile registers the write
  // tool too (the plugin always registers all seven; the WRAPPER filters), so
  // either instance can write, and the fixture only needs to exist.
  const write = full.tools.get('memory_write')
  const ledger = (await write.execute({ description: 'open thread: report owed', body: 'pending: report', type: 'thread' }, {})).id
  const fact = (await write.execute({ description: 'plain fact about fra-1', body: 'ships to fra-1' }, {})).id
  void ledger

  // Search results: the read-before-update reminder is a write-time roundtrip
  // saver, and the read authority cannot make the update it warns about.
  const readSearch = read.tools.get('memory_search')
  const fullSearch = full.tools.get('memory_search')
  const readText = readSearch.output.render({}, await readSearch.execute({ query: 'fra-1' }, {}))[0].text
  const fullText = fullSearch.output.render({}, await fullSearch.execute({ query: 'fra-1' }, {}))[0].text
  assert.ok(!readText.includes('To update any node above, memory_read it first'), 'read: no write reminder on rows')
  assert.ok(fullText.includes('To update any node above, memory_read it first'), 'full: the reminder is unchanged')
  assert.equal(readText, fullText.replace(/\nTo update any node above[^\n]*$/, ''), 'nothing else about the rows changes')

  // Node views: the open-work write-back reminder orders a memory_write.
  const readView = read.tools.get('memory_read')
  const fullView = full.tools.get('memory_read')
  const view = await readView.execute({ id: ledger }, {})
  assert.ok(!readView.output.render({}, view)[0].text.includes('This node tracks open work'), 'read: no write-back reminder')
  assert.ok(fullView.output.render({}, await fullView.execute({ id: ledger }, {}))[0].text.includes('This node tracks open work'), 'full: unchanged')
  // The node's own content and edges are untouched by the profile.
  assert.equal(
    readView.output.render({}, view)[0].text,
    fullView.output.render({}, await fullView.execute({ id: ledger }, {}))[0].text.replace(/\n\nThis node tracks open work[^\n]*$/, ''),
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#263 W2.1: the read profile still evaluates memory_today per assembly (the startTurn guard)', () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, promptProfile: 'read' })
  // The variable the guard lives in is registered, still produces the clock, and
  // still appears in the rendered prompt — the read profile removes the calendar
  // strip, never the per-assembly hook.
  assert.ok(variables.has('memory_today'), 'memory_today is registered in the read profile')
  assert.equal(variables.get('memory_today')(), `${today()} (${weekdayName(today())})`)
  assert.ok(renderSection({ sections, variables }).includes(`Today is ${today()}`), 'the date line survives')
  // And it is genuinely per-assembly: two evaluations a day apart differ.
  const RealDate = Date
  const shifted = (offsetDays) => {
    const fixed = new RealDate()
    fixed.setDate(fixed.getDate() + offsetDays)
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length === 0 ? [fixed.getTime()] : args)) }
      static now() { return fixed.getTime() }
    }
    try { return variables.get('memory_today')() } finally { globalThis.Date = RealDate }
  }
  assert.notEqual(shifted(0), shifted(2), 'the clock is re-read, not frozen at apply time')
  // The calendar strip is gone, so its variable renders nothing — but it is
  // still registered, so a harness rendering the section never sees a raw token.
  assert.ok(variables.has('memory_calendar'), 'the strip variable is still registered')
  assert.equal(variables.get('memory_calendar')(), '', 'the strip renders nothing in the read profile')
})

test('#263 W2.1: the manage profile names neither stripped tool and is otherwise full', () => {
  const manage = fakeCtx()
  apply(manage.ctx, { graphRoot: root, promptProfile: 'manage' })
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: root })
  // The section body is identical to full: `manage` only removes the two
  // surfaces that name a tool the restricted wrapper never registers.
  assert.equal(manage.sections[0].text, full.sections[0].text)
  assert.equal(renderSection(manage), renderSection(full))
  // The search DESCRIPTION is where the memory_restore advice lives, and it is
  // the description of the tool a manage run really does get.
  assert.ok(!manage.tools.get('memory_search').description.includes('memory_restore'), 'manage: no memory_restore advice')
  assert.ok(full.tools.get('memory_search').description.includes('bring one back with memory_restore'), 'full: unchanged')
  // A read run is stripped of BOTH tools too, so its description drops it as well.
  const read = fakeCtx()
  apply(read.ctx, { graphRoot: root, promptProfile: 'read' })
  assert.ok(!read.tools.get('memory_search').description.includes('memory_restore'), 'read: no memory_restore advice either')
  // The rest of the description is byte-identical apart from that clause.
  assert.equal(
    manage.tools.get('memory_search').description,
    full.tools.get('memory_search').description.replace('; bring one back with memory_restore.', '.'),
  )
})

test('#263 W2.1: the manage profile drops memory_merge from the duplicate block', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-manage-dup-'))
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = full.tools.get('memory_write')
  const a = (await write.execute({ description: 'dup a', body: 'x' }, {})).id
  const b = (await write.execute({ description: 'dup b', body: 'y' }, {})).id
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${a} ${b}\n`)

  const fullIndex = full.variables.get('memory_index')()
  assert.match(fullIndex, new RegExp(`memory_merge\\(keep_id, absorb_id\\)`))
  const manage = fakeCtx()
  apply(manage.ctx, { graphRoot: fresh, indexCacheMs: 0, promptProfile: 'manage' })
  const manageIndex = manage.variables.get('memory_index')()
  assert.match(manageIndex, /Possible duplicate memories/, 'the census still surfaces')
  assert.ok(!manageIndex.includes('memory_merge'), 'manage: the tool the wrapper strips is not named')
  assert.match(manageIndex, /the maintenance pass can fold one into the other/)
  const read = fakeCtx()
  apply(read.ctx, { graphRoot: fresh, indexCacheMs: 0, promptProfile: 'read' })
  assert.ok(!read.variables.get('memory_index')().includes('Possible duplicate memories'), 'read: the write-only block is gone')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#263 W2.1: the read profile leaves a well-formed section (no doubled or missing separators)', () => {
  const { ctx, sections, variables } = fakeCtx()
  apply(ctx, { graphRoot: root, promptProfile: 'read' })
  const text = renderSection({ sections, variables })
  assert.doesNotMatch(text, /\n{3,}/, 'no run of blank lines where a removed block used to be')
  // The date paragraph is still separated from the handoff banner.
  assert.match(text, /bookkeeping\.\n\nOpen handoff|bookkeeping\.\n\nMemory index/, 'one blank line before the next block')
  // The bullet list is contiguous: every surviving guidance line starts a bullet
  // or is a continuation of one.
  const lines = text.split('\n')
  const firstBullet = lines.findIndex((line) => line.startsWith('- '))
  const lastBullet = lines.map((line) => line.startsWith('- ')).lastIndexOf(true)
  for (const line of lines.slice(firstBullet, lastBullet + 1)) {
    assert.ok(!line.startsWith('Today is'), 'the date paragraph is not inside the bullet list')
  }
})

test('#263 W2.1: no read-visible tool description names a tool the read authority cannot call', () => {
  // The section is not the only prompt surface: every tool description is
  // re-sent on every step too. A read run registers exactly these three, so a
  // description that points at memory_write/memory_attach/memory_merge/
  // memory_restore is an instruction the run cannot follow.
  const readTools = ['memory_search', 'memory_read', 'memory_read_file']
  const stripped = ['memory_write', 'memory_attach', 'memory_merge', 'memory_restore']
  for (const profile of ['read', 'manage']) {
    const { ctx, tools } = fakeCtx()
    apply(ctx, { graphRoot: root, promptProfile: profile })
    // At manage authority memory_write and memory_attach ARE registered, so only
    // the two the wrapper strips at every authority are barred there.
    const banned = profile === 'read' ? stripped : ['memory_merge', 'memory_restore']
    for (const name of readTools) {
      for (const tool of banned) {
        assert.ok(!tools.get(name).description.includes(tool), `${profile}: ${name} must not name ${tool}`)
      }
    }
  }
  // The full profile is untouched — this is the pre-profile text, verbatim.
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: root })
  assert.match(full.tools.get('memory_search').description, /bring one back with memory_restore\./)
  assert.match(full.tools.get('memory_read_file').description, /that memory_attach moved out of the node body/)
})

test('#263 W2.1: materialized read surfaces carry no write instruction (handoff banner, advisories, supplied date)', async () => {
  // The section is not the whole prompt: the handoff banner, a node's advisory
  // list and the supplied conversation date are all rendered from the GRAPH at
  // assembly time, so each is a separate surface the read profile has to keep
  // read-shaped. All three were write-worded before this test existed.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-read-surfaces-'))
  const writer = fakeCtx()
  apply(writer.ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const write = writer.tools.get('memory_write')
  const handoffId = (await write.execute({ description: 'report still owed to the user', body: 'pending: the report', type: 'handoff' }, {})).id

  const read = fakeCtx()
  apply(read.ctx, { graphRoot: fresh, indexCacheMs: 0, promptProfile: 'read', contextDate: '2026-08-20' })
  const text = renderSection(read)
  // (1) The handoff banner keeps its visibility — ids, descriptions, read-first —
  //     and drops the two writes it used to order.
  assert.match(text, /Open handoff — unfinished work left for this session/)
  assert.ok(text.includes(handoffId), 'the open handoff is still named')
  assert.match(text, /memory_read it before anything that could touch its thread/)
  assert.ok(!text.includes('close a finished one by superseding it'), 'read: no close-out instruction')
  assert.ok(!text.includes('retyping it journal/thread'), 'read: no retype instruction')
  // (2) A supplied conversation date keeps the date and the weekday, drops how to date events.
  assert.match(text, /This conversation's date: 2026-08-20 \(Thursday\)\./)
  assert.ok(!text.includes('date events against it'), 'read: no event-dating instruction')
  // full still carries all three clauses, unchanged.
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: fresh, indexCacheMs: 0, contextDate: '2026-08-20' })
  const fullText = renderSection(full)
  assert.match(fullText, /close a finished one by superseding it/)
  assert.match(fullText, /This conversation's date: 2026-08-20 \(Thursday\) — date events against it, not against today\./)

  // (3) A node's queued advisories: the ROWS survive (they are facts about the
  //     node), the two write actions do not.
  const hub = (await write.execute({ description: 'advisory hub', body: 'seed' }, {})).id
  await fsp.appendFile(path.join(fresh, '.advisories'), `${new Date().toISOString()} node_size ${hub} body is 40000 chars\n`)
  const view = await read.tools.get('memory_read').execute({ id: hub }, {})
  const viewText = read.tools.get('memory_read').output.render({}, view)[0].text
  assert.match(viewText, /Maintenance advisories on this node \(the maintain pass addresses these\):/)
  assert.match(viewText, /node_size/, 'the advisory row itself is still shown')
  assert.ok(!viewText.includes('split an overgrown node into linked children'), 'read: no write action')
  const fullView = await full.tools.get('memory_read').execute({ id: hub }, {})
  assert.match(
    full.tools.get('memory_read').output.render({}, fullView)[0].text,
    /address what still applies \(split an overgrown node into linked children, refresh a stale description\)/,
    'full: unchanged',
  )
  await fsp.rm(fresh, { recursive: true, force: true })
})
