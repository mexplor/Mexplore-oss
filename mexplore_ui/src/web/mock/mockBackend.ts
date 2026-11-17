// Dev-only fake backend used with `?mock=1` (optionally `&nodes=2000` for a stress test).
// Deterministic synthetic data shaped like the real API; never shipped unless the URL asks for it.
import { HttpError, type Backend, type EventHandlers, type FileResult, type RunsQuery } from '../api.ts'
import type {
  AccessEvent,
  EdgeType,
  GraphEdge,
  GraphNode,
  GraphResponse,
  Meta,
  NodeDetail,
  NodeProvenance,
  ProvenanceEntry,
  RunSummary,
  RunsPage,
  SearchResponse,
  SeriesPoint,
  Stats,
  Usage,
  UsageSummary,
} from '../../shared/types.ts'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

interface MockNode extends GraphNode {
  body: string
  attachments: { name: string; size: number; mtime: string; content: string | null }[]
  access: AccessEvent[]
}

const SUBJECTS = [
  'magento order grid columns',
  'dsh plugin edge typing',
  'weekly report 2025W32',
  'launchd plist for memory agent',
  'Common 工序拆分 meeting',
  'bun sqlite WAL readonly',
  'graph-maintain prune policy',
  'user prefers uv for python',
  'frontend uses bun not npm',
  'service refactor decisions',
  'observation.jsonl usage capture',
  'A2A authority split read/manage',
  'review loop with a second model',
  'MAP.md ranking by access',
  'touch-edge strengthens edges',
  'supersede pattern for decisions',
  'handoff: finish port docs',
  'gotcha: FSEvents coalescing',
  'trivia: office wifi name',
  'identity: owner is alex',
  'decision: port 43190 for ui',
  'journal 2026-10-28 deploy',
  'thread: token spiral investigation',
  'preference: ISO dates only',
  'codex exec sandbox flags',
  'proxy NO_PROXY gotcha',
  'synthetic replay gate results',
  'experiment deploy script',
]

// Multilingual QA mix (deterministic by index, no rnd draws so the graph shape is unchanged):
// ~40% Chinese, ~20% Chinese mixed with Latin IDs / versions / emoji, the rest the Latin SUBJECTS above.
const ZH_SUBJECTS = [
  '发来文章/论文先默认存 Obsidian 01-Inbox，再决定是否整理',
  '周报模板：本周进展、风险与挑战、下周计划',
  '记忆图谱的边按访问次数加权排序',
  '部署前先跑门禁测试，失败不得上线',
  '会议纪要统一用中文，术语保留英文原文',
  '工序拆分会议结论：先拆公共模块，再拆业务线',
  '夜间批处理窗口改到凌晨三点',
  '图谱维护每周运行一次，不自动删除节点',
  '日期一律写绝对日期，不写“明天”“下周”',
  '新节点必须连到至少一个相关节点',
  '回答前先检索记忆，查不到就说不知道',
  '长上下文回退策略：先压缩历史，再切换模型',
  '交接文档写清楚阻塞点、负责人和下一步',
  '令牌螺旋问题的根因是重复检索同一节点',
  '评审流程：实现后复核，最多三轮',
  '本地代理会劫持回环地址请求',
]
const MIXED_SUBJECTS = [
  'v2.3 精简版移植到 main 分支（PR #42）',
  'DEMO-225 灰度 5% 拆分/回退跟踪',
  'scheduler 配置放在配置中心，不在部署包里',
  'EU+US 预发布上线（CR 1024，app42）',
  '端口 43190 只监听 127.0.0.1',
  '01J00000000000000000000004 的 supersede 链修复',
  '工单规范：团队 DEMO，项目「数据平台 | Data」',
  'gpt-6.1-sol 评审结论 2026-11-03：通过 🎉',
  'observation.jsonl 用量采集字段说明',
  'deploy.sh 回滚步骤与 NO_PROXY 设置',
]
/** Type-restating prefixes (stripped from graph labels when they match the Node's type). */
const ZH_PREFIX: Record<string, string> = {
  preference: '用户偏好：',
  decision: '决策：',
  gotcha: '踩坑：',
  handoff: '交接：',
  journal: '日志：',
}

