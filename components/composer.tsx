'use client'

import { Suspense, use, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { type GuestDraft } from './guest-draft'
import { AuthRouteError, fetchUi } from './auth-ui'
import { IconFileText } from './geist-icons'
import ImagePreview from './image-preview'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { checkDesignMdUpload, DESIGN_MD_CATALOG, DESIGN_MD_MAX_BYTES } from '../lib/design-md'
import { fastClick } from '../lib/fast-click'
import { focusPrompt, registerPrompt } from '../lib/prompt-focus'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { TRIAL_MODEL, usesFreePrompts } from '../lib/trial-policy'
import { Skeleton } from './ui/skeleton'

// The model the page opens with, read on the server: the chat's stored settings,
// or for a new design the viewer's remembered picks from cookies.
export interface PagePreference { sessionId: string; model: string; effort: string; fast: boolean }

export interface GenerationOptions {
  model: string
  effort: string
  fast: boolean
  defaultModel: string
  // The rendered chat's own settings, as /api/model returns them.
  stored?: { model: string; effort: string; fast: boolean }
}

export interface AttachedImage {
  data: string
  mimeType: string
  preview: string
}

// A new chat's DESIGN.md: a catalog file by id, or an uploaded file's text.
const DOUBLE_ESCAPE_MS = 500

export type DesignMdPick = { id: string; name: string } | { name: string; text: string }

const IMAGE_CAP = 8
const IMAGE_DATA_CAP = 3 * 1024 * 1024
const PROMPT_MIN_HEIGHT = 64
const PROMPT_MAX_HEIGHT = 160

// Session storage is per tab and cleared with the account's other fx0 keys at sign-out.
const PROMPT_KEY = 'fx0:prompt'
// Runs as the textarea parses: restores the unsent prompt and focuses it (not on touch,
// where it would raise the keyboard); until hydration, typing refocuses it and Enter is held.
const RESTORE_PROMPT = `try{var t=document.getElementById('prompt-input'),v=sessionStorage.getItem(${JSON.stringify(PROMPT_KEY)});if(t&&v&&!t.value)t.value=v;if(t&&!matchMedia('(pointer: coarse)').matches){t.focus({preventScroll:true});t.setSelectionRange(t.value.length,t.value.length)}document.addEventListener('keydown',function(e){var p=document.getElementById('prompt-input'),a=e.target,n=a&&a.tagName;if(!p||window.__fx0Hydrated||e.isComposing)return;if(a===p){if(e.key==='Enter'&&!e.shiftKey&&p.value.trim()){e.preventDefault();p.__fx0Submit=true}return}if(e.metaKey||e.ctrlKey||e.altKey||e.key.length!==1||(a&&a.isContentEditable)||n==='INPUT'||n==='TEXTAREA'||n==='SELECT'||document.querySelector('[role="dialog"][data-state="open"]'))return;if(p!==document.activeElement)p.focus()})}catch(e){}`

const DEFAULT_EFFORT_LABEL = 'default'
let modelCatalogPromise: Promise<{
  models?: string[]
  defaultModel?: string
  efforts?: Record<string, string[]>
  fast?: string[]
  featured?: string[]
}> | null = null

// Ids are punctuated inconsistently, so "opus 45" has to match "claude-opus-4.5".
const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

function matchRank(name: string, token: string | undefined): number {
  if (!token) return 0
  if (name.startsWith(token)) return 0
  return name.includes(token) ? 1 : 2
}

// The viewer's last pick, as the composer remembers it in cookies.
function rememberedPreference(): { model: string; effort: string; fast: boolean } {
  const cookies = new Map(document.cookie.split('; ').map((pair) => {
    const split = pair.indexOf('=')
    return [pair.slice(0, split), pair.slice(split + 1)]
  }))
  return { model: cookies.get('fx0-model') ?? '', effort: cookies.get('fx0-effort') ?? '', fast: cookies.get('fx0-fast') === '1' }
}

function loadModelCatalog() {
  modelCatalogPromise ??= fetchUi('/api/models').then((response) => {
    if (!response.ok) throw new Error(`Model catalog failed with ${response.status}`)
    return response.json()
  })
  return modelCatalogPromise
}

function readImage(file: File): Promise<AttachedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      if (!result.startsWith('data:image/') || comma < 0)
        return reject(new Error('the selected file is not a supported image.'))
      resolve({ data: result.slice(comma + 1), mimeType: file.type || 'image/png', preview: result })
    }
    reader.onerror = () => reject(new Error('unable to read the selected image.'))
    reader.readAsDataURL(file)
  })
}

// Geist ships only the outlined bolt; dropping its inner counter fills the shape.
const LIGHTNING_OUTLINE =
  'M7.15714 0L2.33264 9.40776L1.77252 10.5H3.00001H7.00001C7.13808 10.5 7.25001 10.6119 7.25001 10.75V16H8.84288L13.6674 6.59224L14.2275 5.5H13H9.00001C8.86194 5.5 8.75001 5.38807 8.75001 5.25V0H7.15714Z'
const LIGHTNING_COUNTER =
  'M7.00001 9H4.22749L7.25001 3.1061V5.25C7.25001 6.2165 8.03351 7 9.00001 7H11.7725L8.75001 12.8939V10.75C8.75001 9.7835 7.96651 9 7.00001 9Z'

function LightningIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-full">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={filled ? LIGHTNING_OUTLINE : `${LIGHTNING_OUTLINE}${LIGHTNING_COUNTER}`}
        fill="currentColor"
      />
    </svg>
  )
}

export interface ComposerHandle {
  getDraft: () => GuestDraft
  restoreDraft: (draft: GuestDraft) => void
  clearDraft: () => void
  getGeneration: () => GenerationOptions
  getDesignMd: () => DesignMdPick | null
}

