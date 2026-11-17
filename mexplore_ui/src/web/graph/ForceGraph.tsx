// d3-force graph rendered into an SVG owned by this component. React owns props; d3 owns the DOM inside <svg>.
import { useEffect, useRef } from 'react'
import {
  drag,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
  type Selection,
  type Simulation,
  type ForceLink,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3'
import type { GraphResponse } from '../../shared/types.ts'
import {
  adjacency,
  buildSimModel,
  compareLabelPriority,
  displayWidth,
  EDGE_STYLES,
  LARGE_GRAPH,
  linkVisibility,
  NEIGHBOUR_LABEL_BUDGET,
  nodeTone,
  placeCardClear,
  planPan,
  topByPriority,
  type Box,
  trimSegment,
  type PrevPos,
  type SimLink,
  type SimNode,
  type Visibility,
} from '../graphModel.ts'
import { t as tr, tn as trn, useI18n, type MsgKey } from '../i18n.ts'
import { disambiguateLabels, labelBudget, placeLabels, type Dot, type LabelItem, type LabelSide, type PlacedLabel } from '../labelPlacement.ts'
import {
  bubbleColor,
  bubbleRadius,
  detectCommunities,
  focusTarget,
  SEMANTIC_MIN_NODES,
  semanticEnabled,
  semanticState,
  separateBubbles,
  SZ_FADE_END,
  type Community,
  type CommunityResult,
  type SemanticState,
} from './communities.ts'

export interface ForceGraphHandle {
  zoomBy(k: number): void
  fit(): void
  reheat(): void
}

interface Props {
  graph: GraphResponse | null
  visibility: ReadonlyMap<string, Visibility>
  selectedId: string | null
  /** Emphasise visible (non-dimmed) nodes with labels — used while a search is active. */
  emphasize: boolean
  labelsAlways: boolean
  /** Selection without hop focus: everything outside the selection's neighbourhood recedes. */
  lens: boolean
  /** Simple (local) view: a selected memory and ≤ 12 neighbours — every node is labelled if it fits. */
  local?: boolean
  /** Changes → fit the visible nodes into view. */
  fitSignal: number
  onSelect: (id: string | null) => void
  /** The selected card has no spot clear of the canvas overlays even after panning — free some space (legend). */
  onCardBlocked?: () => void
  handleRef?: React.RefObject<ForceGraphHandle | null>
}

type SvgSel = Selection<SVGSVGElement, unknown, null, undefined>
type GSel = Selection<SVGGElement, unknown, null, undefined>

interface Engine {
  svg: SvgSel
  root: GSel
  linksG: GSel
  nodesG: GSel
  /** Landmark + neighbour labels (placed by labelPlacement, counter-scaled to a constant screen size). */
  landmarksG: GSel
  /** Top layer for the selected / hovered Node's wrapped label (always above every dot and edge). */
  labelsG: GSel
  sim: Simulation<SimNode, SimLink>
  linkForce: ForceLink<SimNode, SimLink>
  zoomer: ZoomBehavior<SVGSVGElement, unknown>
  transform: ZoomTransform
  nodes: SimNode[]
  links: SimLink[]
  structureKey: string
  adj: Map<string, Set<string>>
  /** Label priority index (0 = labelled first), from MAP.md rank then degree. */
  priority: Map<string, number>
  selected: string | null
  vis: ReadonlyMap<string, Visibility>
  lens: boolean
  /** Neighbours of the selection / of the hovered Node that earned a label. */
  selLabelled: Set<string> | null
  hoverLabelled: Set<string> | null
  nodeById: Map<string, SimNode>
  /** Aa: maximise labels (much higher budget, still collision-culled). */
  maximise: boolean
  /** A search is active: matches rank first. */
  emphasize: boolean
  /** Last placement's side per label (hysteresis). */
  labelPrev: Map<string, LabelSide>
  labelTimer: number
  /** A zoom/pan gesture or transition is in flight: keep the last placement, just move it. */
  zooming: boolean
  widthCache: Map<string, number>
  measureCtx: CanvasRenderingContext2D | null
  /** performance.now() of the last placement (re-placed at most every PLACE_WHILE_MOVING_MS while the layout moves). */
  lastPlaceAt: number
  local: boolean
  /** Pending animation-frame placement during a zoom/pan gesture (live labels). */
  liveRaf: number | null
  /** Overlay boxes (legend, toolbars, focus note) in svg px; null = re-measure. Invalidated by the observers. */
  overlayCache: Box[] | null
  /** svg-local y where the bottom sheet (narrow windows) starts; the svg height without one. null = re-measure. */
  usableH: number | null
  /** --sans resolved once (getComputedStyle after DOM writes forces a style recalc). */
  fontFamily: string | null
  /** Live-placement cost while zooming/panning (read back from data-live-* for measurement). */
  liveFrames: number
  liveMsTotal: number
  liveMsMax: number
  /** performance.now() of the last fitVisible request. */
  lastFitAt: number
  /** What the last fit request framed: the whole graph, or the selection's neighbourhood (semantic zoom). */
  lastFitKind: 'all' | 'focus'
  /** performance.now() when the running fit transition ends; ensureInView waits for it instead of interrupting it */
  fitUntil: number
  inViewDefer: number
  /** svg size the last fit was computed for (a resize well away from it refits the simple view) */
  fitW: number
  fitH: number
  /** the selected card currently overlaps a canvas overlay (no clear spot at this pan) */
  cardBlocked: boolean
  onCardBlocked: () => void
  /** after a fit lands: re-check that the selection and its card are clear of the overlays (a refit can move them under) */
  onFitEnd: () => void
  fitEndTimer: number
  fitted: boolean
  tooltip: HTMLDivElement
  hover: string | null
  dragging: boolean
  lastRender: number
  loop: number | null
  firstFit: () => void
  /** Layout came to rest (live refreshes reheat it and can drift the selection under an overlay). */
  onSettle: () => void
  // ── semantic zoom (communities drawn as bubbles when zoomed far out) ──
  bubbleLinksG: GSel
  bubblesG: GSel
  bubbleLabelsG: GSel
  /** Communities of the current structure (null: graph too small / simple view). Memoized on commSig. */
  comm: CommunityResult | null
  commSig: string
  /** Node id → community index, aligned with `nodes` for the cohesion force. */
  commOf: Int32Array
  /** Each community's top nodes: the only node labels at mid zoom. */
  commTop: Set<string>
  bubbles: BubbleDatum[]
  /** Fit zoom of the whole graph (semantic levels are relative to it); 0 = not fitted yet. */
  szFitK: number
  anyHidden: boolean
  sz: SemanticState
  /** Bubble click → zoom into the community. */
  zoomToCommunity: (c: Community) => void
}

interface BubbleDatum {
  c: Community
  x: number
  y: number
  r: number
  /** Members drawn (not hidden by hop focus). */
  shown: number
  /** Members matching the filters / search (vis 'normal'). */
  hits: number
}

const LARGE = LARGE_GRAPH
/** At or below this many nodes a structure change is pre-settled synchronously (cheap: ≤ 60 nodes × 160 ticks). */
const SMALL_GRAPH = 60

/** Restart the layout. Small graphs use d3's own timer; large graphs run several ticks per frame in a time budget
 * and render once per batch, so convergence does not depend on how fast the browser can repaint the SVG. */
function kick(e: Engine, alpha: number) {
  if (e.loop !== null) cancelAnimationFrame(e.loop)
  e.loop = null
  if (e.nodes.length <= LARGE) {
    e.sim.alpha(alpha).restart()
    return
  }
  e.sim.stop()
  e.sim.alpha(alpha)
  const step = () => {
    const t0 = performance.now()
    while (performance.now() - t0 < 14 && e.sim.alpha() > e.sim.alphaMin()) e.sim.tick()
    ticked(e)
    if (!e.fitted && e.sim.alpha() < 0.3) e.firstFit()
    e.loop = e.sim.alpha() > e.sim.alphaMin() ? requestAnimationFrame(step) : null
    if (e.loop === null) {
      e.firstFit()
      e.onSettle()
    }
  }
  e.loop = requestAnimationFrame(step)
}

export function ForceGraph(props: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  // ---- mount: build static layers, simulation and zoom once ----
  useEffect(() => {
    const svgEl = svgRef.current!
    const svg = select(svgEl)
    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    for (const [type, st] of Object.entries(EDGE_STYLES)) {
      if (type !== 'supersedes' && type !== 'follows-from') continue
      for (const variant of ['', '-hl']) {
        defs
          .append('marker')
          .attr('id', `arrow-${type}${variant}`)
          .attr('viewBox', '0 -5 10 10')
          .attr('refX', 9)
          .attr('refY', 0)
          .attr('markerUnits', 'userSpaceOnUse')
          .attr('markerWidth', variant ? 11 : 9)
          .attr('markerHeight', variant ? 11 : 9)
          .attr('orient', 'auto')
          .append('path')
          .attr('d', 'M0,-4.2L10,0L0,4.2L2.2,0Z')
          .attr('fill', variant ? 'var(--ink)' : st.color)
      }
    }

    const root = svg.append('g').attr('class', 'fg-root')
    const linksG = root.append('g').attr('class', 'fg-links')
    const bubbleLinksG = root.append('g').attr('class', 'fg-bubble-links')
    const bubblesG = root.append('g').attr('class', 'fg-bubbles')
    const nodesG = root.append('g').attr('class', 'fg-nodes')
    const landmarksG = root.append('g').attr('class', 'fg-landmarks')
    const bubbleLabelsG = root.append('g').attr('class', 'fg-bubble-labels')
    const labelsG = root.append('g').attr('class', 'fg-labels')

    // Degree-aware link strength 0.8 / √min(degree(source), degree(target)). A fixed 0.55 bound hubs to each other as
    // tightly as leaves to their hub, so hub clusters collapsed into a ball; d3's default 1 / min(…) fixes that but
    // over-weakens hub-to-hub links and dissolves clusters (real graph: median hub→neighbour distance 91 / 143 / 102
    // for fixed / d3 default / this). Leaves stay ~0.8 (close to their hub); hub–hub links weaken with √degree.
    const linkForce = forceLink<SimNode, SimLink>()
      .id((d) => d.id)
      .distance((l) => {
        const s = l.source as SimNode
        const t = l.target as SimNode
        return 34 + (s.r ?? 6) + (t.r ?? 6) + (l.type === 'supersedes' ? 10 : 0)
      })

    const sim = forceSimulation<SimNode, SimLink>([])
      .force('link', linkForce)
      .force('charge', forceManyBody<SimNode>().strength(-170).distanceMax(520))
      .force('collide', forceCollide<SimNode>((d) => d.r + 4).strength(0.9))
      .force('x', forceX<SimNode>(0).strength(0.045))
      .force('y', forceY<SimNode>(0).strength(0.045))
      .alphaDecay(0.028)
      .velocityDecay(0.38)
      .stop()

    const rect = svgEl.getBoundingClientRect()
    const initial = zoomIdentity.translate((rect.width || 800) / 2, (rect.height || 600) / 2).scale(0.9)

    const zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.06, 6])
      .on('start', () => {
        const e = engineRef.current
        if (!e) return
        e.zooming = true
        e.liveFrames = 0
        e.liveMsTotal = 0
        e.liveMsMax = 0
      })
      .on('zoom', (ev: { transform: ZoomTransform }) => {
        root.attr('transform', ev.transform.toString())
        root.style('--k', String(ev.transform.k))
        const e = engineRef.current
        if (e) {
          e.transform = ev.transform
          updateZoomClasses(e)
          positionLabels(e)
          // labels follow their dots immediately, and are re-placed live once per animation frame (cached widths
          // and overlay boxes, hysteresis keeps them steady), so zooming in reveals local labels as you go
          positionLandmarks(e)
          if (e.sz.bubbles > 0) layoutBubbleLabels(e)
          requestLivePlacement(e)
        }
      })
      .on('end', () => {
        const e = engineRef.current
        if (!e) return
        e.zooming = false
        const svgEl = e.svg.node()!
        if (e.liveFrames) {
          svgEl.dataset.liveFrames = String(e.liveFrames)
          svgEl.dataset.liveAvgMs = (e.liveMsTotal / e.liveFrames).toFixed(2)
          svgEl.dataset.liveMaxMs = e.liveMsMax.toFixed(2)
        }
        schedulePlacement(e, 60)
      })
    svg.call(zoomer).on('dblclick.zoom', null)
    svg.call(zoomer.transform, initial)
    svg.on('click', (ev: MouseEvent) => {
      if (ev.target === svgEl) propsRef.current.onSelect(null)
    })

    const engine: Engine = {
      svg,
      root,
      linksG,
      nodesG,
      landmarksG,
      labelsG,
      sim,
      linkForce,
      zoomer,
      transform: initial,
      nodes: [],
      links: [],
      structureKey: '',
      adj: new Map(),
      priority: new Map(),
      selected: null,
      vis: new Map(),
      lens: false,
      selLabelled: null,
      hoverLabelled: null,
      nodeById: new Map(),
      maximise: false,
      emphasize: false,
      labelPrev: new Map(),
      labelTimer: 0,
      zooming: false,
      widthCache: new Map(),
      measureCtx: null,
      lastPlaceAt: 0,
      local: !!props.local,
      liveRaf: null,
      overlayCache: null,
      usableH: null,
      fontFamily: null,
      liveFrames: 0,
      liveMsTotal: 0,
      liveMsMax: 0,
      lastFitAt: 0,
      lastFitKind: 'all',
      fitUntil: 0,
      inViewDefer: 0,
      fitW: 0,
      fitH: 0,
      cardBlocked: false,
      onCardBlocked: () => propsRef.current.onCardBlocked?.(),
      onFitEnd: () => {},
      fitEndTimer: 0,
      fitted: false,
      tooltip: tipRef.current!,
      hover: null,
      dragging: false,
      lastRender: 0,
      loop: null,
      firstFit: () => {},
      onSettle: () => {},
      bubbleLinksG,
      bubblesG,
      bubbleLabelsG,
      comm: null,
      commSig: '',
      commOf: new Int32Array(0),
      commTop: new Set(),
      bubbles: [],
      szFitK: 0,
      anyHidden: false,
      sz: semanticState(1, 0, false),
      zoomToCommunity: (c) => zoomToCommunity(engine, svgEl, c),
    }
    engineRef.current = engine
    // the initial zoom event fired before the engine existed — classify the zoom level now
    updateZoomClasses(engine)

    const firstFit = () => {
      if (!engine.fitted && engine.nodes.length) {
        engine.fitted = true
        fitVisible(engine, svgEl, propsRef.current.visibility, 700)
      }
    }
    engine.firstFit = firstFit
    sim.on('tick', () => {
      // Large graphs: the simulation ticks every frame but the DOM is only rewritten ~10×/s (always while dragging).
      const now = performance.now()
      if (engine.nodes.length <= LARGE || engine.dragging || now - engine.lastRender > 90) {
        engine.lastRender = now
        ticked(engine)
      }
      if (!engine.fitted && sim.alpha() < 0.3) firstFit()
    })
    sim.on('end', () => {
      ticked(engine)
      firstFit()
      engine.onSettle()
    })

    // keep the view centred when the canvas resizes (e.g. the node panel opens)
    let last = { w: svgEl.clientWidth, h: svgEl.clientHeight }
    let resizeFitTimer = 0
    let inViewTimer = 0
    /** Debounced: keep the current selection (and its card) clear of the canvas edges and every overlay.
     * A no-op when it already is, so it is safe to call on any layout change. */
    const scheduleInView = (delay: number) => {
      window.clearTimeout(inViewTimer)
      inViewTimer = window.setTimeout(() => {
        const id = propsRef.current.selectedId
        if (id) ensureInView(engine, svgEl, id)
      }, delay)
    }
    engine.onFitEnd = () => {
      const id = propsRef.current.selectedId
      if (id) ensureInView(engine, svgEl, id)
    }
    engine.onSettle = () => {
      // semantic zoom levels are relative to the zoom that fits the settled layout
      if (engine.comm && !engine.local) {
        engine.szFitK = fitScale(engine, svgEl.clientWidth, usableH(engine))
        updateZoomClasses(engine)
      }
      scheduleInView(60)
      schedulePlacement(engine, 80)
    }
    const ro = new ResizeObserver(() => {
      const w = svgEl.clientWidth
      const h = svgEl.clientHeight
      if (!w || !h) return
      if (last.w && last.h && (w !== last.w || h !== last.h)) {
        if (performance.now() - engine.lastFitAt < 1200) {
          // a fit was just requested (e.g. a card opened the graph and the side panel at once): fit again for the new
          // size — re-centring would interrupt the fit's transition halfway and leave the graph tiny
          const id = propsRef.current.selectedId
          if (!(engine.lastFitKind === 'focus' && id && focusSelection(engine, svgEl, id, 400)))
            fitVisible(engine, svgEl, propsRef.current.visibility, 400)
        } else {
          const t = engine.transform.translate((w - last.w) / 2 / engine.transform.k, (h - last.h) / 2 / engine.transform.k)
          svg.call(zoomer.transform, t)
          // simple view: re-centring keeps a scale chosen for the old size — once the resize settles well away from
          // the size it was fitted for, refit so it matches a fresh open at the new size
          if (engine.local) {
            window.clearTimeout(resizeFitTimer)
            resizeFitTimer = window.setTimeout(() => {
              const cw = svgEl.clientWidth
              const ch = svgEl.clientHeight
              if (Math.abs(cw - engine.fitW) > 24 || Math.abs(ch - engine.fitH) > 24) fitVisible(engine, svgEl, propsRef.current.visibility, 350)
            }, 220)
          }
        }
        // a tooltip placed for the old canvas size would hang off the new one
        engine.tooltip.hidden = true
        engine.overlayCache = null
        engine.usableH = null
        // the side panel opening can push the selection (and its label) off the shrunken canvas
        scheduleInView(80)
        schedulePlacement(engine, 160)
      }
      last = { w, h }
    })
    ro.observe(svgEl)

    // Overlays (legend, focus bar, zoom tools) can grow over the selection — e.g. expanding the legend.
    // Watch exactly the elements overlayObstacles() measures; a MutationObserver re-targets the ResizeObserver
    // when React swaps one (the legend is a different element open vs collapsed) or a new overlay appears.
    // The bottom sheet (narrow windows) is watched too: collapsing / expanding it changes the visible part of the
    // canvas without resizing the svg — the simple view refits into what is left, the full graph just pans.
    let sheetTimer = 0
    let lastUsable = -1
    const overlayRO = new ResizeObserver(() => {
      engine.overlayCache = null
      engine.usableH = null
      scheduleInView(120)
      schedulePlacement(engine, 160)
      window.clearTimeout(sheetTimer)
      sheetTimer = window.setTimeout(() => {
        const u = usableHeight(svgEl)
        if (lastUsable >= 0 && Math.abs(u - lastUsable) > 1 && engine.local && engine.nodes.length)
          fitVisible(engine, svgEl, propsRef.current.visibility, 400)
        lastUsable = u
      }, 140)
    })
    const watchOverlays = () => {
      overlayRO.disconnect()
      for (const el of overlayElements(svgEl)) overlayRO.observe(el)
    }
    const host = svgEl.closest('.canvas')
    const wrap = svgEl.parentElement // svg + tooltip mutate constantly; never react to those
    const mo = new MutationObserver((records) => {
      if (records.every((r) => !!wrap && wrap.contains(r.target))) return
      engine.overlayCache = null
      engine.usableH = null
      watchOverlays()
      scheduleInView(120)
      schedulePlacement(engine, 160)
    })
    if (host) mo.observe(host, { childList: true, subtree: true })
    // the detail panel mounts / turns into a sheet outside .canvas
    const layout = svgEl.closest('.graph-layout')
    if (layout) mo.observe(layout, { childList: true, attributes: true, attributeFilter: ['class'] })
    const panel = layout?.querySelector(':scope > .panel')
    if (panel) mo.observe(panel, { attributes: true, attributeFilter: ['class'] })
    watchOverlays()
    lastUsable = usableHeight(svgEl)

    return () => {
      // the graph mounts/unmounts as the user moves between the landing page and a graph: leave nothing behind
      if (engine.loop !== null) cancelAnimationFrame(engine.loop)
      if (engine.liveRaf !== null) cancelAnimationFrame(engine.liveRaf)
      window.clearTimeout(inViewTimer)
      window.clearTimeout(sheetTimer)
      window.clearTimeout(resizeFitTimer)
      window.clearTimeout(engine.fitEndTimer)
      window.clearTimeout(engine.inViewDefer)
      window.clearTimeout(engine.labelTimer)
      svg.interrupt()
      ro.disconnect()
      overlayRO.disconnect()
      mo.disconnect()
      sim.stop()
      svg.on('.zoom', null)
      svg.selectAll('*').remove()
      engineRef.current = null
    }
  }, [])

  // ---- data: join nodes/links, keep positions by id ----
  useEffect(() => {
    const e = engineRef.current
    const graph = props.graph
    if (!e || !graph) return
    const prev = new Map<string, PrevPos>()
    for (const n of e.nodes) prev.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy })
    const model = buildSimModel(graph, prev)
    const structureKey =
      model.nodes.map((n) => n.id).join(',') + '#' + model.links.map((l) => l.key).join(',')
    const structureChanged = structureKey !== e.structureKey
    e.structureKey = structureKey
    e.nodes = model.nodes
    e.nodeById = new Map(model.nodes.map((n) => [n.id, n]))
    e.links = model.links
    e.adj = adjacency(model.links.map((l) => ({ source: l.data.source, target: l.data.target })))
    e.priority = new Map(
      model.nodes
        .map((n) => n.data)
        .sort(compareLabelPriority)
        .map((n, i) => [n.id, i]),
    )
    syncCommunities(e, structureKey)
    const large = model.nodes.length > LARGE
    svgRef.current!.classList.toggle('large', large)
    updateZoomClasses(e)
    e.sim.alphaDecay(large ? 0.045 : 0.028).alphaMin(large ? 0.01 : 0.001)
    e.sim.nodes(model.nodes)
    e.linkForce.links(model.links)
    // Degree-aware link strength 0.8 / √min(degree(source), degree(target)), on the degree *in this graph* (the
    // simple view's 13-node star has leaves of degree 1 even when they are hubs globally). A fixed 0.55 bound hubs
    // to each other as tightly as leaves to their hub (hub clusters collapsed into a ball); d3's default 1 / min(…)
    // over-weakens hub–hub links and dissolves clusters.
    const deg = new Map<string, number>()
    for (const l of model.links) {
      deg.set(l.data.source, (deg.get(l.data.source) ?? 0) + 1)
      deg.set(l.data.target, (deg.get(l.data.target) ?? 0) + 1)
    }
    e.linkForce.strength((l) => {
      const a = deg.get((l.source as SimNode).id) ?? 1
      const b = deg.get((l.target as SimNode).id) ?? 1
      return 0.8 / Math.sqrt(Math.max(1, Math.min(a, b)))
    })

    joinLinks(e)
    joinNodes(e, svgRef.current!, propsRef)
    joinBubbles(e)
    applyClasses(e, propsRef.current)

    if (structureChanged) {
      const first = prev.size === 0
      if (model.nodes.length <= SMALL_GRAPH) {
        // small graphs (the simple view re-layouts on every navigation): settle synchronously so the star appears
        // in place, the fit lands on final positions and the selected card is visible straight away
        e.sim.stop()
        if (e.loop !== null) cancelAnimationFrame(e.loop)
        e.loop = null
        e.sim.alpha(first ? 1 : 0.6)
        for (let i = 0; i < 200; i++) e.sim.tick() // alpha decays to < 0.003: effectively at rest
        ticked(e)
        e.firstFit()
        // the simple view's star changed (filters, navigation): refit, so its labels get the room the fit plans for
        if (!first && e.local) fitVisible(e, svgRef.current!, propsRef.current.visibility, 450)
        e.onSettle()
      } else if (first && model.nodes.length <= 500) {
        e.sim.alpha(1)
        for (let i = 0; i < 90; i++) e.sim.tick()
        ticked(e)
        kick(e, 0.35)
      } else kick(e, first ? 1 : model.added.length ? 0.45 : 0.15)
    } else {
      ticked(e) // styles may have changed (access counts); positions unchanged
    }
    // labels may have changed (and new Nodes may need one); the settle hook re-places once the layout rests
    schedulePlacement(e, 250)
  }, [props.graph])

  // ---- selection / visibility / emphasis: classes only, no relayout ----
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.local = !!props.local
    applyClasses(e, props)
  }, [props.selectedId, props.visibility, props.emphasize, props.labelsAlways, props.lens, props.local])

  // language switch: the svg's accessible name is set here; tooltips/labels are rebuilt on their next use
  const { t } = useI18n()
  useEffect(() => {
    const e = engineRef.current
    if (e) syncBubbleText(e)
  }, [t])

  useEffect(() => {
    const e = engineRef.current
    if (!e || props.fitSignal <= 0) return
    // semantic zoom: a selection frames its own neighbourhood instead of refitting the whole graph (which lands on
    // bubbles); everything else (deselect, hop focus, small graphs, simple view) refits as before
    const id = propsRef.current.selectedId
    if (id && focusSelection(e, svgRef.current!, id, 650)) return
    fitVisible(e, svgRef.current!, propsRef.current.visibility, 650)
  }, [props.fitSignal])

  // imperative handle for toolbar buttons
  useEffect(() => {
    if (!props.handleRef) return
    props.handleRef.current = {
      zoomBy(k) {
        const e = engineRef.current
        if (e) e.svg.transition().duration(250).call(e.zoomer.scaleBy, k)
      },
      fit() {
        const e = engineRef.current
        if (e) fitVisible(e, svgRef.current!, propsRef.current.visibility, 650)
      },
      reheat() {
        const e = engineRef.current
        if (e) kick(e, 0.8)
      },
    }
  }, [props.handleRef])

  // keep the selected node in view when it changes (from list / panel navigation)
  useEffect(() => {
    const e = engineRef.current
    const id = props.selectedId
    if (!e || !id) return
    const timer = window.setTimeout(() => {
      const svgEl = svgRef.current
      if (svgEl) ensureInView(e, svgEl, id)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [props.selectedId])

  return (
    <div className="fg-wrap">
      <svg ref={svgRef} className="fg-svg" role="img" aria-label={t('graph.aria')} />
      <div ref={tipRef} className="fg-tip" hidden />
    </div>
  )
}

/** Edge styling only (labels are placed by labelPlacement): zoom-near lifts the edge-width cap, zoom-far lets large
 * graphs hide plain edges. */
function updateZoomClasses(e: Engine) {
  const el = e.svg.node()!
  const k = e.transform.k
  el.classList.toggle('zoom-near', k >= 1.8)
  el.classList.toggle('zoom-far', k < 0.45)
  updateSemantic(e)
}

// ───────────── semantic zoom: communities as bubbles ─────────────

/** Pull toward the community's centroid (× alpha), so each community lays out as one patch its bubble can cover. */
const COHESION = 0.08

/**
 * Resolve the semantic zoom level (far: bubbles only · fade: crossfade · mid: top labels only · near: today's view)
 * from the zoom relative to the whole graph's fit zoom, and apply it: svg classes (CSS hides / fades the node and
 * link layers), --sz-n (node opacity in the fade band) and the bubble layers' opacity.
 */
function updateSemantic(e: Engine) {
  const el = e.svg.node()!
  const enabled =
    !!e.comm && semanticEnabled({ nodeCount: e.nodes.length, communityCount: e.comm.communities.length, local: e.local, anyHidden: e.anyHidden })
  let fitK = e.szFitK
  if (enabled && !(fitK > 0)) fitK = fitScale(e, el.clientWidth || 800, el.clientHeight || 600)
  const prev = e.sz
  const sz = semanticState(e.transform.k, fitK, enabled)
  e.sz = sz
  el.classList.toggle('sz-far', sz.level === 'far')
  el.classList.toggle('sz-fade', sz.level === 'fade')
  el.classList.toggle('sz-mid', sz.level === 'mid')
  el.style.setProperty('--sz-n', sz.nodes.toFixed(3))
  el.dataset.sz = sz.level
  const show = sz.bubbles > 0.01
  for (const g of [e.bubbleLinksG, e.bubblesG, e.bubbleLabelsG]) {
    const n = g.node()!
    n.style.display = show ? '' : 'none'
    n.style.opacity = sz.bubbles.toFixed(3)
  }
  // bubbles are not repositioned while hidden: catch up as they appear
  if (show && prev.bubbles <= 0.01) {
    positionBubbles(e)
    layoutBubbleLabels(e)
  }
}

/** Cluster the graph once per structure (+ descriptions); the simple view and small graphs have no communities. */
function syncCommunities(e: Engine, structureKey: string) {
  if (e.local || e.nodes.length < SEMANTIC_MIN_NODES) {
    e.comm = null
    e.commSig = ''
    e.commTop = new Set()
    e.commOf = new Int32Array(e.nodes.length).fill(-1)
    e.sim.force('community', null)
    return
  }
  // FNV-1a over the descriptions: topic words change with them even when the structure does not
  let h = 2166136261
  for (const n of e.nodes) {
    const d = n.data.description
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d.charCodeAt(i), 16777619)
    h = Math.imul(h ^ 10, 16777619)
  }
  const sig = `${structureKey}#${h >>> 0}`
  if (sig !== e.commSig || !e.comm) {
    const t0 = performance.now()
    e.comm = detectCommunities(
      e.nodes.map((n) => ({ id: n.id, description: n.data.description, type: n.data.type, degree: n.data.degree })),
      e.links.map((l) => ({ source: l.data.source, target: l.data.target })),
    )
    e.commSig = sig
    e.commTop = new Set(e.comm.communities.flatMap((c) => c.top))
    const svgEl = e.svg.node()!
    svgEl.dataset.communities = String(e.comm.communities.length)
    svgEl.dataset.communityMs = (performance.now() - t0).toFixed(1)
  }
  const comm = e.comm
  e.commOf = Int32Array.from(e.nodes, (n) => comm.of.get(n.id) ?? -1)
  let sx = new Float64Array(0)
  let sy = new Float64Array(0)
  let cnt = new Float64Array(0)
  e.sim.force('community', (alpha: number) => {
    const m = e.comm?.communities.length ?? 0
    if (!m) return
    if (sx.length !== m) {
      sx = new Float64Array(m)
      sy = new Float64Array(m)
      cnt = new Float64Array(m)
    } else {
      sx.fill(0)
      sy.fill(0)
      cnt.fill(0)
    }
    const nodes = e.nodes
    const of = e.commOf
    for (let i = 0; i < nodes.length; i++) {
      const c = of[i]!
      const n = nodes[i]!
      if (c < 0 || n.x === undefined || n.y === undefined) continue
      sx[c]! += n.x
      sy[c]! += n.y
      cnt[c]! += 1
    }
    const s = COHESION * alpha
    for (let i = 0; i < nodes.length; i++) {
      const c = of[i]!
      const n = nodes[i]!
      if (c < 0 || n.x === undefined || n.y === undefined || !cnt[c]) continue
      n.vx = (n.vx ?? 0) + (sx[c]! / cnt[c]! - n.x) * s
      n.vy = (n.vy ?? 0) + (sy[c]! / cnt[c]! - n.y) * s
    }
  })
}

function joinBubbles(e: Engine) {
  const comms = e.comm?.communities ?? []
  e.bubbles = comms.map((c) => ({ c, x: 0, y: 0, r: 0, shown: c.members.length, hits: c.members.length }))
  e.bubblesG
    .selectAll<SVGGElement, BubbleDatum>('g.fg-bubble')
    .data(e.bubbles, (d) => d.c.key)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'fg-bubble')
      g.append('circle')
      g.append('title')
      return g
    })
    // colour identifies the community (by size slot), not a node type: dots keep the type colours
    .classed('other', (d) => d.c.other)
    .classed('tint', (d) => bubbleColor(d.c).tier === 'tint')
    .classed('neutral', (d) => bubbleColor(d.c).tier === 'neutral')
    .style('--c', (d) => bubbleColor(d.c).color)
    .on('click', (ev: MouseEvent, d) => {
      ev.stopPropagation() // an svg click clears the selection
      e.zoomToCommunity(d.c)
    })
  e.bubbleLinksG
    .selectAll<SVGLineElement, { a: number; b: number; count: number }>('line')
    // a single shared link between two communities is noise at this scale
    .data((e.comm?.links ?? []).filter((l) => l.count >= 2), (l) => `${l.a}|${l.b}`)
    .join('line')
    .attr('class', 'fg-bubble-link')
    .attr('stroke-width', (l) => Math.min(9, 0.8 + Math.sqrt(l.count) * 1.1).toFixed(2))
  e.bubbleLabelsG
    .selectAll<SVGTextElement, BubbleDatum>('text')
    .data(e.bubbles, (d) => d.c.key)
    .join((enter) => {
      const t = enter.append('text')
      t.append('tspan').attr('class', 'bt-terms').attr('x', 0).attr('y', -1)
      t.append('tspan').attr('class', 'bt-count').attr('x', 0).attr('y', 13)
      return t
    })
  updateBubbleCounts(e)
}

