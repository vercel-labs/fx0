import type { FxHostTool, FxToolResult } from 'libfx'
// @ts-expect-error Node strip-types tests require the source extension.
import { fetchPublicText } from './public-fetch.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { CAPTURE_WIDTH, captureWidth } from './capture-protocol.ts'

const MAX_TOOL_OUTPUT = 32 * 1024
export const VERIFY_REMINDER =
  'If the user asked to implement, replicate, or match a design, page, or site, call screenshot_design now and compare it before replying.'
export const EDIT_VERIFY_REMINDER =
  'If this edit changed size, alignment, spacing, layout, or cropping, call screenshot_design now and check it before replying; a screenshot from before the edit does not verify it.'

export interface ToolHost {
  /** Registers an invocation; returns its call id for result paging. */
  reportInvocation(name: string): number
  storeResult(callId: number, text: string): void
  readResult(callId: number): string | undefined
  askUser(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string>>
  /** A photo of the published design from an open fx0 tab; throws when none sends one in time. */
  captureDesign(
    signal: AbortSignal,
    options?: { toolCallId?: string; full?: boolean; width?: number },
  ): Promise<{ images: { mimeType: string; data: string }[]; revision: number; width?: number; height?: number; truncated?: boolean }>
  log(event: string, detail?: Record<string, unknown>): void
  spawnSubagent(task: string, signal: AbortSignal): Promise<string>
  capabilitySearch(query: string): { name: string; kind: string; description: string }[]
  readDesign(): Promise<{ html: string | null; artifactRevision: number }>
  publishDesign(
    html: string,
  ): Promise<{ ok: true; revision: number; changed: boolean } | { ok: false; reason: string; error: string }>
  editDesign(
    edits: { oldString: string; newString: string }[],
  ): Promise<{ ok: true; revision: number; changed: boolean } | { ok: false; reason: string; error: string }>
}

export interface AskQuestion {
  question: string
  options: { label: string; description?: string }[]
}

// Text formats web_fetch returns; images, PDFs, fonts and other binaries would only fill the context.
const TEXT_TYPE = /^(?:text\/|image\/svg\+xml|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript)\b)/i

/** A response read as a page. Without a content type, anything but an SVG or XML document. */
function isHtml(contentType: string | undefined, raw: string): boolean {
  if (contentType) return /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)
  return !/^\s*(?:<\?xml|<svg[\s>])/i.test(raw)
}

export function tail(text: string | undefined | null, max = MAX_TOOL_OUTPUT): string {
  if (!text) return ''
  if (text.length <= max) return text
  return (
    text.slice(0, 1024) +
    `\n… [${text.length - max} bytes truncated — full output paged via read_tool_result] …\n` +
    text.slice(-max)
  )
}