interface TrialAccount {
  user: { guest?: true } | null
  freePrompts?: number | null
}

interface TrialChatBoot {
  sessionId: string
  snapshot: { summary: { trialChat?: true } | null }
}

function FreePromptRegion({ boot, live, children }: {
  boot: Promise<TrialChatBoot>
  live: boolean | undefined
  children: (eligible: boolean) => ReactNode
}) {
  const view = live === undefined ? use(boot) : null
  return children(live ?? (view?.sessionId === 'draft' || view?.snapshot.summary?.trialChat === true))
}

// Only account-dependent controls suspend. The composer stays mounted so input
// and attachments entered before the account arrives remain in place.
function TrialRegion({ account, live, children }: {
  account: Promise<TrialAccount>
  live: TrialAccount | undefined
  children: (trial: boolean, remaining: number | null | undefined) => ReactNode
}) {
  const view = live ?? use(account)
  return children(view.user?.guest === true, view.freePrompts)
}

const QUESTION_PATH = 'M9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0M7.1 5.82a1 1 0 1 1 1.04 1.42c-.44.06-.89.44-.89 1.01v1h1.5v-.61a2.5 2.5 0 1 0-3-3.46l-.33.68 1.35.64z'
const HELP_BUTTON = 'grid size-4 place-items-center outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'

// A guest's help carries a sign-in link, so it opens as a popover the pointer can
// reach (label tooltips close on leave); everyone else gets the plain tooltip.
function FreePromptHelp({ help, onSignIn }: { help: string; onSignIn?: () => void }) {
  const [open, setOpen] = useState(false)
  const closing = useRef<number | undefined>(undefined)
  const icon = <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true"><path fill="currentColor" d={QUESTION_PATH} /></svg>
  if (!onSignIn) {
    return (
      <Tooltip>
        <TooltipTrigger asChild><button type="button" aria-label={help} className={HELP_BUTTON}>{icon}</button></TooltipTrigger>
        <TooltipContent>{help}</TooltipContent>
      </Tooltip>
    )
  }
  const show = () => { window.clearTimeout(closing.current); setOpen(true) }
  const hide = () => { closing.current = window.setTimeout(() => setOpen(false), 150) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="about free prompts" onPointerEnter={show} onPointerLeave={hide} className={HELP_BUTTON}>{icon}</button>
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()} onPointerEnter={show} onPointerLeave={hide}
        className="w-auto px-2 py-1 text-xs leading-5 shadow-md">
        Runs Opus 5.5 Fast.{' '}
        <button type="button" {...fastClick(() => { setOpen(false); onSignIn() })} className="text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring">Sign in</button>
        {' '}to keep going.
      </PopoverContent>
    </Popover>
  )
}

// The page's model as the server read it, so the streamed HTML names it before
// hydration. It applies to the session the page opened; another one waits for its
// own settings. A "-fast" id shows as its base model, as the picker lists it.
function PreferredModelLabel({ preference, sessionId, booting, defaultModel }: {
  preference: Promise<PagePreference>; sessionId: string; booting: boolean; defaultModel: string
}) {
  const page = use(preference)
  if (!booting && page.sessionId !== sessionId) return <Skeleton className="h-3.5 w-28 max-w-full" />
  const picked = page.model || defaultModel
  return <span className="truncate">{(picked.endsWith('-fast') ? picked.slice(0, -'-fast'.length) : picked).split('/').at(-1)}</span>
}