/** Members shown / matching per bubble (hop focus hides, filters and search dim), then refresh text and geometry. */
function updateBubbleCounts(e: Engine) {
  if (!e.bubbles.length) return
  for (const b of e.bubbles) {
    let shown = 0
    let hits = 0
    for (const id of b.c.members) {
      const v = e.vis.get(id) ?? 'normal'
      if (v === 'hidden') continue
      shown++
      if (v === 'normal') hits++
    }
    b.shown = shown
    b.hits = hits
  }
  e.bubblesG.selectAll<SVGGElement, BubbleDatum>('g.fg-bubble').classed('no-hits', (d) => d.hits === 0)
  syncBubbleText(e)
  positionBubbles(e)
  layoutBubbleLabels(e)
}

/** Bubble titles and tooltips in the current language (also re-run on a language switch). */
function syncBubbleText(e: Engine) {
  if (!e.bubbles.length) return
  if (!e.fontFamily) e.fontFamily = sansFamily()
  const family = e.fontFamily
  const scale = (12 / LABEL_FONT_PX) * 1.06 // bubble titles are 12px semibold (styles.css); labels are measured at 11px / 500
  const title = (d: BubbleDatum) => {
    if (d.c.other) return tr('bubble.misc')
    if (d.c.terms.length) return d.c.terms.join(' · ')
    return e.nodeById.get(d.c.top[0] ?? '')?.label ?? ''
  }
  const count = (d: BubbleDatum) => (d.hits < d.shown ? tr('bubble.matching', { n: d.hits, total: d.shown }) : trn('bubble.count', d.shown))
  e.bubbleLabelsG.selectAll<SVGTextElement, BubbleDatum>('text').each(function (d) {
    const text = title(d)
    const sub = count(d)
    select(this).select('tspan.bt-terms').text(text)
    select(this).select('tspan.bt-count').text(sub)
    this.dataset.w = String(Math.max(measureLabel(e, text, family).w * scale, measureLabel(e, sub, family).w))
  })
  e.bubblesG
    .selectAll<SVGGElement, BubbleDatum>('g.fg-bubble')
    .select('title')
    .text((d) => tr('bubble.title', { terms: title(d), count: count(d) }))
}