function mockDescription(i: number, type: string | null): string {
  const bucket = (i * 7) % 10 // spreads the languages evenly through creation order
  const suffix = (n: number) => (i >= n ? ` (${Math.floor(i / n) + 1})` : '')
  if (bucket < 4) {
    const base = ZH_SUBJECTS[i % ZH_SUBJECTS.length]!
    // every third Chinese description carries a type prefix; a few deliberately mismatch the type (kept as-is)
    const prefix = i % 3 === 0 ? (type && ZH_PREFIX[type]) ?? (i % 2 ? '决策：' : '') : ''
    return `${prefix}${base}${suffix(ZH_SUBJECTS.length)}`
  }
  if (bucket < 6) return `${MIXED_SUBJECTS[i % MIXED_SUBJECTS.length]!}${suffix(MIXED_SUBJECTS.length)}`
  return `${SUBJECTS[i % SUBJECTS.length]!}${suffix(SUBJECTS.length)}`
}

const TYPES: (string | null)[] = [
  'decision',
  'decision',
  'thread',
  'thread',
  'journal',
  'preference',
  'gotcha',
  'handoff',
  'trivia',
  'identity',
  null,
  'journal',
  'decision',
]

function makeBody(rnd: () => number, desc: string, supersededBy: string | null, refs: string[]): string {
  const lines: string[] = []
  if (supersededBy) lines.push(`Superseded by ${supersededBy} on 2026-11-0${1 + Math.floor(rnd() * 3)}.`, '')
  lines.push(`# ${desc.charAt(0).toUpperCase()}${desc.slice(1)}`, '')
  lines.push(
    `Recorded while working on **${desc}**. The gist: keep the decision and the *why* together so future sessions can rank it.`,
    '',
  )
  if (rnd() < 0.6) {
    lines.push('## Facts', '', `- Applies since 2026-10-${10 + Math.floor(rnd() * 19)}`, `- Owner confirmed in chat`, `- Related: ${refs[0] ?? 'none'}`, '')
  }
  if (rnd() < 0.35) {
    lines.push('| key | value |', '|---|---|', '| port | 43190 |', '| bind | 127.0.0.1 |', '')
  }
  if (rnd() < 0.3) {
    lines.push('```sh', 'bun run build:web && bun run start -- --config ~/.config/memory-agent/test_1.json', '```', '')
  }
  if (rnd() < 0.15) {
    lines.push('Remote image (must be neutralised): ![diagram](https://example.com/tracker.png)', '')
    lines.push('<img src="https://example.com/pixel.gif" onerror="alert(1)"> <script>alert("x")</script>', '')
  }
  if (refs.length > 1) lines.push(`See also ${refs[1]} for the earlier context.`, '')
  return lines.join('\n')
}

/** Deterministic write history per node: some nodes have none (written before tracking), some mix chats. */
function mockProvenance(id: string, created: number, peers: string[], files: string[]): NodeProvenance {
  let seed = 0
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  const rnd = mulberry32(seed)
  const empty: NodeProvenance = { entries: [], first: null, truncated: false, skipped: 0, unreadable: false }
  if (rnd() < 0.3) return empty
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('')
  const chats: Pick<ProvenanceEntry, 'actor' | 'host' | 'session' | 'reason'>[] = [
    { actor: 'chat', host: 'dsh', session: `session-${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}` },
    { actor: 'chat', host: 'opencode', session: `ses_${hex(4)}${hex(22)}` },
    { actor: 'chat', host: 'dsh', session: null, reason: 'root-unverified' },
    { actor: 'import', host: 'dsh', session: null, reason: 'import' },
  ]
  const pick = () => chats[rnd() < 0.55 ? 0 : rnd() < 0.7 ? 1 : rnd() < 0.5 ? 2 : 3]!
  const origin = pick()
  const entries: ProvenanceEntry[] = [{ ts: new Date(created).toISOString(), op: 'create', ...origin, call: `call_${hex(10)}` }]
  let t = created
  const more = Math.floor(rnd() * 9)
  for (let i = 0; i < more; i++) {
    t += rnd() * 36e5 * 20
    const who = rnd() < 0.6 ? origin : pick()
    const roll = rnd()
    const base = { ts: new Date(Math.min(t, Date.now())).toISOString(), ...who, call: `call_${hex(10)}` }
    if (roll < 0.45 && peers.length) entries.push({ ...base, op: 'edge', peer: peers[Math.floor(rnd() * peers.length)]! })
    else if (roll < 0.6 && files.length) entries.push({ ...base, op: 'attach', file: files[Math.floor(rnd() * files.length)]! })
    else entries.push({ ...base, op: 'update' })
  }
  return { ...empty, entries, skipped: rnd() < 0.1 ? 1 : 0 }
}