export default function Composer({
  ref,
  persistSettings,
  busy,
  stopping,
  sessionId,
  initialGeneration,
  sessionReady = true,
  preference,
  trial = false,
  freePrompts,
  account,
  accountReady = false,
  freePromptChat,
  freePromptEligible,
  onSend,
  onStop,
  onNewSession,
  onSignIn,
  onDraftInput,
}: {
  ref?: Ref<ComposerHandle>
  persistSettings: boolean
  busy: boolean
  stopping: boolean
  sessionId: string
  initialGeneration: GenerationOptions
  sessionReady?: boolean
  preference?: Promise<PagePreference>
  trial?: boolean
  freePrompts?: number | null
  account?: Promise<TrialAccount>
  accountReady?: boolean
  freePromptChat?: Promise<TrialChatBoot>
  freePromptEligible?: boolean
  onSend: (text: string, images: AttachedImage[]) => boolean | void
  onStop: () => void
  onNewSession: () => void
  onSignIn?: () => void
  onDraftInput?: (text: string) => void
}) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<AttachedImage[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [efforts, setEfforts] = useState<Record<string, string[]>>({})
  const [fastModels, setFastModels] = useState<string[]>([])
  const [featuredModels, setFeaturedModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState(initialGeneration.defaultModel)
  const [model, setModel] = useState(initialGeneration.model)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [effort, setEffort] = useState(initialGeneration.effort)
  const [fast, setFast] = useState(initialGeneration.fast)
  const [generationSession, setGenerationSession] = useState<string | null>(initialGeneration.stored ? sessionId : null)
  const [generationError, setGenerationError] = useState('')
  const [activeCommand, setActiveCommand] = useState(0)
  const [commandDismissedFor, setCommandDismissedFor] = useState('')
  const [designMd, setDesignMd] = useState<DesignMdPick | null>(null)
  const [designPickerOpen, setDesignPickerOpen] = useState(false)
  const [designTipOpen, setDesignTipOpen] = useState(false)
  const designFileRef = useRef<HTMLInputElement>(null)
  const designListRef = useRef<HTMLDivElement>(null)
  // The attach menu's two views: the choice of image or design.md, then the design.md list.
  const [attachView, setAttachView] = useState<'menu' | 'design'>('menu')
  const attachMenuRef = useRef<HTMLDivElement>(null)
  // Every way the attach menu opens or closes drops its tooltip too. Choosing image
  // opens the system file dialog, which swallows the pointer leave, so a tooltip left
  // open under the menu would otherwise come back and stick once the menu closes.
  function setAttachOpen(open: boolean) {
    setDesignPickerOpen(open)
    setDesignTipOpen(false)
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastEscape = useRef(0)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const addFilesRef = useRef<(files: Iterable<File>) => void>(() => {})
  const [dropping, setDropping] = useState(false)
  const activeSession = useRef(sessionId)
  const generationRequest = useRef(0)
  const generationMutation = useRef<Promise<void>>(Promise.resolve())
  const commandListId = useId()
  activeSession.current = sessionId
  const liveGeneration = useRef({ model, effort, fast })
  liveGeneration.current = { model, effort, fast }
  const mayPersist = useRef(persistSettings)
  const renderedSettings = useRef(initialGeneration.stored)
  mayPersist.current = persistSettings && sessionId !== 'draft' && !trial

  // Hydration keeps text typed or restored before it in the DOM, but not in state.
  const submitOnHydrate = useRef(false)
  useLayoutEffect(() => {
    const element = textareaRef.current as (HTMLTextAreaElement & { __fx0Submit?: boolean }) | null
    ;(window as Window & { __fx0Hydrated?: boolean }).__fx0Hydrated = true
    if (element) {
      submitOnHydrate.current = element.__fx0Submit === true
      element.__fx0Submit = false
    }
    const typed = element?.value
    if (typed) {
      setValue((current) => current || typed)
      return
    }
    try {
      const stored = window.sessionStorage.getItem(PROMPT_KEY)
      if (stored) setValue((current) => current || stored)
    } catch { /* Storage is optional. */ }
  }, [])
  useEffect(() => {
    try {
      if (value) window.sessionStorage.setItem(PROMPT_KEY, value)
      else window.sessionStorage.removeItem(PROMPT_KEY)
    } catch { /* Storage is optional. */ }
  }, [value])

  useImperativeHandle(ref, () => ({
    getDraft: () => ({ text: value, images, designMd }),
    restoreDraft: (draft) => {
      setValue((current) => current || draft.text)
      setImages((current) => current.length ? current : draft.images)
      if (draft.designMd) setDesignMd((current) => current ?? draft.designMd ?? null)
    },
    clearDraft: () => { setValue(''); setImages([]); setAttachmentError('') },
    getGeneration: () => ({ model: trial ? TRIAL_MODEL : model, effort: trial ? 'low' : effort, fast: trial || fast, defaultModel }),
    getDesignMd: () => designMd,
  }), [value, images, model, effort, fast, defaultModel, designMd, trial])

  // A DESIGN.md belongs to the draft it was picked on: it goes with that chat's
  // first prompt and never carries into another chat.
  const newChat = sessionId === 'draft'
  useEffect(() => {
    if (!newChat) {
      setDesignMd(null)
      setDesignPickerOpen(false)
    }
  }, [newChat])

  async function addDesignMdFile(file: File) {
    focusPrompt()
    setAttachmentError('')
    if (file.size > DESIGN_MD_MAX_BYTES) {
      setAttachmentError('design.md must be 100 KB or smaller.')
      return
    }
    try {
      const checked = checkDesignMdUpload(file.name, await file.text())
      if ('error' in checked) setAttachmentError(checked.error)
      else setDesignMd({ name: checked.name, text: checked.text })
    } catch {
      setAttachmentError('unable to read that file. choose another design.md.')
    }
  }

  const moveDesignFocus = (delta: number) => {
    const options = Array.from(designListRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    options[Math.max(0, Math.min(options.length - 1, current + delta))]?.focus()
  }

  function rememberPreference(options: { model?: string; effort?: string; fast?: boolean }) {
    const year = 'Path=/; Max-Age=31536000; SameSite=Lax'
    if (typeof options.model === 'string') document.cookie = `fx0-model=${options.model}; ${year}`
    if (typeof options.effort === 'string') document.cookie = `fx0-effort=${options.effort}; ${year}`
    if (typeof options.fast === 'boolean') document.cookie = `fx0-fast=${options.fast ? 1 : 0}; ${year}`
  }

  // Only the viewer's own picks become their preference; a chat's stored settings
  // apply to that chat, and opening it must not change what new chats start with.
  function applyGenerationOptions(
    targetSession: string,
    options: { model?: string; effort?: string; fast?: boolean },
    remember: boolean,
  ) {
    if (activeSession.current !== targetSession) return
    if (typeof options.model === 'string') setModel(options.model)
    if (typeof options.effort === 'string') setEffort(options.effort)
    if (typeof options.fast === 'boolean') setFast(options.fast)
    setGenerationSession(targetSession)
    if (remember) rememberPreference(options)
  }

  async function loadGenerationOptions(targetSession = sessionId, waitForMutations = true) {
    if (!mayPersist.current || targetSession === 'draft') return
    const request = ++generationRequest.current
    if (waitForMutations) await generationMutation.current.catch(() => {})
    if (!mayPersist.current || targetSession !== activeSession.current) return
    const response = await fetchUi(`/api/model?session=${encodeURIComponent(targetSession)}`)
    if (!response.ok) throw new Error('Unable to load generation settings.')
    const options = await response.json()
    if (mayPersist.current && request === generationRequest.current && options) adoptGenerationOptions(targetSession, options)
  }

  // A chat with no stored model adopts what the picker shows *now*, written
  // through so the worker resolves the same model. Page-load props are stale
  // after any toggle, and writing a model resets fast server-side, so the live
  // fast value rides in the same request. The default model needs no write.
  function adoptGenerationOptions(targetSession: string, options: { model?: string; effort?: string; fast?: boolean }) {
    const shown = liveGeneration.current
    if (!options.model && shown.model) {
      void saveGenerationOptions(targetSession, { model: shown.model, effort: shown.effort || null, fast: shown.fast }, false)
    } else {
      applyGenerationOptions(targetSession, options, false)
    }
    setGenerationError('')
  }

  async function saveGenerationOptions(targetSession: string, body: Record<string, unknown>, remember = true) {
    const options = {
      ...(Object.hasOwn(body, 'model') ? { model: typeof body.model === 'string' ? body.model : '' } : {}),
      ...(Object.hasOwn(body, 'effort') ? { effort: typeof body.effort === 'string' ? body.effort : '' } : {}),
      ...(typeof body.fast === 'boolean' ? { fast: body.fast } : {}),
    }
    applyGenerationOptions(targetSession, options, remember)
    if (!mayPersist.current || targetSession === 'draft') return
    const request = ++generationRequest.current
    setGenerationError('')
    const mutation = generationMutation.current
      .catch(() => {})
      .then(async () => {
        if (!mayPersist.current || targetSession !== activeSession.current) return
        try {
          const response = await fetchUi(`/api/model?session=${encodeURIComponent(targetSession)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error('Unable to save generation settings.')
          const options = await response.json()
          if (request === generationRequest.current && options) applyGenerationOptions(targetSession, options, remember)
        } catch (error) {
          if (error instanceof AuthRouteError) return
          if (request === generationRequest.current) {
            setGenerationError(`${(error as Error).message} Try again.`)
            await loadGenerationOptions(targetSession, false).catch(() => {})
          }
        }
      })
    generationMutation.current = mutation
    await mutation
  }

  useEffect(() => {
    registerPrompt(textareaRef.current)
    focusPrompt()
    return () => registerPrompt(null)
  }, [sessionId])

  addFilesRef.current = addFiles

  // Dropping anywhere over the chat attaches, so the target is the document.
  useEffect(() => {
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      setDropping(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDropping(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      setDropping(false)
      addFilesRef.current(Array.from(event.dataTransfer?.files ?? []))
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  // Focusing during keydown is what routes the character into the textarea.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      if (event.key.length !== 1) return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const element = textareaRef.current
      if (!element || element === document.activeElement) return
      element.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useLayoutEffect(() => {
    setGenerationError('')
    if (sessionId === 'draft') {
      // A new chat starts from the viewer's last pick, or the app default, not
      // from the settings of the chat they were just looking at.
      const remembered = rememberedPreference()
      setModel(remembered.model)
      setEffort(remembered.effort)
      setFast(remembered.fast)
      setGenerationSession('draft')
      return
    }
    // Without access to the chat's settings (a guest, or the send that is creating
    // it), the picker keeps the selection it shows instead of waiting forever.
    if (!persistSettings) {
      setGenerationSession(sessionId)
      return
    }
    // The page read the first chat's settings as it rendered; later chats ask.
    const rendered = renderedSettings.current
    renderedSettings.current = undefined
    if (rendered) {
      adoptGenerationOptions(sessionId, rendered)
      return
    }
    void loadGenerationOptions(sessionId).catch((error) => {
      if (!(error instanceof AuthRouteError)) setGenerationError('Unable to confirm generation settings. Try again.')
    }).finally(() => {
      // Success already marked it; a failed or skipped load shows the current
      // selection (with the error) rather than an endless skeleton.
      if (activeSession.current === sessionId) setGenerationSession(sessionId)
    })
    // loadGenerationOptions intentionally tracks only the selected session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, persistSettings])

  useEffect(() => {
    void loadModelCatalog()
      .then((catalog) => {
        setModels(catalog.models ?? [])
        setEfforts(catalog.efforts ?? {})
        setFastModels(catalog.fast ?? [])
        setFeaturedModels(catalog.featured ?? [])
        setDefaultModel(catalog.defaultModel ?? initialGeneration.defaultModel)
      })
      .catch(() => setModels(initialGeneration.defaultModel ? [initialGeneration.defaultModel] : []))
  }, [])

  useEffect(() => {
    if (!persistSettings || sessionId === 'draft') return
    // Settings change only through this picker; another tab is the only source of
    // drift, so a refresh per 30s of tab returns is plenty.
    let lastRevalidated = Date.now()
    const revalidate = () => {
      if (Date.now() - lastRevalidated < 30_000) return
      lastRevalidated = Date.now()
      void loadGenerationOptions(sessionId).catch((error) => {
        if (!(error instanceof AuthRouteError)) setGenerationError('Unable to confirm generation settings. Try again.')
      })
    }
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
    // loadGenerationOptions intentionally tracks only the selected session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, persistSettings])

  // Paint the choice before the round trip so the click never feels dead.
  // Fast is on by default for any model that offers it. Sending it explicitly with
  // the model matters: the server resets fast on a model change, so leaving it out
  // painted the bolt optimistically and then cleared it when the response landed.
  async function chooseModel(next: string, nextFast?: boolean) {
    if (trial) return
    const fastValue = nextFast ?? fastModels.includes(next || defaultModel)
    await saveGenerationOptions(sessionId, { model: next || null, fast: fastValue })
  }

  async function chooseEffort(next: string) {
    if (trial) return
    await saveGenerationOptions(sessionId, { effort: next || null })
  }

  const commands: { name: string; hint: string; run: (arg: string) => void; takesArgument?: boolean }[] = [
    { name: '/new', hint: 'start a fresh chat', run: () => onNewSession() },
    { name: '/stop', hint: 'stop the active turn', run: () => onStop() },
    {
      name: '/model',
      hint: 'switch model by id or unique prefix',
      takesArgument: true,
      run: (argument: string) => {
        const query = argument.trim().toLowerCase()
        if (!query) return
        const match =
          models.find((candidate) => candidate.toLowerCase() === query) ??
          models.find((candidate) => candidate.toLowerCase().includes(query))
        if (match) void chooseModel(match)
        else setGenerationError(`No model matches “${argument.trim()}”.`)
      },
    },
  ].filter((command) => !trial || command.name !== '/model')

  const slashQuery = value.startsWith('/') && !value.includes('\n') ? value : null
  const commandToken = slashQuery?.split(/\s+/)[0] ?? ''
  const slashArgument = slashQuery?.slice(commandToken.length).trim() ?? ''
  const matching =
    slashQuery != null && commandDismissedFor !== value
      ? commands.filter((command) => command.name.startsWith(commandToken))
      : []
  const activeOptionId = matching.length > 0 ? `${commandListId}-${activeCommand % matching.length}` : undefined

  function selectCommand(command: (typeof commands)[number]) {
    if (command.takesArgument && !slashArgument) {
      setValue(`${command.name} `)
      setCommandDismissedFor(`${command.name} `)
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    setValue('')
    command.run(slashArgument)
  }

  function submit() {
    const text = value.trim()
    if (!text && images.length === 0) return
    const exactCommand = commands.find((command) => command.name === commandToken)
    if (slashQuery != null && images.length === 0 && exactCommand) {
      selectCommand(exactCommand)
      return
    }
    if (onSend(text, images) === false) return
    setValue('')
    setImages([])
    setAttachmentError('')
  }

  useEffect(() => {
    if (!submitOnHydrate.current || !value) return
    submitOnHydrate.current = false
    submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  async function addFiles(files: Iterable<File>) {
    focusPrompt()
    const acceptedFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (acceptedFiles.length === 0) return
    setAttachmentError('')
    try {
      const nextImages = await Promise.all(acceptedFiles.slice(0, IMAGE_CAP).map(readImage))
      setImages((current) => {
        const available = Math.max(0, IMAGE_CAP - current.length)
        const combined = [...current, ...nextImages.slice(0, available)]
        if (combined.reduce((total, image) => total + image.data.length, 0) > IMAGE_DATA_CAP) {
          setAttachmentError('images must stay under 3 MiB combined. remove one or choose smaller files.')
          return current
        }
        if (acceptedFiles.length > available) setAttachmentError(`you can attach up to ${IMAGE_CAP} images.`)
        return combined
      })
    } catch (error) {
      setAttachmentError(`${(error as Error).message} Choose another image.`)
    }
  }

  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    const fit = () => {
      element.style.height = '0px'
      const contentHeight = element.scrollHeight
      element.style.height = `${Math.min(Math.max(contentHeight, PROMPT_MIN_HEIGHT), PROMPT_MAX_HEIGHT)}px`
      element.style.overflowY = contentHeight > PROMPT_MAX_HEIGHT ? 'auto' : 'hidden'
    }
    fit()
    // A pane opening from zero width rewraps the text without changing it.
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [value])

  // A "-fast" id is its base model with the fast channel on, so it shows as that
  // model with the bolt lit, as the picker lists it. The default model is one.
  const pickedModel = trial ? TRIAL_MODEL : model || defaultModel
  const fastBase = pickedModel.endsWith('-fast') ? pickedModel.slice(0, -'-fast'.length) : ''
  const intrinsicFast = Boolean(fastBase) && (models.length === 0 || models.includes(fastBase))
  const resolvedModel = intrinsicFast ? fastBase : pickedModel
  const fastOn = trial || fast || intrinsicFast
  const modelLabel = resolvedModel ? (resolvedModel.split('/').at(-1) ?? resolvedModel) : 'Model'
  // The trial model by its slug, as the picker lists it: the base model when the catalog has it.
  const trialBase = TRIAL_MODEL.slice(0, -'-fast'.length)
  const trialLabel = (models.length === 0 || models.includes(trialBase) ? trialBase : TRIAL_MODEL).split('/').at(-1)
  // The static shell cannot know browser preferences or a chat's stored model.
  // Reserve its space until that session's selection is known, never paint a
  // different model while cookies or shared chat settings are being restored.
  const modelReady = sessionReady && generationSession === sessionId
  const trialRegion = (render: (trial: boolean, remaining: number | null | undefined) => ReactNode) => account
    ? <Suspense fallback={render(trial, freePrompts)}>
        <TrialRegion account={account} live={accountReady ? { user: trial ? { guest: true } : null, freePrompts } : undefined}>{render}</TrialRegion>
      </Suspense>
    : render(trial, freePrompts)
  useEffect(() => {
    if (!modelPickerOpen) return
    const frame = requestAnimationFrame(() => {
      modelListRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [modelPickerOpen])

  const moveModelFocus = (delta: number) => {
    const options = Array.from(modelListRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    if (!options.length) return
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    if (current === -1) {
      options[delta > 0 ? 0 : options.length - 1].focus()
      return
    }
    if (current + delta < 0) {
      modelSearchRef.current?.focus()
      return
    }
    options[Math.min(current + delta, options.length - 1)].focus()
  }

  const effortOptions = trial ? [] : efforts[resolvedModel ?? ''] ?? []
  const cycleEffort = () => {
    const values = ['', ...effortOptions]
    void chooseEffort(values[(values.indexOf(effort) + 1) % values.length])
  }

  const normalizedModelQuery = modelQuery.trim().toLowerCase()
  const queryTokens = normalizedModelQuery.split(/\s+/).map(squash).filter(Boolean)
  // "-fast" ids are the same model with the fast channel on, which the bolt
  // already expresses, so they are not separate rows — unless one is selected.
  const listedModels = (trial ? [] : models).filter(
    (candidate) =>
      candidate === resolvedModel ||
      !candidate.endsWith('-fast') ||
      !models.includes(candidate.slice(0, -'-fast'.length)),
  )
  const matchingModels = listedModels
    .map((candidate) => ({
      candidate,
      haystack: squash(candidate),
      name: squash(candidate.split('/').at(-1) ?? candidate),
    }))
    .filter(({ haystack }) => queryTokens.every((token) => haystack.includes(token)))
    .sort((a, b) => matchRank(a.name, queryTokens[0]) - matchRank(b.name, queryTokens[0]))
    .map(({ candidate }) => candidate)
  // Before a search, the picker opens on the selected model, then the featured
  // ones, then the rest.
  const filteredModels = (queryTokens.length
    ? matchingModels
    : [...new Set([resolvedModel, ...featuredModels, ...matchingModels])].filter((candidate) => matchingModels.includes(candidate))
  ).slice(0, 24)

  return (
    <div
      className={`relative border-t bg-background px-2 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-2 sm:px-3 sm:pb-2 ${
        dropping ? 'border-foreground' : 'border-border'
      }`}
    >
      <div className="mx-auto max-w-2xl">
        {matching.length > 0 && (
          <div
            id={commandListId}
            role="listbox"
            aria-label="Commands"
            className="mb-1.5 overflow-hidden bg-popover p-1 shadow-lg"
          >
            {matching.map((command, index) => (
              <button
                key={command.name}
                id={`${commandListId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeCommand % matching.length}
                onMouseDown={(event) => event.preventDefault()}
                {...fastClick(() => selectCommand(command))}
                className={`flex min-h-9 w-full items-baseline gap-2.5 px-2.5 py-1.5 text-left outline-none transition-colors ${
                  index === activeCommand % matching.length ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
                }`}
              >
                <span className="text-sm font-medium">{command.name}</span>
                <span className="text-xs text-muted-foreground">{command.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div>
          {(images.length > 0 || (newChat && designMd)) && (
            <div className="flex flex-wrap items-start gap-2 px-3 pt-3">
              {newChat && designMd && (
                <div className="flex h-8 max-w-full items-center gap-1.5 border bg-muted pl-2 text-xs">
                  <IconFileText size={12} className="shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">design.md</span>
                  <span className="min-w-0 truncate text-foreground">{designMd.name}</span>
                  <button
                    type="button"
                    {...fastClick(() => {
                      setDesignMd(null)
                      focusPrompt()
                    })}
                    aria-label={`Remove design.md ${designMd.name}`}
                    className="grid size-8 shrink-0 place-items-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="m4 4 8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              )}
              {images.map((image, index) => (
                <div key={`${image.preview.slice(-16)}-${index}`} className="relative">
                  <ImagePreview
                    src={image.preview}
                    alt={`Attached image ${index + 1}`}
                    className="h-auto max-h-14 w-auto max-w-28 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                  />
                  <button
                    type="button"
                    {...fastClick(() => {
                      setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))
                      focusPrompt()
                    })}
                    aria-label={`Remove attached image ${index + 1}`}
                    className="absolute -right-2 -top-2 grid size-7 place-items-center border bg-popover text-muted-foreground shadow-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="size-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path d="m4 4 8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <label htmlFor="prompt-input" className="sr-only">
            Message
          </label>
          <Textarea
            id="prompt-input"
            ref={textareaRef}
            name="prompt"
            autoComplete="off"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              onDraftInput?.(event.target.value)
              setActiveCommand(0)
              setCommandDismissedFor('')
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (matching.length > 0 && event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveCommand((index) => (index + 1) % matching.length)
                return
              }
              if (matching.length > 0 && event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveCommand((index) => (index - 1 + matching.length) % matching.length)
                return
              }
              if (matching.length > 0 && event.key === 'Escape') {
                event.preventDefault()
                setCommandDismissedFor(value)
                return
              }
              // Escape twice in quick succession clears the text, as in a terminal.
              if (event.key === 'Escape') {
                const now = event.timeStamp
                if (value && now - lastEscape.current < DOUBLE_ESCAPE_MS) {
                  event.preventDefault()
                  lastEscape.current = 0
                  setValue('')
                  onDraftInput?.('')
                  return
                }
                lastEscape.current = now
                return
              }
              if (matching.length > 0 && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                selectCommand(matching[activeCommand % matching.length])
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            onPaste={(event) => {
              const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              )
              if (imageFiles.length > 0) {
                event.preventDefault()
                void addFiles(imageFiles)
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={matching.length > 0}
            aria-controls={matching.length > 0 ? commandListId : undefined}
            aria-activedescendant={activeOptionId}
            rows={1}
            placeholder="ask fx0 to design"
            className="min-h-16 border-0 px-3 py-2.5 text-sm leading-5 shadow-none focus-visible:ring-0"
          />
          <script dangerouslySetInnerHTML={{ __html: RESTORE_PROMPT }} />

          <div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1">
            <input
              ref={fileRef}
              id="image-upload"
              name="images"
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />

            {trialRegion((isTrial) => isTrial ? (
              <Button variant="ghost" size="sm" disabled aria-label={`Model: ${trialLabel}`}
                className="h-8 min-w-0 max-w-44 flex-1 justify-start px-2 text-sm font-normal text-muted-foreground">
                <span className="truncate">{trialLabel}</span>
              </Button>
            ) : <Popover
              modal
              open={modelPickerOpen}
              onOpenChange={(open) => {
                setModelPickerOpen(trial ? false : open)
                if (open) setModelQuery('')
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={trial}
                  aria-label={`Model: ${modelReady ? modelLabel : 'loading'}`}
                  aria-busy={!modelReady}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    event.preventDefault()
                    if (!trial) setModelPickerOpen((open) => !open)
                  }}
                  onClick={(event) => {
                    if (event.detail !== 0) event.preventDefault()
                  }}
                  className="h-8 min-w-0 max-w-44 flex-1 justify-between gap-1 px-2 text-sm font-normal text-muted-foreground"
                >
                  {modelReady ? <span className="truncate">{modelLabel}</span>
                    : preference
                      ? <Suspense fallback={<Skeleton className="h-3.5 w-28 max-w-full" />}><PreferredModelLabel preference={preference} sessionId={sessionId} booting={!sessionReady} defaultModel={defaultModel} /></Suspense>
                      : <Skeleton className="h-3.5 w-28 max-w-full" />}
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="m4 6 4 4 4-4" />
                  </svg>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[min(20rem,calc(100vw-1rem))] p-2"
                // Back to the prompt, not the trigger: a trigger refocused after Escape shows a focus ring.
                onCloseAutoFocus={(event) => { event.preventDefault(); focusPrompt() }}
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  requestAnimationFrame(() => modelSearchRef.current?.focus())
                }}
              >
                <label htmlFor="model-search" className="sr-only">
                  search models
                </label>
                <input
                  ref={modelSearchRef}
                  id="model-search"
                  name="model-search"
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown') return
                    event.preventDefault()
                    moveModelFocus(1)
                  }}
                  placeholder="search models…"
                  className="h-8 w-full bg-muted px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div
                  ref={modelListRef}
                  role="listbox"
                  aria-label="Available models"
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                    event.preventDefault()
                    moveModelFocus(event.key === 'ArrowDown' ? 1 : -1)
                  }}
                  className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto overscroll-contain"
                >
                  {filteredModels.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      role="option"
                      aria-selected={resolvedModel === candidate}
                      {...fastClick(() => void chooseModel(candidate))}
                      className={`flex min-h-8 w-full items-center gap-2 px-2.5 text-left text-sm outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground ${model === candidate ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{candidate.split('/').at(-1) ?? candidate}</span>
                      {resolvedModel === candidate && effortOptions.length > 0 && (
                        <span
                          role="button"
                          tabIndex={0}
                          title="click to cycle reasoning effort"
                          aria-label={`reasoning effort: ${effort || DEFAULT_EFFORT_LABEL}`}
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            cycleEffort()
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return
                            event.preventDefault()
                            event.stopPropagation()
                            cycleEffort()
                          }}
                          // As wide as the longest level, so cycling never pulls the target out from under the pointer.
                          style={{ width: `calc(${Math.max(DEFAULT_EFFORT_LABEL.length, ...effortOptions.map((option) => option.length))}ch + 0.5rem)` }}
                          className="-my-1 shrink-0 px-1 py-1 text-right font-mono text-xs text-foreground-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {effort || DEFAULT_EFFORT_LABEL}
                        </span>
                      )}
                      {fastModels.includes(candidate) && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`use ${candidate} with fast mode`}
                          aria-pressed={resolvedModel === candidate && fastOn}
                          title="fast mode"
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            void chooseModel(candidate, resolvedModel === candidate ? !fastOn : true)
                          }}
                          className={`shrink-0 ${
                            resolvedModel === candidate && fastOn ? 'text-foreground' : 'text-foreground-tertiary hover:text-foreground'
                          }`}
                        >
                          <span className="block size-3">
                            <LightningIcon filled={resolvedModel === candidate && fastOn} />
                          </span>
                        </span>
                      )}
                      {model === candidate && (
                        <svg
                          viewBox="0 0 16 16"
                          className="size-3.5 shrink-0"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        >
                          <path d="m3 8 3 3 7-7" />
                        </svg>
                      )}
                    </button>
                  ))}
                  {filteredModels.length === 0 && (
                    <p className="px-2.5 py-5 text-center text-sm text-muted-foreground">no matching models.</p>
                  )}
                </div>
                {!normalizedModelQuery && listedModels.length > filteredModels.length && (
                  <p className="px-2.5 pt-2 text-xs text-muted-foreground">search {listedModels.length} available models.</p>
                )}

              </PopoverContent>
            </Popover>)}

            {/* A DESIGN.md only goes with a new chat's first prompt; elsewhere attach means images. */}
            {!newChat ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    {...fastClick(() => fileRef.current?.click())}
                    disabled={images.length >= IMAGE_CAP}
                    aria-label="attach images"
                  >
                    <svg
                    viewBox="0 0 24 24"
                    className="size-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>attach images</TooltipContent>
              </Tooltip>
            ) : (
              <>
                <input
                  ref={designFileRef}
                  id="design-md-upload"
                  name="design-md"
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void addDesignMdFile(file)
                    event.target.value = ''
                  }}
                />
                <Popover
                  modal
                  open={designPickerOpen}
                  onOpenChange={(open) => {
                    setAttachOpen(open)
                    if (open) setAttachView('menu')
                  }}
                >
                  {/* The tooltip would sit over the open menu. */}
                  <Tooltip open={designTipOpen && !designPickerOpen} onOpenChange={setDesignTipOpen}>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={designMd ? `attach, design.md: ${designMd.name}` : 'attach'}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.preventDefault()
                            setAttachView('menu')
                            setAttachOpen(!designPickerOpen)
                          }}
                          onClick={(event) => {
                            if (event.detail !== 0) event.preventDefault()
                          }}
                          className={designMd ? 'text-foreground' : undefined}
                        >
                          <svg
                    viewBox="0 0 24 24"
                    className="size-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>attach</TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    align="start"
                    className={attachView === 'menu' ? 'w-56 p-1.5' : 'w-[min(26rem,calc(100vw-1rem))] p-1.5'}
                    onCloseAutoFocus={(event) => { event.preventDefault(); focusPrompt() }}
                    onOpenAutoFocus={(event) => {
                      event.preventDefault()
                      requestAnimationFrame(() => attachMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus())
                    }}
                  >
                    {attachView === 'menu' ? (
                      <div ref={attachMenuRef} role="menu" aria-label="attach" className="space-y-0.5">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={images.length >= IMAGE_CAP}
                          {...fastClick(() => {
                            setAttachOpen(false)
                            fileRef.current?.click()
                          })}
                          className="flex min-h-8 w-full items-center gap-3 px-2.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45"
                        >
                          image
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          aria-haspopup="listbox"
                          {...fastClick(() => {
                            setAttachView('design')
                            // The list mounts on this render; focus its selected file, or the first.
                            requestAnimationFrame(() =>
                              (
                                designListRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
                                designListRef.current?.querySelector<HTMLButtonElement>('[role="option"]')
                              )?.focus(),
                            )
                          })}
                          className="flex min-h-8 w-full items-center gap-3 px-2.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45"
                        >
                          <span className="flex-1">design.md</span>
                          {designMd && <span className="min-w-0 truncate text-xs text-muted-foreground">{designMd.name}</span>}
                          <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                            <path d="m6 4 4 4-4 4" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          {...fastClick(() => {
                            setAttachView('menu')
                            requestAnimationFrame(() => attachMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus())
                          })}
                          className="mb-1 flex min-h-8 w-full items-center gap-1.5 px-2.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                        >
                          <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                            <path d="m10 4-4 4 4 4" />
                          </svg>
                          design.md
                        </button>
                      <div
                        ref={designListRef}
                        role="listbox"
                        aria-label="design.md files"
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                          event.preventDefault()
                          moveDesignFocus(event.key === 'ArrowDown' ? 1 : -1)
                        }}
                        className="max-h-[min(22rem,55vh)] space-y-0.5 overflow-y-auto overscroll-contain"
                      >
                        {DESIGN_MD_CATALOG.map((option) => {
                          const selected = designMd != null && 'id' in designMd && designMd.id === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              {...fastClick(() => {
                                setDesignMd({ id: option.id, name: option.name })
                                setAttachmentError('')
                                setAttachOpen(false)
                                focusPrompt()
                              })}
                              title={option.description}
                              className={`flex min-h-8 w-full items-center gap-3 px-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent ${
                                selected ? 'bg-accent' : ''
                              }`}
                            >
                              <span className="w-20 shrink-0 text-sm text-foreground">{option.name}</span>
                              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{option.description}</span>
                              {selected && (
                                <svg
                                  viewBox="0 0 16 16"
                                  className="size-3.5 shrink-0"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  aria-hidden="true"
                                >
                                  <path d="m3 8 3 3 7-7" />
                                </svg>
                              )}
                            </button>
                          )
                        })}
                      </div>
                      <div className="mt-1 border-t pt-1">
                        <button
                          type="button"
                          {...fastClick(() => {
                            setAttachOpen(false)
                            designFileRef.current?.click()
                          })}
                          className="flex min-h-8 w-full items-center px-2.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                        >
                          upload a design.md…
                        </button>
                      </div>
                      </>
                    )}
                  </PopoverContent>
                </Popover>
              </>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-1">
              {busy && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      {...fastClick(() => {
                        onStop()
                        focusPrompt()
                      })}
                      disabled={stopping}
                      aria-label={stopping ? 'stopping turn' : 'stop current turn'}
                    >
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
                        <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                      </svg>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{stopping ? 'stopping…' : 'stop turn'}</TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    {...fastClick(submit)}
                    disabled={!value.trim() && images.length === 0}
                    aria-label={busy ? 'Steer the active turn' : 'Send message'}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="size-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 13V3M4 7l4-4 4 4" />
                    </svg>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{busy ? 'Steer the active turn' : 'Send message'}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {trialRegion((isTrial, remaining) => {
          const renderNotice = (eligible: boolean) => {
            const [notice, help] = remaining == null ? [null, null]
              : isTrial && remaining === 0 ? ['Free prompts are used.', null]
                : (isTrial || (eligible && usesFreePrompts(pickedModel, effort, fastOn))) && remaining > 0
                  ? [`${remaining} free ${remaining === 1 ? 'prompt' : 'prompts'} left`, isTrial ? 'Runs Opus 5.5 Fast. Sign in to keep going.' : 'Runs Opus 5.5 Fast at low effort.']
                  : [null, null]
            return notice && (
              <p role="status" className="absolute bottom-full right-2 mb-2 flex items-center gap-1.5 border bg-background py-1 pl-2 pr-1.5 text-xs leading-4 text-muted-foreground sm:right-3">
                {notice}
                {isTrial && remaining === 0 && onSignIn && (
                  <button type="button" {...fastClick(onSignIn)} className="text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring">
                    Sign in
                  </button>
                )}
                {help && <FreePromptHelp help={help} onSignIn={isTrial ? onSignIn : undefined} />}
              </p>
            )
          }
          if (isTrial || !freePromptChat) return renderNotice(freePromptEligible ?? sessionId === 'draft')
          return <Suspense fallback={renderNotice(freePromptEligible ?? false)}>
            <FreePromptRegion boot={freePromptChat} live={freePromptEligible}>{renderNotice}</FreePromptRegion>
          </Suspense>
        })}
        <div
          aria-live="polite"
          className={
            attachmentError || generationError ? 'min-h-4 px-2 pt-1 text-center text-xs leading-4 text-muted-foreground' : 'sr-only'
          }
        >
          {attachmentError || generationError}
        </div>
      </div>
    </div>
  )
}