/** Bubble centre = centroid of its drawn members (then pushed apart so no two overlap), area ∝ member count;
 * aggregated links run rim to rim. */
function positionBubbles(e: Engine) {
  const m = e.bubbles.length
  if (!m) return
  const sx = new Float64Array(m)
  const sy = new Float64Array(m)
  const cnt = new Float64Array(m)
  for (let i = 0; i < e.nodes.length; i++) {
    const c = e.commOf[i]!
    const n = e.nodes[i]!
    if (c < 0 || c >= m || n.x === undefined || n.y === undefined || e.vis.get(n.id) === 'hidden') continue
    sx[c]! += n.x
    sy[c]! += n.y
    cnt[c]! += 1
  }
  for (let c = 0; c < m; c++) {
    const b = e.bubbles[c]!
    if (cnt[c]) {
      b.x = sx[c]! / cnt[c]!
      b.y = sy[c]! / cnt[c]!
    }
    b.r = b.shown ? bubbleRadius(b.shown) : 0
  }
  separateBubbles(e.bubbles)
  for (const el of e.bubblesG.node()!.children as unknown as SVGGElement[]) {
    const b = (el as unknown as { __data__: BubbleDatum }).__data__
    const circle = el.firstElementChild as SVGCircleElement
    circle.setAttribute('cx', b.x.toFixed(1))
    circle.setAttribute('cy', b.y.toFixed(1))
    circle.setAttribute('r', b.r.toFixed(1))
    el.style.display = b.shown ? '' : 'none'
  }
  for (const el of e.bubbleLinksG.node()!.children as unknown as SVGLineElement[]) {
    const l = (el as unknown as { __data__: { a: number; b: number } }).__data__
    const a = e.bubbles[l.a]
    const b = e.bubbles[l.b]
    if (!a || !b || !a.shown || !b.shown) {
      el.style.display = 'none'
      continue
    }
    const seg = trimSegment(a.x, a.y, b.x, b.y, a.r, b.r)
    // overlapping bubbles: no stub of a line
    el.style.display = Math.hypot(b.x - a.x, b.y - a.y) <= a.r + b.r ? 'none' : ''
    el.setAttribute('x1', seg.x1.toFixed(1))
    el.setAttribute('y1', seg.y1.toFixed(1))
    el.setAttribute('x2', seg.x2.toFixed(1))
    el.setAttribute('y2', seg.y2.toFixed(1))
  }
}