/** HTML work tools plus the common research and coordination tools. */
export function createTools(host: ToolHost, opts: { allowSubagent?: boolean } = {}): FxHostTool[] {
  const { allowSubagent = true } = opts

  const readDesign: FxHostTool = {
    name: 'read_design',
    description:
      'Read the authoritative design HTML for this session. Returns null before the first publish; large documents are truncated and can be paged with read_tool_result.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const callId = host.reportInvocation('read_design')
      const result = await host.readDesign()
      const stored = JSON.stringify(result)
      host.storeResult(callId, stored)
      if (result.html == null || result.html.length <= MAX_TOOL_OUTPUT) return result
      return {
        artifactRevision: result.artifactRevision,
        html: tail(result.html),
        callId,
        truncated: true,
      }
    },
  }

  const publishDesign: FxHostTool = {
    name: 'publish_design',
    description:
      'Publish one complete self-contained HTML document as the authoritative design. Inline CSS and JavaScript, Canvas, animation, and event handlers are supported inside the secure preview iframe. Use once for the first design or for a broad rewrite; keep normal drafts under 12 KiB. It must include doctype, html, head, and body; keep scripts inline; use only asset sources allowed by the instructions, including Google Fonts stylesheet links when enabled. Plain <a href="https://..."> links open in a new tab. Do not add HTML comments, other external assets, forms, scripted navigation, or nested frames. Use edit_design instead for localized follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The complete self-contained HTML document.' },
      },
      required: ['html'],
      additionalProperties: false,
    },
    async execute(input: { html: string }) {
      host.reportInvocation('publish_design')
      const result = await host.publishDesign(input.html)
      // A rule in the instructions alone was skipped; the reminder lands where the model decides to reply.
      return result.ok && result.changed ? { ...result, next: VERIFY_REMINDER } : result
    },
  }

  const editDesign: FxHostTool = {
    name: 'edit_design',
    description:
      'Apply one or more exact replacements to the current design in a single call, without republishing the whole document. Put every change a request needs into one call: they apply in order and publish once, atomically, as one version. Each old_string must match exactly once in the document as it stands after the edits before it.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Replacements, applied in order.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact current HTML, CSS, or JavaScript text to replace once.' },
              new_string: { type: 'string', description: 'Replacement text.' },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    async execute(input: { edits: { old_string: string; new_string: string }[] }) {
      host.reportInvocation('edit_design')
      const edits = Array.isArray(input?.edits) ? input.edits : []
      const result = await host.editDesign(edits.map((edit) => ({ oldString: edit.old_string, newString: edit.new_string })))
      return result.ok && result.changed ? { ...result, next: EDIT_VERIFY_REMINDER } : result
    },
  }

  const screenshotDesign: FxHostTool = {
    name: 'screenshot_design',
    description:
      'Screenshot the published design as the preview renders it, at the size the user sees it (1280x800 when the preview is closed). By default it shows the visible viewport; set full_page to see the whole page, top to bottom, in viewport-high images (at most 8). Use it after publishing when the user asks to implement, replicate, or match a design, page, or site (from an image, a URL, or a description) or the layout cannot be verified from the markup; skip it for copy, color, or other small edits. Use full_page when the sections below the first screen matter. Needs an fx0 tab open and in front; on failure, continue without it.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Whole page in viewport-high images instead of the visible viewport.' },
        width: {
          type: 'integer',
          minimum: CAPTURE_WIDTH.min,
          maximum: CAPTURE_WIDTH.max,
          description: 'Viewport width in CSS px, not image pixels. Set it when the reference viewport is known: a full-width 2880px capture at confirmed 2x represents 1440 CSS px. Do not infer 2x from image width alone, or treat a crop as a full viewport. Without it, use the visible preview width.',
        },
      },
      additionalProperties: false,
    },
    async execute(input: { full_page?: boolean; width?: number }, { signal, executionId }): Promise<FxToolResult | { error: string }> {
      host.reportInvocation('screenshot_design')
      const full = input?.full_page === true
      const width = captureWidth(input?.width)
      const t0 = Date.now()
      try {
        const shot = await host.captureDesign(signal, { toolCallId: executionId, full, ...(width ? { width } : {}) })
        const base64Bytes = shot.images.reduce((sum, image) => sum + image.data.length, 0)
        host.log('tool:screenshot_design:done', { ms: Date.now() - t0, revision: shot.revision, images: shot.images.length, base64Bytes })
        const size = `${shot.width ?? '?'}x${shot.height ?? '?'} CSS px`
        const text = full
          ? `Full-page screenshot of design revision ${shot.revision}, ${size}, in ${shot.images.length} viewport-high image${shot.images.length === 1 ? '' : 's'}, top to bottom.` +
            (shot.truncated ? ' The page continues below the last image.' : '')
          : `Screenshot of design revision ${shot.revision}, ${size}, as the preview shows it.`
        return { type: 'libfx.tool-result', text, images: shot.images.map((image) => ({ type: 'image', ...image })) }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error'
        host.log('tool:screenshot_design:error', { ms: Date.now() - t0, error: message })
        return { error: `screenshot unavailable: ${message}` }
      }
    },
  }

  const webFetch: FxHostTool = {
    name: 'web_fetch',
    description:
      'Fetch a public http(s) URL and return its text content, truncated. HTML pages come back as text with tags, scripts and styles stripped; SVG, XML, JSON, CSS and other text come back as is, so an SVG logo can be placed inline. Use for reading docs, pages and assets.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Public http(s) URL to fetch.' } },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(input: { url: string }, { signal }) {
      const callId = host.reportInvocation('web_fetch')
      if (!/^https?:\/\//.test(input.url)) return { error: 'only http(s) URLs are supported' }
      const t0 = Date.now()
      host.log('tool:web_fetch:start', { url: input.url.slice(0, 160) })
      try {
        // One 20s budget covers DNS, every redirect and the body, so a slow server
        // can't trickle-hang the turn.
        const { status, url, raw, contentType } = await fetchPublicText(input.url,
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
        if (contentType && !TEXT_TYPE.test(contentType.trim())) {
          host.log('tool:web_fetch:not-text', { ms: Date.now() - t0, status, contentType: contentType.slice(0, 80) })
          return { error: `not a text response (${contentType.slice(0, 80)}); web_fetch reads pages and text files such as SVG, JSON or CSS` }
        }
        // Only a page is reduced to its text: in SVG, XML, JSON or CSS the markup is the content.
        const text = !isHtml(contentType, raw) ? raw : raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        host.log('tool:web_fetch:done', { ms: Date.now() - t0, status, bytes: raw.length })
        const result = { status, url, content: tail(text, 100 * 1024) }
        host.storeResult(callId, JSON.stringify(result))
        return result
      } catch (error) {
        host.log('tool:web_fetch:error', { ms: Date.now() - t0, error: 'public page fetch failed' })
        return { error: 'public page fetch failed' }
      }
    },
  }

  const askUser: FxHostTool = {
    name: 'ask_user_question',
    description:
      'Ask the user 1-4 multiple-choice questions when a concrete decision blocks progress. Each question needs 2-6 options. Do not use for facts you can inspect yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async execute(input: { questions: AskQuestion[] }, { signal }) {
      host.reportInvocation('ask_user_question')
      const answers = await host.askUser(input.questions, signal)
      return { answers }
    },
  }

  const readToolResult: FxHostTool = {
    name: 'read_tool_result',
    description:
      'Page through the full stored output of a previous tool call by its call id (shown in the call log). Use when output was truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        call_id: { type: 'number', description: 'The call id from the invocation log.' },
        offset: { type: 'number', description: 'Byte offset to start from. Defaults to 0.' },
        limit: { type: 'number', description: 'Max bytes to return. Defaults to 8192.' },
      },
      required: ['call_id'],
      additionalProperties: false,
    },
    async execute(input: { call_id: number; offset?: number; limit?: number }) {
      host.reportInvocation('read_tool_result')
      const stored = host.readResult(input.call_id)
      if (stored === undefined) return { error: `no stored result for call ${input.call_id}` }
      const offset = Math.max(0, input.offset ?? 0)
      const limit = Math.min(Math.max(input.limit ?? 8192, 256), 64 * 1024)
      return {
        call_id: input.call_id,
        total_bytes: stored.length,
        offset,
        content: stored.slice(offset, offset + limit),
        truncated: offset + limit < stored.length,
      }
    },
  }

  const capabilitySearch: FxHostTool = {
    name: 'capability_search',
    description:
      'Search the tools available on this host by keyword. Use before claiming a capability is missing.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input: { query: string }) {
      host.reportInvocation('capability_search')
      return { matches: host.capabilitySearch(input.query) }
    },
  }

  const tools: FxHostTool[] = [readDesign, publishDesign, editDesign, screenshotDesign, webFetch, askUser, readToolResult, capabilitySearch]

  if (allowSubagent) {
    tools.push({
      name: 'subagent',
      description: 'Delegate a focused design or research subtask to a nested agent with the same HTML tools and no filesystem or shell access.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'Complete instructions for the subagent.' } },
        required: ['task'],
        additionalProperties: false,
      },
      async execute(input: { task: string }, { signal }) {
        const callId = host.reportInvocation('subagent')
        const result = await host.spawnSubagent(input.task, signal)
        host.storeResult(callId, result)
        return { result: tail(result) }
      },
    })
  }

  return tools
}