export function createMockBackend(opts: { nodes: number }): Backend {
  const rnd = mulberry32(42)
  const now = Date.now()
  const DAY = 86_400_000
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  let generation = 1
  let idCounter = 0

  const ulid = (t: number) => {
    let ts = ''
    let x = Math.floor(t)
    for (let i = 0; i < 10; i++) {
      ts = CROCK[x % 32] + ts
      x = Math.floor(x / 32)
    }
    let r = ''
    for (let i = 0; i < 16; i++) r += CROCK[Math.floor(rnd() * 32)]
    idCounter++
    return ts + r
  }

  const nodes: MockNode[] = []
  const edges: GraphEdge[] = []
  const N = opts.nodes
  const span = 17 * DAY

  for (let i = 0; i < N; i++) {
    const t = now - span + (span * i) / N + rnd() * 3_600_000
    const subj = SUBJECTS[i % SUBJECTS.length]!
    const type = TYPES[Math.floor(rnd() * TYPES.length)] ?? null
    const id = ulid(t)
    const created = new Date(t).toISOString().slice(0, 10)
    const atts: MockNode['attachments'] = []
    const nAtt = rnd() < 0.45 ? 1 + Math.floor(rnd() * 3) : 0
    for (let k = 0; k < nAtt; k++) {
      const kind = Math.floor(rnd() * 4)
      const name =
        kind === 0
          ? `${subj.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${created}.md`
          : kind === 1
            ? 'observation.txt'
            : kind === 2
              ? 'screenshot.png'
              : 'transcript-full.log'
      const content =
        kind === 0
          ? `# ${subj}\n\nVerbatim deliverable.\n\n| row | value |\n|---|---|\n| 1 | alpha |\n| 2 | beta |\n\n![remote](https://example.com/a.png)\n`
          : kind === 1
            ? `observed ${subj}\nline two\nline three`
            : kind === 2
              ? null
              : 'x'.repeat(2000) + '\n…'
      if (!atts.some((a) => a.name === name)) atts.push({ name, size: content ? content.length * 37 : 482_113, mtime: new Date(t + DAY).toISOString(), content })
    }
    nodes.push({
      id,
      description: mockDescription(i, type),
      type,
      created,
      updated: rnd() < 0.3 ? new Date(t + DAY * 2).toISOString().slice(0, 10) : null,
      superseded: false,
      supersededBy: null,
      openHandoff: false,
      degree: 0,
      attachmentCount: atts.length,
      mapRank: null,
      visitCount: 0,
      body: '',
      attachments: atts,
      access: [],
    })
  }

  const edgeSet = new Set<string>()
  const addEdge = (a: string, b: string, type: EdgeType) => {
    const directed = type === 'supersedes' || type === 'follows-from'
    const [s, t] = directed ? [a, b] : a < b ? [a, b] : [b, a]
    const key = `${s}|${t}|${type}`
    const pk = s < t ? `${s}|${t}` : `${t}|${s}`
    if (s === t || edgeSet.has(key) || (!directed && edgeSet.has(pk))) return
    edgeSet.add(key)
    if (!directed) edgeSet.add(pk)
    const accessCount = rnd() < 0.4 ? 0 : Math.floor(Math.pow(rnd(), 3) * 40)
    edges.push({
      source: s,
      target: t,
      type,
      directed,
      halves: directed && rnd() < 0.7 ? 1 : 2,
      accessCount,
      lastAccess: accessCount ? new Date(now - rnd() * span).toISOString() : null,
    })
  }

  // tree-ish backbone with preferential attachment + clusters
  for (let i = 1; i < N; i++) {
    const links = 1 + (rnd() < 0.35 ? 1 : 0) + (rnd() < 0.1 ? 1 : 0)
    for (let k = 0; k < links; k++) {
      const j = rnd() < 0.6 ? Math.max(0, i - 1 - Math.floor(rnd() * 6)) : Math.floor(Math.pow(rnd(), 2) * i)
      const r = rnd()
      addEdge(nodes[i]!.id, nodes[j]!.id, r < 0.62 ? 'plain' : r < 0.86 ? 'relates-to' : 'follows-from')
    }
  }
  // supersede chains: newer supersedes older of similar subject
  for (let i = SUBJECTS.length; i < N; i++) {
    if (rnd() < 0.18) {
      const newer = nodes[i]!
      const older = nodes[i - SUBJECTS.length]!
      if (older.superseded) continue
      older.superseded = true
      older.supersededBy = newer.id
      addEdge(newer.id, older.id, 'supersedes')
    }
  }
  // a few isolated nodes
  for (let k = 0; k < 2; k++) nodes.push(mkIsolated())

  function mkIsolated(): MockNode {
    const t = now - rnd() * span
    return {
      id: ulid(t),
      description: 'orphan scratch note with no links yet',
      type: null,
      created: null,
      updated: null,
      superseded: false,
      supersededBy: null,
      openHandoff: false,
      degree: 0,
      attachmentCount: 0,
      mapRank: null,
      visitCount: 0,
      body: 'No frontmatter date; malformed node kept for the warnings list.',
      attachments: [],
      access: [],
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const finalize = () => {
    for (const n of nodes) n.degree = 0
    for (const e of edges) {
      byId.get(e.source)!.degree++
      byId.get(e.target)!.degree++
    }
    for (const n of nodes) n.openHandoff = n.type === 'handoff' && !n.superseded
  }
  finalize()

  for (const n of nodes) {
    const nbs = edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => (e.source === n.id ? e.target : e.source))
    if (!n.body) n.body = makeBody(rnd, n.description, n.supersededBy, nbs.slice(0, 2))
    n.visitCount = rnd() < 0.3 ? 0 : Math.floor(Math.pow(rnd(), 2) * 30)
    for (let k = 0; k < Math.min(n.visitCount, 8); k++) n.access.push({ src: n.id, dst: n.id, at: new Date(now - rnd() * span).toISOString() })
    for (const nb of nbs.slice(0, 3)) if (rnd() < 0.6) n.access.push({ src: n.id, dst: nb, at: new Date(now - rnd() * span).toISOString() })
    for (const nb of nbs.slice(0, 2)) if (rnd() < 0.4) n.access.push({ src: nb, dst: n.id, at: new Date(now - rnd() * span).toISOString() })
  }
  // MAP.md rank: strongest (degree + visits) first; ~8% unranked (new since last maintain)
  const ranked = [...nodes].filter(() => rnd() > 0.08).sort((a, b) => b.degree + b.visitCount / 4 - (a.degree + a.visitCount / 4))
  ranked.forEach((n, i) => (n.mapRank = i))

  const warnings = [
    'supersedes sidecar 01J00000000000000000000004 → 01J00000000000000000000003 has no "Superseded by" banner',
    'half-edge 01J00000000000000000000001 → 01J00000000000000000000002 has one symlink and no sidecar line (rendered as plain)',
    `malformed frontmatter in ${nodes[nodes.length - 1]!.id}/node.md (no created:)`,
  ]

  // ---- runs ----
  const runs: RunSummary[] = []
  const NR = 176
  for (let i = 0; i < NR; i++) {
    const authority = i % 2 === 0 ? 'read' : 'manage'
    const created = now - span + rnd() * span
    const lat = authority === 'read' ? 14_000 + Math.pow(rnd(), 2) * 50_000 : 22_000 + Math.pow(rnd(), 2) * 90_000
    const r = rnd()
    const status = r < 0.24 ? 'unknown' : r < 0.29 ? 'partial' : 'complete'
    let usage: Partial<Usage> | null = null
    if (status !== 'unknown') {
      const input = Math.floor(30_000 + Math.pow(rnd(), 3) * 300_000)
      const output = Math.floor(2_000 + rnd() * 9_000)
      const cacheRead = Math.floor(input * (0.4 + rnd() * 0.5))
      usage = {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        totalTokens: input + output + Math.floor(cacheRead * 0.7),
        ...(rnd() < 0.5 ? { reasoningTokens: Math.floor(output * 0.4) } : {}),
        ...(rnd() < 0.3 ? { cacheWriteTokens: Math.floor(input * 0.1) } : {}),
      }
    }
    runs.push({
      taskId: uuidFrom(rnd),
      authority,
      createdAt: new Date(created).toISOString(),
      latencyMs: rnd() < 0.02 ? null : Math.round(lat),
      usage,
      usageStatus: status,
    })
  }
  // the infamous spiral
  const spiral = runs[37]!
  spiral.usageStatus = 'complete'
  spiral.usage = { inputTokens: 701_220, outputTokens: 18_402, cacheReadTokens: 290_113, totalTokens: 925_307, reasoningTokens: 6_120 }
  spiral.latencyMs = 123_400

  const percentile = (sorted: number[], p: number): number | null =>
    sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null

  const statsOf = (rs: RunSummary[]): Stats => {
    const lat = rs.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b)
    const complete = rs.filter((r) => r.usageStatus === 'complete')
    const counted = rs.filter((r) => r.usageStatus !== 'unknown')
    const totals: Partial<Usage> = {}
    const keys: (keyof Usage)[] = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    for (const k of keys) {
      // contract: a component is omitted unless EVERY contributing run reports it (never summed as if 0)
      const vals = counted.map((r) => r.usage?.[k])
      if (vals.length && vals.every((v) => typeof v === 'number')) totals[k] = (vals as number[]).reduce((a, b) => a + b, 0)
    }
    const tpr = complete.map((r) => r.usage?.totalTokens ?? 0).sort((a, b) => a - b)
    return {
      runs: rs.length,
      runsWithLatency: lat.length,
      usageRuns: {
        complete: complete.length,
        partial: rs.filter((r) => r.usageStatus === 'partial').length,
        unknown: rs.filter((r) => r.usageStatus === 'unknown').length,
      },
      totals,
      tokensPerRun: {
        mean: tpr.length ? Math.round(tpr.reduce((a, b) => a + b, 0) / tpr.length) : null,
        p50: percentile(tpr, 0.5),
        p95: percentile(tpr, 0.95),
      },
      latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), max: lat.length ? lat[lat.length - 1]! : null },
    }
  }

  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const bucketOf = (t: number) => dayFmt.format(new Date(t))

  const point = (rs: RunSummary[]): SeriesPoint => {
    const lat = rs.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b)
    return {
      runs: rs.length,
      totalTokens: rs.filter((r) => r.usageStatus !== 'unknown').reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0),
      p50LatencyMs: percentile(lat, 0.5),
    }
  }

  const inRange = (from: string, to: string) => {
    const f = Date.parse(from)
    const t = Date.parse(to)
    return runs.filter((r) => {
      const c = Date.parse(r.createdAt)
      return c >= f && c < t
    })
  }

  const delay = <T,>(v: T, ms = 120 + rnd() * 160) => new Promise<T>((res) => setTimeout(() => res(structuredClone(v)), ms))

  const toGraphNode = (n: MockNode): GraphNode => {
    const { body: _b, attachments: _a, access: _x, ...g } = n
    return g
  }

  let usageDown = false

  // Failure toggles for visual QA: &failRuns=1 (always 503) | flaky (every other call) | page2 (any offset > 0) | &failUsage=1.
  // Ranges over 4000 days are rejected with 400 like the real server.
  const qp = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  let runsCalls = 0
  const rangeCheck = (from: string, to: string): Promise<never> | null =>
    Date.parse(to) - Date.parse(from) > 4000 * DAY
      ? new Promise((_, rej) => setTimeout(() => rej(new HttpError(400, 'range too large: at most 4000 days')), 80))
      : null
  const fail = (msg: string): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new HttpError(503, msg)), 150))

  const backend: Backend = {
    mock: true,
    meta: () =>
      delay<Meta>({
        configPath: '~/.config/memory-agent/test_1.json',
        graphRoot: '/Users/someone/Documents/memory_graph_fs/test_1',
        stateDir: '/Users/someone/.local/state/memory-agent/test_1',
        nodeCount: nodes.length,
        runCount: runs.length,
        serverTime: new Date().toISOString(),
        tz,
      }),
    graph: () =>
      delay<GraphResponse>({
        nodes: nodes.map(toGraphNode),
        edges,
        openHandoffs: nodes.filter((n) => n.openHandoff).map((n) => n.id),
        warnings,
        generation,
      }),
    node(id) {
      const n = byId.get(id)
      if (!n) return Promise.reject(new Error('404 node not found'))
      const neighbours: NodeDetail['neighbours'] = []
      for (const e of edges) {
        if (e.source !== id && e.target !== id) continue
        const other = e.source === id ? e.target : e.source
        neighbours.push({
          id: other,
          description: byId.get(other)?.description ?? '',
          edgeType: e.type,
          direction: !e.directed ? 'both' : e.source === id ? 'out' : 'in',
        })
      }
      const fm: Record<string, string> = { description: n.description }
      if (n.created) fm.created = n.created
      if (n.updated) fm.updated = n.updated
      if (n.type) fm.type = n.type
      return delay<NodeDetail>({
        ...toGraphNode(n),
        body: n.body,
        frontmatter: fm,
        attachments: n.attachments.map(({ name, size, mtime }) => ({ name, size, mtime })),
        neighbours,
        recentAccess: [...n.access].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50),
        provenance: mockProvenance(
          n.id,
          Date.parse(n.created ?? '') || now - 3 * DAY,
          neighbours.map((nb) => nb.id),
          n.attachments.map((a) => a.name),
        ),
      })
    },
    file(id, name): Promise<FileResult> {
      const a = byId.get(id)?.attachments.find((x) => x.name === name)
      if (!a) return delay<FileResult>({ kind: 'missing' })
      if (a.content === null) return delay<FileResult>({ kind: 'binary' })
      return delay<FileResult>({ kind: 'text', text: a.content, truncated: name.endsWith('.log') })
    },
    usage(from, to) {
      const bad = rangeCheck(from, to)
      if (bad) return bad
      if (qp.get('failUsage') === '1') return fail('usage query failed (mock)')
      if (usageDown) {
        const z = statsOf([])
        return delay<UsageSummary>({ from, to, tz, read: z, manage: z, combined: z, series: [], warnings: [], unavailable: true })
      }
      const rs = inRange(from, to)
      const buckets: string[] = []
      const f = Date.parse(from)
      const t = Date.parse(to)
      for (let x = f; x < t; x += 3_600_000) {
        const b = bucketOf(x)
        if (buckets[buckets.length - 1] !== b) buckets.push(b)
      }
      const series = buckets.map((bucket) => {
        const day = rs.filter((r) => bucketOf(Date.parse(r.createdAt)) === bucket)
        return {
          bucket,
          read: point(day.filter((r) => r.authority === 'read')),
          manage: point(day.filter((r) => r.authority === 'manage')),
          combined: point(day),
        }
      })
      return delay<UsageSummary>({
        from,
        to,
        tz,
        read: statsOf(rs.filter((r) => r.authority === 'read')),
        manage: statsOf(rs.filter((r) => r.authority === 'manage')),
        combined: statsOf(rs),
        series,
        warnings: ['1 orphan run directory without a task row (not shown)'],
      })
    },
    runs(q: RunsQuery) {
      const bad = rangeCheck(q.from, q.to)
      if (bad) return bad
      runsCalls++
      const fr = qp.get('failRuns')
      if (fr === '1' || (fr === 'flaky' && runsCalls % 2 === 0) || (fr === 'page2' && q.offset > 0)) return fail('runs query failed (mock)')
      if (usageDown) return delay<RunsPage>({ total: 0, offset: q.offset, limit: q.limit, runs: [], unavailable: true })
      const rs = inRange(q.from, q.to)
      const val = (r: RunSummary): number | null =>
        q.sort === 'createdAt' ? Date.parse(r.createdAt) : q.sort === 'latencyMs' ? r.latencyMs : (r.usage?.totalTokens ?? null)
      rs.sort((a, b) => {
        const va = val(a)
        const vb = val(b)
        if (va === null && vb === null) return a.taskId.localeCompare(b.taskId)
        if (va === null) return 1
        if (vb === null) return -1
        const d = q.dir === 'asc' ? va - vb : vb - va
        return d || a.taskId.localeCompare(b.taskId)
      })
      return delay<RunsPage>({ total: rs.length, offset: q.offset, limit: q.limit, runs: rs.slice(q.offset, q.offset + q.limit) })
    },
    search(q) {
      const s = q.trim().toLowerCase()
      const ids = s ? nodes.filter((n) => n.description.toLowerCase().includes(s) || n.body.toLowerCase().includes(s)).map((n) => n.id) : []
      return delay<SearchResponse>({ q, ids }, 80)
    },
    events(h: EventHandlers) {
      let tick = 0
      const open = setTimeout(() => h.onOpen(), 50)
      const iv = setInterval(() => {
        tick++
        // access hint: bump a random edge + a visit
        const e = edges[Math.floor(rnd() * edges.length)]
        if (e) {
          e.accessCount++
          e.lastAccess = new Date().toISOString()
          const src = byId.get(e.source)!
          src.access.unshift({ src: e.source, dst: e.target, at: e.lastAccess })
          generation++
          h.onEvent({ kind: 'access', id: e.source })
        }
        if (tick % 3 === 0) {
          // new node linked to an existing one
          const anchor = nodes[Math.floor(rnd() * nodes.length)]!
          const t = Date.now()
          const n: MockNode = {
            ...mkIsolated(),
            id: ulid(t),
            description: `live: new note #${tick / 3} near "${truncate(anchor.description)}"`,
            type: TYPES[Math.floor(rnd() * TYPES.length)] ?? null,
            created: new Date(t).toISOString().slice(0, 10),
          }
          n.body = makeBody(rnd, n.description, null, [anchor.id])
          nodes.push(n)
          byId.set(n.id, n)
          addEdge(n.id, anchor.id, 'plain')
          finalize()
          generation++
          h.onEvent({ kind: 'graph' })
        }
        if (tick % 2 === 0) {
          runs.push({
            taskId: uuidFrom(rnd),
            authority: rnd() < 0.5 ? 'read' : 'manage',
            createdAt: new Date().toISOString(),
            latencyMs: Math.round(15_000 + rnd() * 40_000),
            usage: { inputTokens: 80_000, outputTokens: 4_000, totalTokens: 120_000, cacheReadTokens: 50_000 },
            usageStatus: 'complete',
          })
          h.onEvent({ kind: 'run' })
        }
        // simulate a brief DB outage on tick 7 → 9
        if (tick === 7 || tick === 9) {
          usageDown = tick === 7
          h.onEvent({ kind: 'run' })
        }
      }, 9000)
      return () => {
        clearTimeout(open)
        clearInterval(iv)
      }
    },
  }
  return backend
}

function truncate(s: string) {
  const cps = Array.from(s) // never split a surrogate pair (descriptions include CJK + emoji)
  return cps.length > 24 ? cps.slice(0, 23).join('') + '…' : s
}

function uuidFrom(rnd: () => number): string {
  const h = () => Math.floor(rnd() * 16).toString(16)
  const seg = (n: number) => Array.from({ length: n }, h).join('')
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${'89ab'[Math.floor(rnd() * 4)]}${seg(3)}-${seg(12)}`
}