/** Bubble titles: centred on the bubble at a constant screen size; largest bubbles first, a title that would overlap
 * an earlier one (or sit off screen) is hidden. Cheap (≤ MAX_COMMUNITIES + 1), so it runs on every zoom frame. */
function layoutBubbleLabels(e: Engine) {
  if (!e.bubbles.length) return
  const svgEl = e.svg.node()!
  const W = svgEl.clientWidth
  const H = usableH(e)
  const t = e.transform
  const inv = 1 / t.k
  const placed: Box[] = []
  const els = [...(e.bubbleLabelsG.node()!.children as unknown as SVGTextElement[])]
  const datum = (el: SVGTextElement) => (el as unknown as { __data__: BubbleDatum }).__data__
  els.sort((a, b) => datum(b).shown - datum(a).shown || datum(a).c.index - datum(b).c.index)
  for (const el of els) {
    const d = datum(el)
    const [sx, sy] = t.apply([d.x, d.y])
    const w = Number(el.dataset.w) || 80
    const box: Box = { left: sx - w / 2 - 3, right: sx + w / 2 + 3, top: sy - 15, bottom: sy + 17 }
    const ok =
      d.shown > 0 &&
      box.right > 0 &&
      box.left < W &&
      box.bottom > 0 &&
      box.top < H &&
      placed.every((p) => p.left >= box.right || p.right <= box.left || p.top >= box.bottom || p.bottom <= box.top)
    el.style.display = ok ? '' : 'none'
    if (!ok) continue
    placed.push(box)
    el.setAttribute('transform', `translate(${d.x.toFixed(1)},${d.y.toFixed(1)}) scale(${inv.toFixed(4)})`)
  }
}

