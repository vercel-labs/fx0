export const PREVIEW_PROTOCOL = 1
export const PREVIEW_PREPARE_MS = 10_000
// The Google Fonts CSS fx0 may embed in a rendered design (lib/google-fonts.ts), and so
// the longest rendered design a preview accepts: twice the 512 KiB source, plus fonts.
export const MAX_EMBEDDED_FONT_CSS_LENGTH = 768 * 1024
export const MAX_RENDER_HTML_LENGTH = 1024 * 1024 + MAX_EMBEDDED_FONT_CSS_LENGTH

// The HTTP status a failed preview frame reports (app/api/artifact-frame/route.ts).
export function isPreviewErrorStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
}

export interface PreviewPayload {
  protocol: 1
  sessionId: string
  revision: number
  sourceHtml: string
  renderHtml: string
  images: { marker: string; src: string }[]
}

export interface PreviewSeed {
  sessionId: string
  revision: number
  sourceHtml: string
  renderHtml: string
  documentId: string
  parentOrigin: string
  token: string
}

// Serialized into the opaque child with .toString(); all runtime dependencies stay inside.
export function previewUpdateRuntime(seed: PreviewSeed): void {
  const htmlNamespace = 'http://www.w3.org/1999/xhtml'
  const sourceLimit = 512 * 1024
  const renderLimit = 8 * 1024 * 1024
  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'li', 'button', 'a', 'label'])
  type Snapshot = {
    source: Document
    render: Document
    authored: Map<Element, Element>
    ids: Map<string, Element | null>
  }
  type Change = { kind: 'css' | 'style' | 'text'; before: Element; after: Element }
  let baseline: Snapshot | undefined
  let bindings = new Map<Element, Element>()
  const sheets = new Map<Element, { sheet: CSSStyleSheet | null; domText: string | null; renderText: string | null }>()
  let revision = seed.revision
  let initialized = false
  let failed = false
  let busy = false
  let lastRequestId = ''

  function reject(reason: string): never { throw new Error(reason) }
  function sameElement(a: Element, b: Element): boolean {
    return a.namespaceURI === b.namespaceURI && a.localName === b.localName && a.id === b.id
  }
  function sameAttributes(a: Element, b: Element): boolean {
    return a.attributes.length === b.attributes.length && [...a.attributes].every(attribute => {
      const other = b.getAttributeNodeNS(attribute.namespaceURI, attribute.localName)
      return other?.name === attribute.name && other.value === attribute.value
    })
  }
  function children(node: Node): Node[] {
    // Template contents must also be compared, but can never be live patch targets.
    return [...(node instanceof HTMLTemplateElement ? node.content : node).childNodes]
  }
  function sameType(a: Node, b: Node): void {
    if (a.nodeType !== b.nodeType) reject('tree-shape-changed')
    if (a.nodeType === 1 && !sameElement(a as Element, b as Element)) reject('element-identity-changed')
    if (a.nodeType === 10) {
      const left = a as DocumentType, right = b as DocumentType
      if (left.name !== right.name || left.publicId !== right.publicId || left.systemId !== right.systemId) reject('doctype-changed')
    }
  }
  function isStyle(element: Element): element is HTMLStyleElement {
    return element.namespaceURI === htmlNamespace && element.localName === 'style'
  }
  function textOnly(element: Element): boolean {
    return [...element.childNodes].every(node => node.nodeType === 3)
  }
  function bounded(source: unknown, render: unknown): source is string {
    return typeof source === 'string' && source.length <= sourceLimit &&
      typeof render === 'string' && render.length <= renderLimit &&
      new TextEncoder().encode(source).byteLength <= sourceLimit
  }
  function snapshot(source: string, render: string): Snapshot {
    const parser = new DOMParser()
    const result: Snapshot = {
      source: parser.parseFromString(source, 'text/html'),
      render: parser.parseFromString(render, 'text/html'),
      authored: new Map(), ids: new Map(),
    }
    if (result.source.doctype?.name !== 'html' || result.render.doctype?.name !== 'html') reject('missing-doctype')
    function pair(a: Node, b: Node): void {
      sameType(a, b)
      if (a.nodeType === 1) {
        const authored = a as Element, rendered = b as Element
        result.authored.set(rendered, authored)
        if (authored.id) result.ids.set(authored.id, result.ids.has(authored.id) ? null : authored)
        // Embedding CSS images may change raw style text, including an empty style.
        if (isStyle(authored) && textOnly(authored) && textOnly(rendered)) return
      }
      const left = children(a), right = children(b)
      if (left.length !== right.length) reject('source-render-shape-mismatch')
      left.forEach((node, index) => pair(node, right[index]))
    }
    pair(result.source, result.render)
    return result
  }
  function editable(element: Element): boolean {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const value = current.getAttribute('contenteditable')?.toLowerCase()
      if (value === 'false') return false
      if (value === '' || value === 'true' || value === 'plaintext-only') return true
    }
    return false
  }
  function standard(element: Element): boolean {
    return element.namespaceURI === htmlNamespace && element instanceof HTMLElement && !(element instanceof HTMLUnknownElement) &&
      !element.localName.includes('-') && !element.hasAttribute('is')
  }
  function identified(element: Element, state: Snapshot, rendered: boolean): boolean {
    const authored = rendered ? state.authored.get(element) : element
    return !!authored?.id && state.ids.get(authored.id) === authored && standard(authored) &&
      standard(element) && !editable(authored) && !editable(element)
  }
  function compare(previous: Snapshot, next: Snapshot, rendered: boolean, changes: Change[], successors: Map<Element, Element>): void {
    function walk(a: Node, b: Node, inert: boolean): void {
      sameType(a, b)
      if (a.nodeType === 1) {
        const before = a as Element, after = b as Element
        if (rendered) successors.set(before, after)
        const locked = inert || before.localName === 'script'
        let styleChanged = false
        for (const attribute of [...before.attributes, ...after.attributes]) {
          const left = before.getAttributeNodeNS(attribute.namespaceURI, attribute.localName)
          const right = after.getAttributeNodeNS(attribute.namespaceURI, attribute.localName)
          if (left?.name === right?.name && left?.value === right?.value) continue
          if (locked || attribute.namespaceURI !== null || attribute.name !== 'style' ||
            !identified(before, previous, rendered) || !identified(after, next, rendered)) reject('unsupported-attribute-change')
          styleChanged = true
        }
        if (rendered && styleChanged) changes.push({ kind: 'style', before, after })
        if (!locked && isStyle(before) && textOnly(before) && textOnly(after)) {
          if (before.textContent !== after.textContent && rendered) changes.push({ kind: 'css', before, after })
          return
        }
        if (!locked && before.childNodes.length === 1 && after.childNodes.length === 1 &&
          before.firstChild!.nodeType === 3 && after.firstChild!.nodeType === 3 && before.textContent !== after.textContent) {
          if (!textTags.has(before.localName) || !identified(before, previous, rendered) || !identified(after, next, rendered)) reject('unsupported-text-change')
          if (rendered) changes.push({ kind: 'text', before, after })
          return
        }
        inert = inert || before.localName === 'template'
      } else if (a.nodeValue !== b.nodeValue) reject('unsupported-content-change')
      const left = children(a), right = children(b)
      if (left.length !== right.length) reject('tree-shape-changed')
      left.forEach((node, index) => walk(node, right[index], inert))
    }
    walk(rendered ? previous.render : previous.source, rendered ? next.render : next.source, false)
  }
  function liveIds(): Map<string, Element | null> {
    const ids = new Map<string, Element | null>()
    for (const element of document.querySelectorAll('[id]')) {
      if (element.id) ids.set(element.id, ids.has(element.id) ? null : element)
    }
    return ids
  }
  function styleText(element: HTMLStyleElement): string | null {
    const tracked = sheets.get(element)
    // CSSOM edits leave the physical text alone. Project only our own unchanged
    // bindings; an authored DOM edit or a newly inserted style still speaks for itself.
    return tracked && element.sheet === tracked.sheet && element.textContent === tracked.domText ? tracked.renderText : element.textContent
  }
  function locate(element: Element, state: Snapshot, ids: Map<string, Element | null>): Element | null {
    const authored = state.authored.get(element)!
    if (authored.id) {
      if (state.ids.get(authored.id) !== authored) return null
      const live = ids.get(authored.id)
      return live && sameElement(element, live) ? live : null
    }
    if (!isStyle(element)) return null
    const expected = [...state.authored.keys()].filter(candidate => isStyle(candidate) &&
      candidate.textContent === element.textContent && sameAttributes(candidate, element))
    const matches = [...document.querySelectorAll('style')].filter(candidate => isStyle(candidate) &&
      styleText(candidate) === element.textContent && sameAttributes(candidate, element))
    return expected.length === 1 && matches.length === 1 ? matches[0] : null
  }
  function rules(sheet: CSSStyleSheet): string {
    return JSON.stringify([...sheet.cssRules].map(rule => rule.cssText))
  }
  function parseSheet(expected: Element): CSSStyleSheet {
    // An inactive document parses ordinary sheet rules without touching the live tree.
    // Unlike constructed replaceSync(), it does not silently discard @import rules.
    const scratch = document.implementation.createHTMLDocument('')
    const style = scratch.createElement('style')
    style.media = expected.getAttribute('media') ?? ''
    style.textContent = expected.textContent
    scratch.head.append(style)
    const sheet = style.sheet
    if (!sheet || [...sheet.cssRules].some(rule => rule.type === CSSRule.IMPORT_RULE)) reject('unsupported-stylesheet-rules')
    return sheet
  }
  function checkSheet(live: HTMLStyleElement, expected: Element, canonical: CSSStyleSheet): CSSStyleSheet {
    const sheet = live.sheet, tracked = sheets.get(live)
    if (!sheet || tracked?.sheet !== sheet) reject('stylesheet-replaced')
    if (live.textContent !== tracked.domText || tracked.renderText !== expected.textContent) reject('stylesheet-text-conflict')
    for (const name of ['media', 'type', 'title']) {
      if (live.getAttribute(name) !== expected.getAttribute(name)) reject('stylesheet-state-conflict')
    }
    if (sheet.ownerNode !== live || sheet.disabled || sheet.href !== null || sheet.ownerRule !== null ||
      sheet.parentStyleSheet !== null || sheet.media.mediaText !== canonical.media.mediaText || rules(sheet) !== rules(canonical)) reject('stylesheet-cssom-conflict')
    return sheet
  }
  function preflight(changes: Change[], state: Snapshot): (() => void)[] {
    const ids = liveIds()
    return changes.map(change => {
      const { before, after, kind } = change
      const live = locate(before, state, ids)
      if (!live || !live.isConnected || bindings.get(before) !== live) reject('target-missing-or-replaced')
      if (kind === 'css') {
        if (!isStyle(live)) reject('stylesheet-target-mismatch')
        const scratch = parseSheet(before), next = parseSheet(after), sheet = checkSheet(live, before, scratch)
        const previousRules = [...scratch.cssRules].map(rule => rule.cssText), nextRules = [...next.cssRules].map(rule => rule.cssText)
        const splices: { start: number; deleteCount: number; rules: string[] }[] = []
        // Canonical no-ops retain every rule, even when identical rules are repeated.
        if (previousRules.length !== nextRules.length || previousRules.some((text, index) => text !== nextRules[index])) {
          const positions = new Map<string, number | null>()
          previousRules.forEach((text, index) => positions.set(text, positions.has(text) ? null : index))
          let previousStart = 0, nextStart = 0
          // The trailing boundary closes the last gap without replacing any shared anchor.
          for (let index = 0; index <= nextRules.length; index++) {
            const previousIndex = index === nextRules.length ? previousRules.length : positions.get(nextRules[index])
            if (previousIndex === undefined) continue
            if (previousIndex === null || previousIndex < previousStart) reject('ambiguous-or-reordered-stylesheet-rules')
            if (previousIndex > previousStart || index > nextStart) {
              for (let removed = previousStart; removed < previousIndex; removed++) {
                const rule = scratch.cssRules[removed] as CSSRule & { cssRules?: CSSRuleList }
                // Replacing a parent would detach cached, possibly unchanged descendants.
                if (rule.cssRules?.length) reject('unsupported-stylesheet-change')
              }
              splices.push({ start: previousStart, deleteCount: previousIndex - previousStart, rules: nextRules.slice(nextStart, index) })
            }
            previousStart = previousIndex + 1
            nextStart = index + 1
          }
        }
        const splice = (target: CSSStyleSheet) => {
          // Right-to-left edits leave every earlier splice's original indices valid.
          for (let index = splices.length - 1; index >= 0; index--) {
            const edit = splices[index]
            for (let offset = edit.deleteCount - 1; offset >= 0; offset--) target.deleteRule(edit.start + offset)
            for (let offset = 0; offset < edit.rules.length; offset++) target.insertRule(edit.rules[offset], edit.start + offset)
          }
        }
        // Dry-run the complete plan before any operation writes to the live document.
        // Valid CSS can still violate insertRule's ordering/namespace constraints.
        splice(scratch)
        if (rules(scratch) !== rules(next)) reject('unsupported-stylesheet-change')
        return () => {
          // Retain the sheet and all shared unchanged rules that authored code may cache.
          splice(sheet)
          sheets.get(live)!.renderText = after.textContent
          checkSheet(live, after, next)
        }
      }
      if (!standard(live) || editable(live) || (live as HTMLElement).isContentEditable || document.designMode === 'on') reject('editable-or-custom-target')
      if (kind === 'style') {
        if (live.getAttribute('style') !== before.getAttribute('style')) reject('inline-style-conflict')
        const value = after.getAttribute('style')
        return () => { if (value === null) live.removeAttribute('style'); else live.setAttribute('style', value) }
      }
      if (live.childNodes.length !== 1 || live.firstChild!.nodeType !== 3 || live.firstChild!.nodeValue !== before.firstChild!.nodeValue) reject('leaf-text-conflict')
      const text = live.firstChild!
      return () => { text.nodeValue = after.firstChild!.nodeValue }
    })
  }
  function result(requestId: string, status: 'applied' | 'reload', appliedRevision: number, reason?: string): void {
    parent.postMessage({ type: 'fx0-preview-result', protocol: 1, token: seed.token, documentId: seed.documentId,
      requestId, status, revision: appliedRevision, ...(reason ? { reason } : {}) }, seed.parentOrigin)
  }

  // This runs before authored scripts. Never reconstruct either baseline from the live DOM.
  try {
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof seed.sessionId !== 'string' || !seed.sessionId ||
      typeof seed.documentId !== 'string' || !seed.documentId || typeof seed.token !== 'string' || !seed.token ||
      typeof seed.parentOrigin !== 'string' || !seed.parentOrigin || seed.parentOrigin === '*' || seed.parentOrigin === 'null' ||
      !bounded(seed.sourceHtml, seed.renderHtml)) reject('invalid-seed')
    baseline = snapshot(seed.sourceHtml, seed.renderHtml)
  } catch { failed = true }

  function loaded(): void {
    try {
      if (!baseline || failed) reject('baseline-unavailable')
      const ids = liveIds()
      for (const element of baseline.authored.keys()) {
        const live = locate(element, baseline, ids)
        if (live) {
          bindings.set(element, live)
          if (isStyle(live)) sheets.set(live, { sheet: live.sheet, domText: element.textContent, renderText: element.textContent })
        }
      }
      initialized = true
    } catch { failed = true }
    parent.postMessage({ type: 'fx0-preview-ready', protocol: 1, token: seed.token, documentId: seed.documentId,
      revision: seed.revision, ready: initialized && !failed }, seed.parentOrigin)
  }
  if (document.readyState === 'complete') loaded()
  else addEventListener('load', loaded, { once: true })

  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== seed.parentOrigin) return
    const data = event.data
    const keys = ['type', 'protocol', 'token', 'documentId', 'requestId', 'baseRevision', 'revision', 'sourceHtml', 'renderHtml']
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== keys.length ||
      !Object.keys(data).every(key => keys.includes(key)) || data.type !== 'fx0-preview-apply' || data.protocol !== 1 ||
      data.token !== seed.token || data.documentId !== seed.documentId || typeof data.requestId !== 'string' ||
      !data.requestId.length || data.requestId.length > 128 || !Number.isSafeInteger(data.baseRevision) || data.baseRevision < 0 ||
      !Number.isSafeInteger(data.revision) || data.revision <= data.baseRevision || !bounded(data.sourceHtml, data.renderHtml)) return
    const requestId: string = data.requestId, requestedRevision: number = data.revision
    if (busy) { result(requestId, 'reload', revision, 'update-busy'); return }
    if (requestId === lastRequestId) { result(requestId, 'reload', revision, 'duplicate-request'); return }
    if (data.baseRevision !== revision) { result(requestId, 'reload', revision, 'stale-base-revision'); return }
    if (!initialized || failed || !baseline) { result(requestId, 'reload', revision, 'baseline-unavailable'); return }
    busy = true
    lastRequestId = requestId
    try {
      const next = snapshot(data.sourceHtml, data.renderHtml)
      const changes: Change[] = [], successors = new Map<Element, Element>()
      compare(baseline, next, false, changes, successors)
      // Even an authored no-op must account for every fully embedded render difference.
      compare(baseline, next, true, changes, successors)
      const operations = preflight(changes, baseline)
      const nextBindings = new Map<Element, Element>()
      for (const [before, after] of successors) {
        const live = bindings.get(before)
        if (live) nextBindings.set(after, live)
      }
      for (const apply of operations) apply()
      baseline = next
      bindings = nextBindings
      revision = requestedRevision
      // Capture this request's revision; a later message must not change its ACK.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        result(requestId, 'applied', requestedRevision)
        busy = false
      }))
    } catch (error) {
      // A partial write cannot safely be rolled back in the presence of authored code.
      failed = true
      busy = false
      result(requestId, 'reload', revision, error instanceof Error ? error.message : 'update-exception')
    }
  })
}