/** Zoom so the community fills the canvas — at least far enough in that its nodes are fully drawn. */
function zoomToCommunity(e: Engine, svgEl: SVGSVGElement, c: Community) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const id of c.members) {
    const n = e.nodeById.get(id)
    if (!n || n.x === undefined || n.y === undefined || e.vis.get(id) === 'hidden') continue
    x0 = Math.min(x0, n.x - n.r)
    y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r)
    y1 = Math.max(y1, n.y + n.r)
  }
  if (!Number.isFinite(x0)) return
  const w = svgEl.clientWidth
  const h = usableHeight(svgEl)
  if (!w || !h) return
  const pad = 70
  const fitK = e.szFitK || fitScale(e, w, h)
  const k = Math.min(6, Math.max(fitK * SZ_FADE_END * 1.05, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))))
  const t = zoomIdentity
    .translate(w / 2, h / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2)
  e.svg.transition().duration(650).call(e.zoomer.transform, t)
}

// ───────────── landmark labels ─────────────

/** One label size for every script (user decision: all labels the same size). Keep in sync with styles.css. */
const LABEL_FONT_PX = 11
const LABEL_PAD = 2 // halo + air on each side of the measured text
const VIEW_INSET = 4
const PLACE_WHILE_MOVING_MS = 450

/** Live placement during a zoom/pan gesture: at most once per animation frame. */
function requestLivePlacement(e: Engine) {
  if (e.liveRaf !== null) return
  e.liveRaf = requestAnimationFrame(() => {
    e.liveRaf = null
    const t0 = performance.now()
    runPlacement(e)
    const ms = performance.now() - t0
    e.liveFrames++
    e.liveMsTotal += ms
    e.liveMsMax = Math.max(e.liveMsMax, ms)
  })
}

/** Debounced re-placement; while a zoom gesture is in flight the live (per-frame) path does the work instead. */
function schedulePlacement(e: Engine, delay: number) {
  window.clearTimeout(e.labelTimer)
  e.labelTimer = window.setTimeout(() => {
    if (e.zooming) return
    runPlacement(e)
  }, delay)
}

/** The UI's --sans font stack, read once per engine (getComputedStyle after DOM writes forces a style recalc). */
function sansFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'sans-serif'
}

/** Text width in px, measured once per text (one font for every label) with a canvas using the same font as the SVG. */
function measureLabel(e: Engine, text: string, family: string): { w: number; h: number } {
  const px = LABEL_FONT_PX
  const key = text
  let w = e.widthCache.get(key)
  if (w === undefined) {
    if (!e.measureCtx) {
      e.measureCtx = document.createElement('canvas').getContext('2d')
    }
    const ctx = e.measureCtx
    if (ctx) {
      ctx.font = `500 ${px}px ${family}`
      w = ctx.measureText(text).width
    } else {
      w = displayWidth(text) * px * 0.55
    }
    if (e.widthCache.size > 20000) e.widthCache.clear()
    e.widthCache.set(key, w)
  }
  return { w: w + LABEL_PAD * 2, h: Math.round(px * 1.3) + 2 }
}

/** The zoom at which the visible graph fits the canvas (same rule as fitVisible). */
function fitScale(e: Engine, w: number, h: number): number {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of e.nodes) {
    if (n.x === undefined || n.y === undefined || e.vis.get(n.id) === 'hidden') continue
    x0 = Math.min(x0, n.x - n.r)
    y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r)
    y1 = Math.max(y1, n.y + n.r)
  }
  if (!Number.isFinite(x0)) return e.transform.k
  const pad = 70
  return Math.min(1.6, Math.max(0.06, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))))
}

interface LandmarkDatum {
  id: string
  text: string
  side: LabelSide
  box: { left: number; top: number; right: number; bottom: number }
  cjk: boolean
  lang: string | null
  soft: boolean
  /** Text anchor relative to the dot centre, screen px at placement time. */
  dx: number
  dy: number
}

/**
 * Collect candidates (visible, non-faint Nodes whose centre is on screen), rank them (pinned selection / hover
 * neighbours > search match > open handoff > MAP rank > degree; filter misses last), place greedily with
 * labelPlacement and render. Identical visible labels are disambiguated and placed again.
 */
function runPlacement(e: Engine) {
  const t0 = performance.now()
  e.lastPlaceAt = t0
  const svgEl = e.svg.node()!
  const W = svgEl.clientWidth
  const H = svgEl.clientHeight
  if (!W || !H) return
  const t = e.transform
  const k = t.k
  const selNb = e.selected ? e.adj.get(e.selected) : undefined
  const cards = new Set([e.selected, e.hover].filter((x): x is string => !!x))

  // overlays are measured once and cached (the observers invalidate it); cards come from positionLabels' own math,
  // so a live (per-frame) pass does no DOM layout reads
  if (!e.overlayCache) e.overlayCache = overlayObstacles(svgEl)
  const obstacles = [...e.overlayCache]
  const HU = usableH(e)
  for (const el of e.labelsG.node()!.children as unknown as SVGGElement[]) {
    const x = Number(el.dataset.cx)
    const y = Number(el.dataset.cy)
    const w = Number(el.dataset.w) || 0
    const h = Number(el.dataset.h) || 0
    if (w > 0 && Number.isFinite(x) && Number.isFinite(y)) obstacles.push({ left: x - 2, top: y - 2, right: x + w + 2, bottom: y + h + 2 })
  }

  const fitK = fitScale(e, W, HU)
  const budget = labelBudget({ k, fitK, viewArea: W * H, maximise: e.maximise })
  // "hub-sized" is relative to the zoom: 7px at fit, growing as you zoom in — otherwise every dot becomes "hub-sized"
  // once zoomed in and blocks the very labels zooming in should reveal
  const hardDotRadius = 7 * Math.max(1, k / fitK)
  const dots: Dot[] = []
  const base: { n: SimNode; item: Omit<LabelItem, 'w' | 'h'>; soft: boolean }[] = []
  for (const n of e.nodes) {
    if (n.x === undefined || n.y === undefined) continue
    const vis = e.vis.get(n.id) ?? 'normal'
    if (vis === 'hidden') continue
    const tone = nodeTone({
      vis,
      selected: n.id === e.selected,
      hovered: n.id === e.hover,
      neighbour: !!selNb?.has(n.id),
      hoverLabelled: !!e.hoverLabelled?.has(n.id),
      lens: e.lens,
    })
    // far zoom: only the selection, its neighbours and search matches are drawn over the bubbles
    if (e.sz.level === 'far' && !(n.id === e.selected || n.id === e.hover || selNb?.has(n.id) || (e.emphasize && vis === 'normal'))) continue
    const [sx, sy] = t.apply([n.x, n.y])
    const r = n.r * k
    if (sx + r < 0 || sx - r > W || sy + r < 0 || sy - r > H) continue
    if (tone === 'faint') continue // background: no label, and covering it is fine
    dots.push({ id: n.id, x: sx, y: sy, r: cards.has(n.id) ? (n.r + 6) * k : r })
    if (cards.has(n.id)) continue // has its own card
    if (sx < 0 || sx > W || sy < 0 || sy > HU) continue // off screen or under the bottom sheet
    // pinned (selection / hover neighbours, top-10 budget) are placed first and claim space; then search matches,
    // open handoffs, MAP rank / degree; filter misses last
    // simple view: ≤ 13 nodes, label all of them (pinned: budget-exempt, may graze dots, still never overlap)
    const pinned = e.local || !!e.selLabelled?.has(n.id) || !!e.hoverLabelled?.has(n.id)
    const searchHit = e.emphasize && vis === 'normal'
    // selected / hovered have cards; then pinned neighbours > search matches > degree > id; filter misses last
    const tier = pinned ? 0 : searchHit ? 1 : tone === 'soft' || vis === 'dim' ? 4 : 3
    // mid zoom (and the crossfade): only each community's top nodes earn a landmark label — unless Aa asks for all
    if ((e.sz.level === 'mid' || e.sz.level === 'fade') && !e.maximise && !pinned && !searchHit && !e.commTop.has(n.id)) continue
    base.push({ n, soft: tone === 'soft', item: { id: n.id, x: sx, y: sy, r, tier, order: e.priority.get(n.id) ?? 1e6, pinned } })
  }

  const view = { left: VIEW_INSET, top: VIEW_INSET, right: W - VIEW_INSET, bottom: HU - VIEW_INSET }
  // read once per pass: getComputedStyle after DOM changes forces a style recalc
  if (!e.fontFamily) e.fontFamily = sansFamily()
  const family = e.fontFamily
  const place = (texts: ReadonlyMap<string, string>) => {
    const items: LabelItem[] = base.map(({ n, item }) => ({ ...item, ...measureLabel(e, texts.get(n.id) ?? n.label, family) }))
    const t1 = performance.now()
    // hub-sized dots and labelled dots are never covered; a label may graze up to 3 small dots (its paper halo keeps
    // them readable) — at fit zoom a dense interior would otherwise push every landmark to the periphery
    const res = placeLabels({ items, dots, obstacles, view, budget, previous: e.labelPrev, hardDotRadius, maxSoftDotHits: 3 })
    return { res, ms: performance.now() - t1 }
  }
  const texts = new Map<string, string>()
  let { res, ms } = place(texts)
  // identical visible labels → tell them apart and place again with the longer texts; a re-placement can surface
  // new twins, so repeat (bounded)
  for (let round = 0; round < 3; round++) {
    const shown = (id: string) => texts.get(id) ?? e.nodeById.get(id)!.label
    const count = new Map<string, number>()
    for (const p of res.placed) count.set(shown(p.id), (count.get(shown(p.id)) ?? 0) + 1)
    const dupItems = res.placed
      .filter((p) => (count.get(shown(p.id)) ?? 0) > 1)
      .map((p) => {
        const n = e.nodeById.get(p.id)!
        return { id: n.id, label: shown(n.id), text: n.text, date: n.date }
      })
    if (!dupItems.length) break
    for (const [id, t] of disambiguateLabels(dupItems)) texts.set(id, t)
    const again = place(texts)
    res = again.res
    ms += again.ms
  }

  const softIds = new Set(base.filter((b) => b.soft).map((b) => b.n.id))
  renderLandmarks(e, res.placed, texts, softIds)
  e.labelPrev = new Map(res.placed.map((p) => [p.id, p.side]))
  svgEl.dataset.labelCount = String(res.placed.length)
  svgEl.dataset.labelBudget = String(budget)
  svgEl.dataset.placeMs = ms.toFixed(2)
  svgEl.dataset.labelMs = (performance.now() - t0).toFixed(2)
}

function renderLandmarks(e: Engine, placed: PlacedLabel[], texts: ReadonlyMap<string, string>, softIds: ReadonlySet<string>) {
  const t = e.transform
  const data: LandmarkDatum[] = []
  for (const p of placed) {
    const n = e.nodeById.get(p.id)
    if (!n || n.x === undefined || n.y === undefined) continue
    const [sx, sy] = t.apply([n.x, n.y])
    const cjk = n.lang !== null
    const px = LABEL_FONT_PX
    const b = p.box
    const ax = p.side === 'right' ? b.left + LABEL_PAD : p.side === 'left' ? b.right - LABEL_PAD : (b.left + b.right) / 2
    // baseline so the glyphs sit centred in the box
    const ay = (b.top + b.bottom) / 2 + px * 0.36
    data.push({ id: p.id, text: texts.get(p.id) ?? n.label, side: p.side, box: b, cjk, lang: n.lang, soft: softIds.has(p.id), dx: ax - sx, dy: ay - sy })
  }
  e.landmarksG
    .selectAll<SVGTextElement, LandmarkDatum>('text')
    .data(data, (d) => d.id)
    .join('text')
    .attr('text-anchor', (d) => (d.side === 'right' ? 'start' : d.side === 'left' ? 'end' : 'middle'))
    .attr('lang', (d) => d.lang)
    .attr('data-id', (d) => d.id)
    .classed('cjk', (d) => d.cjk)
    .classed('soft', (d) => d.soft)
    .text((d) => d.text)
  positionLandmarks(e)
}

/** Keep placed labels glued to their dots (layout ticks, zoom/pan frames) without re-placing them. */
function positionLandmarks(e: Engine) {
  const k = e.transform.k
  const inv = 1 / k
  for (const el of e.landmarksG.node()!.children as unknown as SVGTextElement[]) {
    const d = (el as unknown as { __data__: LandmarkDatum }).__data__
    const n = e.nodeById.get(d.id)
    if (!n || n.x === undefined || n.y === undefined) continue
    el.setAttribute('transform', `translate(${(n.x + d.dx * inv).toFixed(2)},${(n.y + d.dy * inv).toFixed(2)}) scale(${inv.toFixed(4)})`)
  }
}

const LF_LINE = 13.5 // px between wrapped label lines (11px text)
const LF_PAD_X = 6
const LF_PAD_Y = 3.5

/**
 * The selected / hovered Node gets a wrapped label (≤ 2 lines) on a card-coloured backing, drawn in the top
 * layer. The group is counter-scaled by 1/k so text and backing keep a constant on-screen size.
 */
function syncFullLabels(e: Engine) {
  const ids: string[] = []
  if (e.selected) ids.push(e.selected)
  if (e.hover && e.hover !== e.selected) ids.push(e.hover)
  const byId = new Map(e.nodes.map((n) => [n.id, n]))
  const data = ids.map((id) => byId.get(id)).filter((n): n is SimNode => !!n)

  const groups = e.labelsG
    .selectAll<SVGGElement, SimNode>('g.lf')
    .data(data, (d) => d.id)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'lf')
      g.append('rect').attr('class', 'lf-bg').attr('rx', 4.5)
      g.append('text').attr('class', 'lf-text')
      return g
    })
  groups.classed('selected', (d) => d.id === e.selected).classed('hovered', (d) => d.id !== e.selected)
  groups.each(function (d) {
    const g = select(this)
    const text = g.select<SVGTextElement>('text.lf-text').attr('lang', d.lang)
    const lines = d.labelLines
    const sig = (d.id === e.selected ? 's' : 'h') + lines.join('\n')
    if (this.dataset.sig === sig) return
    this.dataset.sig = sig
    text.selectAll('tspan').remove()
    lines.forEach((line, i) => {
      text
        .append('tspan')
        .attr('x', 0)
        .attr('y', 4.2 + (i - (lines.length - 1) / 2) * LF_LINE)
        .text(line)
    })
    const b = text.node()!.getBBox()
    const box = { x: b.x - LF_PAD_X, y: b.y - LF_PAD_Y, w: b.width ? b.width + LF_PAD_X * 2 : 0, h: b.height ? b.height + LF_PAD_Y * 2 : 0 }
    g.select('rect.lf-bg').attr('x', box.x).attr('y', box.y).attr('width', box.w).attr('height', box.h)
    // card geometry in screen px (the group is counter-scaled), read back by positionLabels / ensureInView
    this.dataset.bx = String(box.x)
    this.dataset.by = String(box.y)
    this.dataset.w = String(box.w)
    this.dataset.h = String(box.h)
  })
  e.nodesG.selectAll<SVGGElement, SimNode>('g.fg-node').classed('has-lf', (d) => ids.includes(d.id))
  positionLabels(e)
}

const CARD_EDGE = 6 // px the card keeps from the canvas edges

/** Card to the right of the dot (just outside the selection ring); flipped left / clamped when it would overflow, and
 * kept off the canvas overlays (toolbars, legend, filter chip, sheet) whenever a clear spot exists. */
function positionLabels(e: Engine) {
  const t = e.transform
  const inv = 1 / t.k
  const svgEl = e.svg.node()!
  const W = svgEl.clientWidth
  const H = usableH(e) // the part of the canvas above the bottom sheet (narrow windows)
  // clamp into the inset, but decide "is the dot on screen" against the real canvas
  const view: Box = { left: CARD_EDGE, top: CARD_EDGE, right: W - CARD_EDGE, bottom: H - CARD_EDGE }
  const canvas: Box = { left: 0, top: 0, right: W, bottom: H }
  const cards = e.labelsG.node()!.children as unknown as SVGGElement[]
  // small graphs (the simple view): keep the card off neighbour dots so their labels can show too
  const dotBoxes =
    cards.length && e.nodes.length <= SMALL_GRAPH
      ? e.nodes
          .filter((n) => n.x !== undefined && n.y !== undefined && e.vis.get(n.id) !== 'hidden')
          .map((n) => {
            const [x, y] = t.apply([n.x!, n.y!])
            const r = n.r * t.k + 2
            return { id: n.id, box: { left: x - r, top: y - r, right: x + r, bottom: y + r } }
          })
      : []
  // overlays are hard: a card under the legend or a toolbar is unreadable (cached; the observers invalidate it)
  if (cards.length && !e.overlayCache) e.overlayCache = overlayObstacles(svgEl)
  const hard = (e.overlayCache ?? []).map((b) => ({ left: b.left - 3, top: b.top - 3, right: b.right + 3, bottom: b.bottom + 3 }))
  let selectedBlocked = false
  for (const el of cards) {
    const n = (el as unknown as { __data__: SimNode }).__data__
    if (n.x === undefined || n.y === undefined) continue
    const w = Number(el.dataset.w) || 0
    const h = Number(el.dataset.h) || 0
    const [sx, sy] = t.apply([n.x, n.y])
    const ring = (n.r + 6) * t.k
    const avoid = dotBoxes.filter((d) => d.id !== n.id).map((d) => d.box)
    const p = placeCardClear({ left: sx - ring, right: sx + ring, cy: sy }, { w, h }, view, canvas, 4, avoid, hard)
    if (n.id === e.selected && p.blocked) selectedBlocked = true
    // the group origin sits at the text origin; the card starts at (bx, by) inside it
    const [wx, wy] = t.invert([p.x - (Number(el.dataset.bx) || 0), p.y - (Number(el.dataset.by) || 0)])
    el.dataset.side = p.side
    el.dataset.cx = p.x.toFixed(1)
    el.dataset.cy = p.y.toFixed(1)
    el.setAttribute('transform', `translate(${wx.toFixed(2)},${wy.toFixed(2)}) scale(${inv.toFixed(4)})`)
  }
  e.cardBlocked = selectedBlocked
}

const OVERLAY_SELECTOR = '.canvas-tools.top-left > *, .canvas-tools.top-right, .legend'

/** The overlay elements that sit on top of the canvas (focus bar, zoom tools, legend, bottom sheet). */
function overlayElements(svgEl: SVGSVGElement): HTMLElement[] {
  const host = svgEl.closest('.canvas')
  const out = host ? [...host.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)] : []
  const sheet = sheetElement(svgEl)
  return sheet ? [...out, sheet] : out
}

/** Narrow windows: the detail panel is a bottom sheet laid over the canvas (null when it is a side column). */
function sheetElement(svgEl: SVGSVGElement): HTMLElement | null {
  return svgEl.closest('.graph-layout')?.querySelector<HTMLElement>(':scope > .panel.sheet') ?? null
}

/** svg-local y where the bottom sheet starts — the svg height when there is none. Read from layout (offsetTop), so
 * the sheet's slide-in transform never skews it. */
function usableHeight(svgEl: SVGSVGElement): number {
  const h = svgEl.clientHeight
  const sheet = sheetElement(svgEl)
  const layout = sheet?.offsetParent as HTMLElement | null | undefined
  if (!sheet || !layout) return h
  const top = sheet.offsetTop - (svgEl.getBoundingClientRect().top - layout.getBoundingClientRect().top)
  return Math.max(0, Math.min(h, top))
}

function usableH(e: Engine): number {
  if (e.usableH === null) e.usableH = usableHeight(e.svg.node()!)
  return e.usableH
}

/** Overlays that sit on top of the canvas (focus bar, zoom tools, open legend, bottom sheet), in svg-local px. */
function overlayObstacles(svgEl: SVGSVGElement): Box[] {
  const o = svgEl.getBoundingClientRect()
  const out: Box[] = []
  for (const el of overlayElements(svgEl)) {
    if (el.classList.contains('sheet')) continue // added below from layout geometry
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    out.push({ left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top })
  }
  const h = svgEl.clientHeight
  const u = usableHeight(svgEl)
  if (u < h) out.push({ left: 0, top: u, right: o.width, bottom: h })
  return out
}

/**
 * Pan (minimally) so the Node and its label card sit inside the canvas, clear of every overlay (focus bar, zoom
 * tools, open legend) measured from the DOM. Called on selection and after the canvas resizes (side panel).
 */
function ensureInView(e: Engine, svgEl: SVGSVGElement, id: string) {
  // a pan started mid-fit would interrupt the fit's transition (same transition name) and strand the view at its
  // starting transform — on a narrow canvas the simple view then stayed at the initial 0.9 zoom. Re-check once it lands.
  window.clearTimeout(e.inViewDefer)
  const wait = e.fitUntil - performance.now()
  if (wait > 0) {
    e.inViewDefer = window.setTimeout(() => ensureInView(e, svgEl, id), wait + 30)
    return
  }
  const n = e.nodes.find((x) => x.id === id)
  if (!n || n.x === undefined || n.y === undefined) return
  const w = svgEl.clientWidth
  const h = svgEl.clientHeight
  if (!w || !h) return
  const k = e.transform.k
  const [px, py] = e.transform.apply([n.x, n.y])
  const card = e.labelsG.select<SVGGElement>('g.lf.selected').node()
  const labelW = card ? Number(card.dataset.w) || 0 : displayWidth(n.label) * 6.6 + 12
  const labelH = card ? Number(card.dataset.h) || 0 : 18
  const ring = (n.r + 6) * k
  // dot + card on its preferred (right) side; once clear, positionLabels keeps it there
  const box: Box = {
    left: px - ring - 4,
    right: px + ring + 4 + labelW + 4,
    top: py - Math.max(ring, labelH / 2) - 4,
    bottom: py + Math.max(ring, labelH / 2) + 4,
  }
  const view: Box = { left: 8, top: 8, right: w - 8, bottom: usableHeight(svgEl) - 8 }
  // already fine: the dot is in view and clear of the overlays, and its card found a clear spot (on either side)
  const obstacles = overlayObstacles(svgEl)
  const ringClear = obstacles.every((o) => o.left >= px + ring || o.right <= px - ring || o.top >= py + ring || o.bottom <= py - ring)
  if (card && !e.cardBlocked && ringClear && px - ring >= view.left && px + ring <= view.right && py - ring >= view.top && py + ring <= view.bottom) {
    const cx = Number(card.dataset.cx)
    const cy = Number(card.dataset.cy)
    if (Number.isFinite(cx) && cx >= view.left - 2 && cx + labelW <= view.right + 2 && cy >= view.top - 2 && cy + labelH <= view.bottom + 2) return
  }
  const { dx, dy } = planPan(box, view, obstacles)
  // no clear spot even after panning (e.g. legend + chip + sheet on a small canvas): ask the host to free space
  const settleCheck = () => {
    positionLabels(e)
    if (e.cardBlocked) e.onCardBlocked()
  }
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    settleCheck()
    return
  }
  e.svg
    .transition()
    .duration(450)
    .call(e.zoomer.translateBy, dx / k, dy / k)
  window.clearTimeout(e.inViewDefer)
  e.inViewDefer = window.setTimeout(settleCheck, 480)
}

function ticked(e: Engine) {
  for (const el of e.linksG.node()!.children as unknown as SVGLineElement[]) {
    const l = (el as unknown as { __data__: SimLink }).__data__
    const s = l.source as SimNode
    const t = l.target as SimNode
    if (s.x === undefined || t.x === undefined) continue
    const seg = l.directed
      ? trimSegment(s.x, s.y!, t.x, t.y!, s.r + 1, t.r + 3)
      : { x1: s.x, y1: s.y!, x2: t.x, y2: t.y! }
    el.setAttribute('x1', seg.x1.toFixed(1))
    el.setAttribute('y1', seg.y1.toFixed(1))
    el.setAttribute('x2', seg.x2.toFixed(1))
    el.setAttribute('y2', seg.y2.toFixed(1))
  }
  for (const el of e.nodesG.node()!.children as unknown as SVGGElement[]) {
    const n = (el as unknown as { __data__: SimNode }).__data__
    if (n.x === undefined) continue
    el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y!.toFixed(1)})`)
  }
  if (e.labelsG.node()!.childElementCount) positionLabels(e)
  if (e.landmarksG.node()!.childElementCount) positionLandmarks(e)
  if (e.sz.bubbles > 0.01) {
    positionBubbles(e)
    layoutBubbleLabels(e)
  }
  // while the layout is still moving, labels that follow their dots can drift into each other: re-place now and
  // then (the settle hook does the final pass)
  if (!e.zooming && e.sim.alpha() > e.sim.alphaMin() && performance.now() - e.lastPlaceAt > PLACE_WHILE_MOVING_MS) runPlacement(e)
}

function joinLinks(e: Engine) {
  e.linksG
    .selectAll<SVGLineElement, SimLink>('line')
    .data(e.links, (d) => d.key)
    .join((enter) => enter.append('line').attr('class', 'fg-link'))
    .attr('data-type', (d) => d.type)
    .attr('stroke', (d) => EDGE_STYLES[d.type].color)
    .attr('stroke-width', (d) => d.width)
    .attr('stroke-dasharray', (d) => EDGE_STYLES[d.type].dash)
    .style('--o', (d) => String(d.opacity))
    .style('--w', (d) => `${d.width.toFixed(2)}px`)
    .classed('untraversed', (d) => d.data.accessCount === 0)
    .attr('marker-end', (d) => (d.directed ? `url(#arrow-${d.type})` : null))
    .classed('half', (d) => d.data.halves === 1 && !d.directed)
}

function joinNodes(e: Engine, svgEl: SVGSVGElement, propsRef: React.RefObject<Props>) {
  const sel = e.nodesG
    .selectAll<SVGGElement, SimNode>('g.fg-node')
    .data(e.nodes, (d) => d.id)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'fg-node')
      g.append('circle').attr('class', 'halo')
      g.append('circle').attr('class', 'dot')
      g.classed('entering', true)
      setTimeout(() => g.classed('entering', false), 30)
      return g
    })

  sel
    .attr('data-id', (d) => d.id)
    .classed('superseded', (d) => d.data.superseded)
    .classed('handoff', (d) => d.data.openHandoff)
  sel
    .select<SVGCircleElement>('circle.dot')
    .attr('r', (d) => d.r)
    .attr('fill', (d) => d.color)
  sel.select<SVGCircleElement>('circle.halo').attr('r', (d) => d.r + 6)

  sel.on('click', (ev: MouseEvent, d) => {
    ev.stopPropagation()
    // the canvas is about to resize (side panel) — a tooltip placed for the old size would be clipped
    e.tooltip.hidden = true
    propsRef.current!.onSelect(d.id)
  })
  sel
    .on('mouseenter', (ev: MouseEvent, d) => {
      e.hover = d.id
      applyHover(e)
      showTip(e, svgEl, ev, d)
    })
    .on('mousemove', (ev: MouseEvent, d) => showTip(e, svgEl, ev, d))
    .on('mouseleave', () => {
      e.hover = null
      applyHover(e)
      e.tooltip.hidden = true
    })

  sel.call(
    drag<SVGGElement, SimNode>()
      .clickDistance(4)
      .on('start', (ev: { active: number; subject: SimNode }) => {
        const d = ev.subject
        d.fx = d.x
        d.fy = d.y
        e.dragging = true
      })
      .on('drag', (ev: { active: number; subject: SimNode; x: number; y: number }) => {
        const d = ev.subject
        if (!ev.active && e.sim.alpha() < 0.1) {
          if (e.loop !== null) cancelAnimationFrame(e.loop)
          e.loop = null
          e.sim.alphaTarget(0.25).restart()
        }
        d.fx = ev.x
        d.fy = ev.y
        e.tooltip.hidden = true
      })
      .on('end', (ev: { subject: SimNode }) => {
        e.sim.alphaTarget(0)
        e.dragging = false
        ev.subject.fx = null
        ev.subject.fy = null
      }),
  )
}

function showTip(e: Engine, svgEl: SVGSVGElement, ev: MouseEvent, d: SimNode) {
  const tip = e.tooltip
  const box = svgEl.getBoundingClientRect()
  const n = d.data
  tip.replaceChildren()
  const title = document.createElement('div')
  title.className = 'fg-tip-title'
  title.textContent = n.description || n.id
  const meta = document.createElement('div')
  meta.className = 'fg-tip-meta'
  const bits = [tr(`type.${d.typeKey}` as MsgKey), trn('tip.links', n.degree), trn('tip.visits', n.visitCount)]
  if (n.superseded) bits.push(tr('tip.superseded'))
  if (n.openHandoff) bits.push(tr('tip.handoff'))
  if (n.updated) bits.push(tr('tip.updated', { date: n.updated }))
  else if (n.created) bits.push(tr('tip.created', { date: n.created }))
  meta.textContent = bits.join(' · ')
  tip.append(title, meta)
  tip.hidden = false
  const x = ev.clientX - box.left + 14
  // drop below the hovered Node's two-line label card instead of covering it
  const y = ev.clientY - box.top + 30
  const maxX = box.width - tip.offsetWidth - 8
  tip.style.transform = `translate(${Math.min(x, maxX)}px, ${Math.min(y, box.height - tip.offsetHeight - 8)}px)`
}

function applyHover(e: Engine) {
  const h = e.hover
  const nb = h ? e.adj.get(h) : undefined
  const labelled = nb ? topByPriority(nb, e.priority, NEIGHBOUR_LABEL_BUDGET, (id) => e.vis.get(id) === 'dim') : null
  e.hoverLabelled = labelled
  e.nodesG
    .selectAll<SVGGElement, SimNode>('g.fg-node')
    .classed('hover', (d) => d.id === h)
    .classed('hover-nb', (d) => !!nb?.has(d.id))
    .classed('hover-nb-label', (d) => !!labelled?.has(d.id))
  e.linksG
    .selectAll<SVGLineElement, SimLink>('line')
    .classed('hover', (d) => !!h && ((d.source as SimNode).id === h || (d.target as SimNode).id === h))
  applyTones(e)
  syncFullLabels(e)
  schedulePlacement(e, 0)
}

/** Resolve each Node's tone (full / soft / faint / hidden) from filter visibility, selection, lens and hover. */
function applyTones(e: Engine) {
  const nb = e.selected ? e.adj.get(e.selected) : undefined
  e.nodesG.selectAll<SVGGElement, SimNode>('g.fg-node').each(function (d) {
    const tone = nodeTone({
      vis: e.vis.get(d.id) ?? 'normal',
      selected: d.id === e.selected,
      hovered: d.id === e.hover,
      neighbour: !!nb?.has(d.id),
      hoverLabelled: !!e.hoverLabelled?.has(d.id),
      lens: e.lens,
    })
    const cl = this.classList
    cl.toggle('tone-soft', tone === 'soft')
    cl.toggle('tone-faint', tone === 'faint')
  })
}

function applyClasses(e: Engine, p: Props) {
  const sel = p.selectedId
  const nb = sel ? e.adj.get(sel) : undefined
  const vis = p.visibility
  const svgEl = e.svg.node()!
  svgEl.classList.toggle('labels-always', p.labelsAlways)
  svgEl.classList.toggle('has-selection', !!sel)
  svgEl.classList.toggle('lens', !!sel && p.lens)
  e.selected = sel
  e.vis = vis
  let anyHidden = false
  for (const v of vis.values()) if (v === 'hidden') anyHidden = true
  e.anyHidden = anyHidden
  e.lens = !!sel && p.lens
  e.maximise = p.labelsAlways
  e.emphasize = p.emphasize
  // a hub's neighbours are labelled by importance, not all at once; filter misses only fill leftover slots
  const labelled = nb ? topByPriority(nb, e.priority, e.local ? Infinity : NEIGHBOUR_LABEL_BUDGET, (id) => vis.get(id) === 'dim') : null
  e.selLabelled = labelled
  const nodeSel = e.nodesG.selectAll<SVGGElement, SimNode>('g.fg-node')
  // draw the selection and its neighbours above everything else so their labels stay legible
  if (sel) {
    nodeSel.filter((d) => !!nb?.has(d.id)).raise()
    nodeSel.filter((d) => d.id === sel).raise()
  }
  nodeSel
    .classed('selected', (d) => d.id === sel)
    .classed('nb', (d) => !!nb?.has(d.id))
    .classed('nb-label', (d) => !!labelled?.has(d.id))
    .classed('v-dim', (d) => vis.get(d.id) === 'dim')
    .classed('v-hidden', (d) => vis.get(d.id) === 'hidden')
    .classed('emph', (d) => p.emphasize && (vis.get(d.id) ?? 'normal') === 'normal')
    // drawn over the bubbles at far zoom
    .classed('sz-keep', (d) => d.id === sel || !!nb?.has(d.id) || (p.emphasize && (vis.get(d.id) ?? 'normal') === 'normal'))
  e.linksG
    .selectAll<SVGLineElement, SimLink>('line')
    .each(function (d) {
      const s = (d.source as SimNode).id ?? (d.source as string)
      const t = (d.target as SimNode).id ?? (d.target as string)
      const v = linkVisibility(vis, s, t)
      const incident = !!sel && (s === sel || t === sel)
      this.classList.toggle('v-dim', v === 'dim')
      this.classList.toggle('v-hidden', v === 'hidden')
      this.classList.toggle('incident', incident)
      if (d.directed) this.setAttribute('marker-end', `url(#arrow-${d.type}${incident ? '-hl' : ''})`)
    })
  applyTones(e)
  syncFullLabels(e)
  updateBubbleCounts(e)
  updateZoomClasses(e) // hop focus switches semantic zoom off / on
  schedulePlacement(e, 0)
}

/**
 * Simple view: the largest scale at which every node still has room for its (constant screen size) label on its
 * outer side — the plain fit only counts dots, so on a narrow canvas the outer labels had nowhere to go and were culled.
 */
function localFitScale(e: Engine, pts: readonly SimNode[], cx: number, cy: number, w: number, h: number): number {
  if (!e.fontFamily) e.fontFamily = sansFamily()
  const card = e.labelsG.select<SVGGElement>('g.lf.selected').node()
  const padX = 12
  const padY = 64 // the mode switch / focus note above, the zoom tools below
  let k = Infinity
  for (const n of pts) {
    const lw = (n.id === e.selected && card ? Number(card.dataset.w) || 0 : measureLabel(e, n.label, e.fontFamily).w) + 8
    const dx = Math.abs(n.x! - cx)
    const room = w / 2 - padX - lw
    if (room > 0 && dx + n.r > 0) k = Math.min(k, room / (dx + n.r))
    const dy = Math.abs(n.y! - cy) + n.r
    if (dy > 0) k = Math.min(k, (h / 2 - padY) / dy)
  }
  return Number.isFinite(k) ? k : e.transform.k
}

/**
 * Semantic zoom only: animate to the selected node and its 1-hop neighbours, at least at the mid level (labels, not
 * bubbles); never zooms out — already closer, it just pans to the node (communities.focusTarget). Returns false when
 * semantic zoom is not active here (the caller then refits as before).
 */
function focusSelection(e: Engine, svgEl: SVGSVGElement, id: string, duration: number): boolean {
  if (!e.comm || !semanticEnabled({ nodeCount: e.nodes.length, communityCount: e.comm.communities.length, local: e.local, anyHidden: e.anyHidden }))
    return false
  const n = e.nodeById.get(id)
  if (!n || n.x === undefined || n.y === undefined) return false
  const w = svgEl.clientWidth
  const h = usableHeight(svgEl)
  if (!w || !h) return false
  let x0 = n.x - n.r
  let y0 = n.y - n.r
  let x1 = n.x + n.r
  let y1 = n.y + n.r
  for (const nb of e.adj.get(id) ?? []) {
    const m = e.nodeById.get(nb)
    if (!m || m.x === undefined || m.y === undefined || e.vis.get(nb) === 'hidden') continue
    x0 = Math.min(x0, m.x - m.r)
    y0 = Math.min(y0, m.y - m.r)
    x1 = Math.max(x1, m.x + m.r)
    y1 = Math.max(y1, m.y + m.r)
  }
  const fitK = e.szFitK || fitScale(e, w, h)
  const f = focusTarget({ node: { x: n.x, y: n.y }, bbox: { x0, y0, x1, y1 }, w, h, pad: 90, currentK: e.transform.k, minK: fitK * SZ_FADE_END * 1.05 })
  const t = zoomIdentity.translate(w / 2, h / 2).scale(f.k).translate(-f.cx, -f.cy)
  e.lastFitAt = performance.now()
  e.lastFitKind = 'focus'
  e.fitUntil = performance.now() + duration
  window.clearTimeout(e.fitEndTimer)
  e.fitEndTimer = window.setTimeout(() => e.onFitEnd(), duration + 40)
  e.svg.node()!.dataset.focus = f.panOnly ? 'pan' : 'zoom'
  e.svg.transition().duration(duration).call(e.zoomer.transform, t)
  return true
}

function fitVisible(e: Engine, svgEl: SVGSVGElement, vis: ReadonlyMap<string, Visibility>, duration: number) {
  e.lastFitAt = performance.now()
  e.lastFitKind = 'all'
  e.svg.node()!.dataset.focus = 'all'
  const pts = e.nodes.filter((n) => n.x !== undefined && vis.get(n.id) !== 'hidden')
  if (!pts.length) return
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of pts) {
    x0 = Math.min(x0, n.x! - n.r)
    y0 = Math.min(y0, n.y! - n.r)
    x1 = Math.max(x1, n.x! + n.r)
    y1 = Math.max(y1, n.y! + n.r)
  }
  const w = svgEl.clientWidth
  const h = usableHeight(svgEl) // fit above the bottom sheet (narrow windows)
  if (!w || !h) return
  const pad = 70
  let k = Math.min(1.6, Math.max(0.06, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))))
  if (e.local) k = Math.min(k, Math.max(0.4, localFitScale(e, pts, (x0 + x1) / 2, (y0 + y1) / 2, w, h)))
  else if (!e.anyHidden) e.szFitK = k
  const t = zoomIdentity
    .translate(w / 2, h / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2)
  e.fitUntil = performance.now() + duration
  e.fitW = w
  e.fitH = svgEl.clientHeight
  window.clearTimeout(e.fitEndTimer)
  e.fitEndTimer = window.setTimeout(() => e.onFitEnd(), duration + 40)
  e.svg.transition().duration(duration).call(e.zoomer.transform, t)
}
