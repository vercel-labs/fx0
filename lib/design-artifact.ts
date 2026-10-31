// @ts-expect-error Node strip-types tests require the source extension.
import { MAX_RENDER_HTML_LENGTH, previewUpdateRuntime, type PreviewPayload } from './preview-update.ts'

export const MAX_DESIGN_ARTIFACT_BYTES = 512 * 1024
export const MAX_REMOTE_IMAGE_URL_LENGTH = 2048

export function remoteImagesEnabled(): boolean {
  return process.env.FX0_REMOTE_IMAGES !== '0'
}

/** A remote image fx0 may fetch: absolute https, no credentials, bounded; else null. */
export function remoteImageUrl(value: string): string | null {
  if (!/^https:\/\//i.test(value) || value.length > MAX_REMOTE_IMAGE_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
  return url.href.length <= MAX_REMOTE_IMAGE_URL_LENGTH ? url.href : null
}

// An image the user attached, stored by fx0 (lib/design-assets.ts) and named in a design
// as fx0-asset:<id>. Like a remote image it is embedded before the design runs.
const ASSET_REFERENCE = /^fx0-asset:[A-Za-z0-9_-]{24}$/
export function assetReference(value: string): string | null {
  return ASSET_REFERENCE.test(value) ? value : null
}

// Google Fonts, the one remote stylesheet a design may name. Like a remote image it is
// fetched and embedded before the design runs (lib/google-fonts.ts); it is never an image.
export const MAX_FONT_STYLESHEETS = 4
// It must name a family: an unquoted href ends at its first "=" in fx0's parser.
const GOOGLE_FONTS_STYLESHEET = /^https:\/\/fonts\.googleapis\.com\/css2?\?(?:[^\s"'<>()\\]*&)?family=[^\s"'<>()\\]+$/
const GOOGLE_FONTS_ORIGIN = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/?$/
export function googleFontsStylesheetUrl(value: string): string | null {
  const url = value.trim()
  return url.length <= MAX_REMOTE_IMAGE_URL_LENGTH && GOOGLE_FONTS_STYLESHEET.test(url) ? url : null
}

// Anything the design may name as an image besides data:, as the rewriter sees it.
const imageReference = (value: string) => assetReference(value) ?? (googleFontsStylesheetUrl(value) ? null : remoteImageUrl(value))

export const DESIGN_ARTIFACT_EMBEDDED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// The wrapper that frames the design. Its blob: frame inherits this policy on top of
// the embedded one, so anything the design may load must be allowed here too.
// `imageRoute` is the absolute /api/artifact-image URL the wrapper itself loads a
// design's images from; the design's own policy still allows it no connection.
export function designFrameCsp(imageRoute?: string): string {
  return [
    "default-src 'none'",
    'frame-src blob:',
    ...(imageRoute ? [`connect-src ${imageRoute}`] : []),
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export const DESIGN_FRAME_CSP = designFrameCsp()
// Counted per place an image is written, so a repeated image cannot expand the design past it.
export const MAX_EMBEDDED_IMAGE_BYTES = 4 * 1024 * 1024

// The screenshot hook. `relay` is wrapper script, run before the design loads; `script`
// returns the capture runtime for a child document carrying the given token.
export interface DesignFrameCapture {
  relay: string
  script?: (readyToken: string) => string
}

// The page artifact-frame serves under designFrameCsp(): it frames the prepared design
// and relays its heartbeat, paint and link messages to the app. Each image marker in the
// design becomes its image, loaded from `src` (cached by the browser across revisions),
// within MAX_EMBEDDED_IMAGE_BYTES counted per occurrence; a missing image is blank. Only
// then does the design start, so it never needs the network. `capture` is the screenshot
// hook (lib/design-capture.ts): its relay runs in this wrapper, and every child document
// the wrapper builds from a preview gets the runtime bound to that child's own token.
export function designFrameHtml(preparedArtifact: string, readyToken: string, images: { marker: string; src: string }[] = [], preview?: PreviewPayload, capture?: DesignFrameCapture): string {
  // The design reaches its frame as a blob: URL the wrapper makes from this string,
  // not as a data: URL: browsers refuse data: URLs past 2 MiB, which embedded images
  // reach. A blob: document is local like data:, so it inherits this wrapper's CSP and
  // resolves no relative URLs against fx0. "<" is escaped so the string cannot end the script.
  const serializedArtifact = JSON.stringify(preparedArtifact).replace(/</g, '\\u003c')
  const serializedReadyToken = JSON.stringify(readyToken)
  const serializedImages = JSON.stringify(images).replace(/</g, '\\u003c')
  const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  const bootstrapToken = 'fx0-bootstrap-token'
  const childBootstrap = scriptJson(designArtifactBootstrap(bootstrapToken))
  const childCsp = scriptJson(`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(DESIGN_ARTIFACT_EMBEDDED_CSP)}">`)
  const updater = scriptJson(previewUpdateRuntime.toString())
  // Built once with a placeholder token, then bound in the browser to each child's token: a
  // child rebuilt by a restore must not keep the token of the document it replaced.
  const runtimeToken = 'fx0-runtime-token'
  const runtimeJs = capture?.script ? scriptJson(capture.script(runtimeToken)) : 'null'
  const runtimeTarget = scriptJson(JSON.stringify(runtimeToken))
  // The wrapper paints nothing of its own, so a design that has not painted yet
  // shows the app's background. Sharing the app's color scheme keeps it
  // transparent; a design that sets no background still gets the browser's white.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design artifact preview</title>
<style>:root{color-scheme:light dark}html,body,#frame-root,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style>
</head>
<body>
<div id="frame-root"></div>
<script>
const design=${serializedArtifact};
const images=${serializedImages};
const preview=${scriptJson(preview ?? null)};
let artifact=null;
let token=${serializedReadyToken};
let documentId=token;
let current=null;
let pending=null;
let hotReady=false;
let hasPainted=false;
let hasLoaded=false;
const frame=document.createElement('iframe');
frame.title='Interactive design artifact';
frame.setAttribute('sandbox','allow-scripts');
frame.referrerPolicy='no-referrer';
frame.setAttribute('credentialless','');
let readySignals=0;
let consumedSignals=0;
let lastHeartbeat=Date.now();
// A capture can hold off restores while the design is busy photographing itself (lib/design-capture.ts).
let holdUntil=0;
// The capture runtime, bound to each child's own token by the restore that builds that child.
const captureRuntimeJs=${runtimeJs};
const safe=value=>JSON.stringify(value).replaceAll('<',String.fromCharCode(92)+'u003c');
// A child's rAF can run before this wrapper finishes loading. Revealing that
// still-loading wrapper exposes the app background (black in dark mode).
const painted=()=>{if(hasLoaded)parent.postMessage(preview?{type:'fx0-artifact-painted',protocol:1,sessionId:preview.sessionId,revision:current.revision,documentId,updateReady:hotReady}:{type:'fx0-artifact-painted'},location.origin);};
addEventListener('load',()=>{hasLoaded=true;if(hasPainted)painted();},{once:true});
const reply=(task,status,reason)=>parent.postMessage({type:'fx0-preview-result',protocol:1,sessionId:preview.sessionId,requestId:task.requestId,documentId:task.documentId,revision:task.payload.revision,status,...(reason?{reason}:{})},location.origin);
const finish=(task,status,reason)=>{if(pending!==task)return;pending=null;task.controller.abort();reply(task,status,reason);};
const restore=()=>{
  if(!current)return;
  if(pending)finish(pending,'reload','document-restarted');
  hotReady=hasPainted=false;readySignals=consumedSignals=0;lastHeartbeat=Date.now();
  let html=current.renderHtml;
  if(preview){
    documentId=token=crypto.randomUUID();
    const seed={sessionId:preview.sessionId,revision:current.revision,sourceHtml:current.sourceHtml,renderHtml:html,documentId,parentOrigin:location.origin,token};
    const bootstrap=${childBootstrap}.replace(${scriptJson(JSON.stringify(bootstrapToken))},JSON.stringify(token));
    const runtime=captureRuntimeJs?captureRuntimeJs.replaceAll(${runtimeTarget},JSON.stringify(token)):'';
    html='<!doctype html>'+${childCsp}+bootstrap+runtime+'<script>('+${updater}+')('+safe(seed)+')</scr'+'ipt>'+html.slice('<!doctype html>'.length);
  }
  const previous=artifact;
  artifact=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  frame.src=artifact;
  if(previous)URL.revokeObjectURL(previous);
};
const validPayload=value=>value&&value.protocol===1&&value.sessionId===preview.sessionId&&Number.isSafeInteger(value.revision)&&value.revision>0&&typeof value.sourceHtml==='string'&&new TextEncoder().encode(value.sourceHtml).length<=${MAX_DESIGN_ARTIFACT_BYTES}&&typeof value.renderHtml==='string'&&value.renderHtml.length<=${MAX_RENDER_HTML_LENGTH}&&Array.isArray(value.images)&&value.images.length<=12&&value.images.every(image=>{
  if(!image||typeof image.marker!=='string'||!image.marker||image.marker.length>256||typeof image.src!=='string')return false;
  try{const url=new URL(image.src,location.href);return url.origin===location.origin&&url.pathname==='/api/artifact-image'&&!url.username&&!url.password;}catch{return false;}
});
addEventListener('message',event=>{
  const data=event.data;
  if(event.source===parent&&event.origin===location.origin&&preview){
    if(data?.type==='fx0-preview-status'&&data.protocol===1){if(hasPainted)painted();return;}
    if(!data||data.protocol!==1||data.documentId!==documentId||typeof data.requestId!=='string'||!data.requestId||data.requestId.length>128)return;
    if(data.type==='fx0-preview-cancel'){
      if(pending&&pending.requestId===data.requestId&&pending.phase==='prepare')finish(pending,'error','cancelled');
      return;
    }
    if(data.type!=='fx0-preview-update'||!validPayload(data.payload))return;
    const task={requestId:data.requestId,documentId,payload:data.payload,controller:new AbortController(),phase:'prepare',remaining:5000};
    if(pending){reply(task,'error','update-busy');return;}
    if(!hotReady||data.baseRevision!==current.revision||data.payload.revision<=current.revision){reply(task,'reload','stale-base-revision');return;}
    pending=task;
    prepare(task.payload,task.controller).then(renderHtml=>{
      if(pending!==task||documentId!==task.documentId)return;
      task.renderHtml=renderHtml;task.phase='apply';
      frame.contentWindow.postMessage({type:'fx0-preview-apply',protocol:1,token,documentId,requestId:task.requestId,baseRevision:current.revision,revision:task.payload.revision,sourceHtml:task.payload.sourceHtml,renderHtml},'*');
    }).catch(()=>finish(task,'error','preparation-failed'));
    return;
  }
  if(event.source!==frame.contentWindow||data?.token!==token)return;
  lastHeartbeat=Date.now();
  if(data.type==='ready')readySignals++;
  if(data.type==='fx0-preview-ready'&&data.protocol===1&&data.documentId===documentId&&data.revision===current?.revision){hotReady=data.ready===true;return;}
  if(data.type==='fx0-preview-result'&&data.protocol===1&&data.documentId===documentId){
    const task=pending;
    if(!task||task.phase!=='apply'||data.requestId!==task.requestId)return;
    if(data.status==='applied'&&data.revision===task.payload.revision){
      current={sourceHtml:task.payload.sourceHtml,renderHtml:task.renderHtml,revision:task.payload.revision};
      finish(task,'applied');
    }else if(data.status==='reload'){
      hotReady=false;
      finish(task,'reload',typeof data.reason==='string'?data.reason.slice(0,120):'incompatible-update');
    }
    return;
  }
  // Paint and link messages are observations, never authority to fetch or mutate the host.
  if(data.type==='painted'){hasPainted=true;painted();}
  if(data.type==='open'&&typeof data.url==='string'&&navigator.userActivation?.isActive!==false){
    parent.postMessage({type:'fx0-artifact-open',url:data.url},location.origin);
  }
});
frame.addEventListener('load',()=>{
  const loadedDocument=documentId;
  setTimeout(()=>{
    if(loadedDocument!==documentId)return;
    if(readySignals>consumedSignals){consumedSignals=readySignals;return;}
    restore();
  },100);
});
// Hidden time and suspended timers are browser pauses, not design failures.
let lastCheck=Date.now();
document.addEventListener('visibilitychange',()=>{lastHeartbeat=lastCheck=Date.now();});
setInterval(()=>{
  const now=Date.now(),elapsed=now-lastCheck,paused=elapsed>3000;
  lastCheck=now;
  if(document.visibilityState!=='visible'||paused){lastHeartbeat=now;return;}
  if(pending?.phase==='apply'){
    pending.remaining-=Math.max(0,elapsed);
    if(pending.remaining<=0){finish(pending,'reload','application-timeout');restore();return;}
  }
  if(now-lastHeartbeat>3000&&now>holdUntil)restore();
},500);
${capture?.relay ?? ''}
const read=(blob,signal)=>new Promise(done=>{
  const reader=new FileReader();
  const abort=()=>{reader.abort();complete(null);};
  const complete=value=>{signal.removeEventListener('abort',abort);reader.onload=reader.onerror=reader.onabort=null;done(value);};
  reader.onload=()=>complete(String(reader.result));reader.onerror=reader.onabort=()=>complete(null);
  if(signal.aborted){complete(null);return;}
  signal.addEventListener('abort',abort,{once:true});reader.readAsDataURL(blob);
});
const load=async(src,signal,deadline)=>{
  try{
    const response=await fetch(src,{credentials:'same-origin',signal});
    if(!response.ok)return null;
    const blob=await response.blob();
    if(signal.aborted||Date.now()>=deadline||!/^image\\/(png|jpeg|gif|webp|avif)$/.test(blob.type))return null;
    const data=await read(blob,signal);
    return !signal.aborted&&Date.now()<deadline?data:null;
  }catch{return null;}
};
const prepare=async(payload,controller)=>{
  const deadline=Date.now()+10000;
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const loaded=await Promise.all(payload.images.map(image=>load(image.src,controller.signal,deadline)));
    let html=payload.renderHtml,total=0;
    payload.images.forEach((image,index)=>{
      const data=loaded[index],size=data?(data.length-data.indexOf(',')-1)*3/4-(data.endsWith('==')?2:data.endsWith('=')?1:0):0;
      html=html.split(image.marker).map((part,at)=>at===0?part:(data&&total+size<=${MAX_EMBEDDED_IMAGE_BYTES}?(total+=size,data):${JSON.stringify(BLANK_IMAGE)})+part).join('');
    });
    return html;
  }finally{clearTimeout(timer);}
};
const initialController=new AbortController();
let disposed=false;
addEventListener('pagehide',()=>{disposed=true;initialController.abort();if(pending)finish(pending,'error','unmounted');if(artifact)URL.revokeObjectURL(artifact);});
const initial=preview??{renderHtml:design,sourceHtml:design,revision:0,images};
prepare(initial,initialController).then(renderHtml=>{
  if(disposed)return;
  current={sourceHtml:initial.sourceHtml,renderHtml,revision:initial.revision};
  restore();
  document.querySelector('#frame-root').append(frame);
});
</script>
</body>
</html>`
}

function designArtifactBootstrap(readyToken?: string): string {
  // The sandbox grants no popups, so a clicked https link asks the app to open it
  // (see app/api/artifact-frame): the app shows the address and opens it only on the
  // user's own click there, instead of the design navigating the preview away.
  const heartbeat = readyToken
    ? `const token=${JSON.stringify(readyToken)};const send=type=>parent.postMessage({type,token},"*");send("heartbeat");setInterval(()=>send("heartbeat"),500);addEventListener("load",()=>{send("ready");requestAnimationFrame(()=>requestAnimationFrame(()=>send("painted")))},{once:true});addEventListener("click",event=>{const link=event.target instanceof Element&&event.target.closest("a[href]");const url=link?link.getAttribute("href")||"":"";if(/^https:/i.test(url)){event.preventDefault();parent.postMessage({type:"open",token,url},"*")}},true);`
    : ''
  return `<script>(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","RTCIceGatherer"]){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false})}catch{}}${heartbeat}})()</script>`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const DOCTYPE = '<!doctype html>'

// The one form of a design that is validated, stored, and rendered. Before the
// doctype the HTML parser ignores only ASCII whitespace; anything else, such as
// U+00A0 or U+FEFF, starts the body, so a CSP placed after the doctype would be
// ignored. Trimming the ends and rewriting the doctype leaves it first, exactly.
export function normalizeDesignArtifactHtml(html: string): string {
  return html.trim().replace(/^<!doctype\s+html\s*>/i, DOCTYPE)
}

// The CSP and bootstrap go right after the doctype, so they are the first things
// the parser puts in <head>. A design stored before normalization renders the same
// way; one without a doctype is not rendered at all (null), never without its CSP.
// `scripts` follow the bootstrap, under the same CSP (lib/design-capture.ts).
export function prepareDesignArtifactHtml(html: string, embeddedCsp?: string, readyToken?: string, scripts = ''): string | null {
  const document = normalizeDesignArtifactHtml(html)
  if (!document.startsWith(DOCTYPE)) return null
  const csp = embeddedCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(embeddedCsp)}">`
    : ''
  return DOCTYPE + csp + designArtifactBootstrap(readyToken) + scripts + document.slice(DOCTYPE.length)
}

// The start of a document, with invisible characters spelled out, so a rejected
// publish says exactly what came before the doctype.
function visibleStart(html: string): string {
  const start = html.length > 24 ? `${html.slice(0, 24)}…` : html
  return JSON.stringify(start).replace(/[^\x20-\x7e…]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// `html` is the normalized document: the exact value to store.
export type DesignArtifactValidation = { ok: true; bytes: number; html: string } | { ok: false; error: string }

// Where an attribute's raw value sits in the source, quotes included, so a prepared
// copy can replace exactly that value.
interface SourceRange {
  start: number
  end: number
}

interface HtmlTag {
  name: string
  // The whole opening tag.
  range: SourceRange
  attributes: Map<string, string>
  valueRanges: Map<string, SourceRange>
  duplicateAttribute: string | null
  // The raw text of a <style> element.
  content?: SourceRange
}

const PROHIBITED_TAGS = new Map([
  ['base', '<base> elements'],
  ['form', 'forms'],
  ['iframe', '<iframe> elements'],
  ['object', '<object> elements'],
  ['embed', '<embed> elements'],
])

function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function parseAttributes(source: string, offset: number): Pick<HtmlTag, 'attributes' | 'valueRanges' | 'duplicateAttribute'> {
  const attributes = new Map<string, string>()
  const valueRanges = new Map<string, SourceRange>()
  let duplicateAttribute: string | null = null
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/dg
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase()
    if (name === '/') continue
    if (attributes.has(name)) {
      duplicateAttribute ??= name
      continue
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
    const quoted = match.indices![2] ?? match.indices![3]
    const bare = match.indices![4]
    if (quoted) valueRanges.set(name, { start: offset + quoted[0] - 1, end: offset + quoted[1] + 1 })
    else if (bare) valueRanges.set(name, { start: offset + bare[0], end: offset + bare[1] })
  }
  return { attributes, valueRanges, duplicateAttribute }
}

function parseOpeningTags(source: string): HtmlTag[] {
  const tags: HtmlTag[] = []
  const normalized = source.toLowerCase()
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor)
    if (start < 0) break
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4)
      cursor = end < 0 ? source.length : end + 3
      continue
    }
    const marker = source[start + 1]
    if (!marker || marker === '/' || marker === '!' || marker === '?') {
      cursor = start + 2
      continue
    }
    const nameMatch = source.slice(start + 1).match(/^([a-z][a-z0-9:-]*)/i)
    if (!nameMatch) {
      cursor = start + 1
      continue
    }
    const end = findTagEnd(source, start + 1 + nameMatch[0].length)
    if (end < 0) break
    const name = nameMatch[1].toLowerCase()
    const attributeStart = start + 1 + nameMatch[0].length
    const tag: HtmlTag = { name, range: { start, end: end + 1 }, ...parseAttributes(source.slice(attributeStart, end), attributeStart) }
    tags.push(tag)
    if (name === 'script' || name === 'style') {
      const closing = normalized.indexOf(`</${name}`, end + 1)
      cursor = closing < 0 ? source.length : closing
      if (name === 'style') tag.content = { start: end + 1, end: cursor }
    } else {
      cursor = end + 1
    }
  }
  return tags
}

function decodeCodePoint(digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix)
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd'
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, digits: string) => decodeCodePoint(digits, 16))
    .replace(/&#([0-9]+);?/g, (_, digits: string) => decodeCodePoint(digits, 10))
    .replace(/&(colon|tab|newline|amp);?/gi, (_, entity: string) => {
      const decoded: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', amp: '&' }
      return decoded[entity.toLowerCase()]
    })
    .trim()
}

function compactUrlScheme(value: string): string {
  return decodeAttribute(value)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase()
}

function isEmbeddedSource(tag: string, value: string): boolean {
  const decoded = decodeAttribute(value)
  if (tag === 'img' || tag === 'input') return /^data:image\//i.test(decoded)
  if (tag === 'audio') return /^data:audio\//i.test(decoded)
  if (tag === 'video') return /^data:video\//i.test(decoded)
  if (tag === 'track') return /^data:text\/vtt(?:[;,]|$)/i.test(decoded)
  if (tag === 'source') return /^data:(?:image|audio|video)\//i.test(decoded)
  return false
}

function isEmbeddedSrcset(tag: string, value: string): boolean {
  if (tag !== 'img' && tag !== 'source') return false
  const decoded = decodeAttribute(value)
  const comma = decoded.indexOf(',')
  if (comma < 0 || decoded.indexOf(',', comma + 1) >= 0) return false
  const metadata = decoded.slice(0, comma)
  const payload = decoded.slice(comma + 1)
  return /^data:image\/[a-z0-9.+-]+(?:;[^,\s]*)*$/i.test(metadata) && /^\S+(?:\s+(?:\d+(?:\.\d+)?[wx]))?$/.test(payload)
}

interface SrcsetCandidate {
  url: string
  descriptor: string
}

// A srcset of remote image candidates, split the way the HTML parser splits it (a URL
// runs to whitespace; trailing commas end it), or null when any candidate is not one.
function remoteSrcset(value: string, accept: (url: string) => string | null = imageReference): SrcsetCandidate[] | null {
  const candidates: SrcsetCandidate[] = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++
    if (index >= value.length) break
    const urlStart = index
    while (index < value.length && !/\s/.test(value[index])) index++
    let raw = value.slice(urlStart, index)
    let descriptor = ''
    if (raw.endsWith(',')) {
      raw = raw.replace(/,+$/, '')
    } else {
      const descriptorStart = index
      while (index < value.length && value[index] !== ',') index++
      descriptor = value.slice(descriptorStart, index).trim()
    }
    const url = accept(raw)
    if (!url || !/^(?:\d+(?:\.\d+)?[wx])?$/.test(descriptor)) return null
    candidates.push({ url, descriptor })
  }
  return candidates.length ? candidates : null
}

const remoteImageValue = (rawValue: string) => imageReference(decodeAttribute(rawValue))

// A <link> to Google Fonts: its stylesheet, or a preconnect to its hosts, which models add
// out of habit. Returns the stylesheet URL, '' for a preconnect, or null for any other link.
function googleFontsLink(tag: HtmlTag): string | null {
  if (tag.name !== 'link') return null
  const rel = decodeAttribute(tag.attributes.get('rel') ?? '').toLowerCase().split(/\s+/)
  const href = decodeAttribute(tag.attributes.get('href') ?? '')
  if (rel.includes('stylesheet')) return googleFontsStylesheetUrl(href)
  return (rel.includes('preconnect') || rel.includes('dns-prefetch')) && GOOGLE_FONTS_ORIGIN.test(href) ? '' : null
}

function validateTag(tag: HtmlTag, remote: boolean): string | null {
  const allowed = (value: string) => assetReference(value) ?? (remote ? remoteImageUrl(value) : null)
  const allowedValue = (rawValue: string) => allowed(decodeAttribute(rawValue))
  if (tag.duplicateAttribute) {
    return `design artifact must not repeat the ${tag.duplicateAttribute} attribute`
  }

  const prohibited = PROHIBITED_TAGS.get(tag.name)
  if (prohibited) return `design artifact must not contain ${prohibited}`
  if (tag.name === 'script' && tag.attributes.has('src')) {
    return 'design artifact scripts must be inline'
  }

  if (tag.name === 'meta' && decodeAttribute(tag.attributes.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
    return 'design artifact must not contain meta refresh'
  }

  for (const [name, rawValue] of tag.attributes) {
    const compactValue = compactUrlScheme(rawValue)
    if (compactValue.startsWith('javascript:') || compactValue.startsWith('vbscript:')) {
      return 'design artifact must not use scripted URLs'
    }

    if (name === 'action' || name === 'formaction') {
      return `design artifact must not contain ${name} attributes`
    }
    if (name === 'href' || name === 'xlink:href') {
      const value = decodeAttribute(rawValue)
      const isSafeSvgImage = tag.name === 'image' && (/^data:image\//i.test(value) || !!allowed(value))
      // Links to https pages (cited sources, references) open in a new tab; see the bootstrap.
      const isExternalLink = tag.name === 'a' && name === 'href' && /^https:\/\/[^\s]+$/i.test(value)
      // Google Fonts are embedded before the design runs (lib/google-fonts.ts).
      const isFontLink = remote && name === 'href' && googleFontsLink(tag) != null
      if (!value.startsWith('#') && !isSafeSvgImage && !isExternalLink && !isFontLink) {
        return `design artifact ${name} values must be local fragments, https links, or compatible embedded data: URLs`
      }
    }
    if (name === 'src' && !isEmbeddedSource(tag.name, rawValue) && !(tag.name === 'img' && allowedValue(rawValue))) {
      return remote
        ? 'design artifact src values must be an https image URL on <img> or a compatible embedded data: URL'
        : 'design artifact src values must use a compatible embedded data: URL'
    }
    if (name === 'srcset' && !isEmbeddedSrcset(tag.name, rawValue) &&
      !((tag.name === 'img' || tag.name === 'source') && remoteSrcset(decodeAttribute(rawValue), allowed))) {
      return remote
        ? 'design artifact srcset values must list https image URLs or contain one embedded data:image URL'
        : 'design artifact srcset values must contain one embedded data:image URL'
    }
    if (name === 'poster' && !/^data:image\//i.test(decodeAttribute(rawValue)) && !allowedValue(rawValue)) {
      return remote
        ? 'design artifact poster values must use an https image URL or an embedded data:image URL'
        : 'design artifact poster values must use an embedded data:image URL'
    }
  }

  return null
}

// Prepared copies only: every remote image the markup or its CSS names, in the
// places validation accepts it, becomes `embed(url)`, a data: image URL. The stored
// design is untouched; text, scripts and anything else that merely contains a URL are
// never rewritten. A srcset keeps only its largest candidate, so each image is fetched once.
export function rewriteRemoteImages(html: string, embed: (url: string) => string | null): string {
  const edits: (SourceRange & { text: string })[] = []
  // embed() returning null leaves that reference as written (the export keeps remote URLs).
  const image = (url: string) => { const value = embed(url); return value == null ? null : embeddedImage(value) }
  const lower = html.toLowerCase()
  for (const tag of parseOpeningTags(html)) {
    for (const [name, range] of tag.valueRanges) {
      const raw = tag.attributes.get(name)!
      let url: string | null = null
      if (name === 'src' && tag.name === 'img') url = remoteImageValue(raw)
      else if (name === 'poster' && tag.name === 'video') url = remoteImageValue(raw)
      else if ((name === 'href' || name === 'xlink:href') && tag.name === 'image') url = remoteImageValue(raw)
      else if (name === 'srcset' && (tag.name === 'img' || tag.name === 'source')) url = largestCandidate(decodeAttribute(raw))
      const replacement = url ? image(url) : null
      if (replacement) {
        edits.push({ ...range, text: `"${replacement}"` })
      } else if (name === 'style') {
        const quoted = html[range.start] === '"' || html[range.start] === "'"
        const inner = quoted ? { start: range.start + 1, end: range.end - 1 } : range
        for (const edit of cssUrlEdits(html, lower, inner, true)) { const value = image(edit.url); if (value) edits.push({ ...edit, text: `url(${value})` }) }
      }
    }
    if (tag.content) {
      for (const edit of cssUrlEdits(html, lower, tag.content, false)) { const value = image(edit.url); if (value) edits.push({ ...edit, text: `url(${value})` }) }
    }
  }
  return applyEdits(html, edits)
}

// One pass, so the cost grows with the output, not with the number of edits. An
// insertion (an empty range) goes before a replacement that starts at the same place.
function applyEdits(html: string, edits: (SourceRange & { text: string })[]): string {
  const parts: string[] = []
  let cursor = 0
  for (const edit of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
    parts.push(html.slice(cursor, edit.start), edit.text)
    cursor = edit.end
  }
  parts.push(html.slice(cursor))
  return parts.join('')
}

const GOOGLE_FONTS_IMPORT = /@import\s+(?:url\(\s*(["']?)([^"'()\s]+)\1\s*\)|(["'])([^"'\s]+)\3)[^;{}<]*;?/gi

// The Google Fonts stylesheets a design names, in document order and at most
// MAX_FONT_STYLESHEETS, and the edits that take every reference to them out of a
// prepared copy. A <link> keeps its place with an empty href, which fetches nothing, and
// an @import is removed: no element moves, so live updates still pair the rendered design
// with its source (lib/preview-update.ts).
function googleFontReferences(html: string) {
  const urls: string[] = []
  const edits: (SourceRange & { text: string })[] = []
  let firstStyle: SourceRange | null = null
  let headEnd = -1
  const add = (url: string) => { if (!urls.includes(url) && urls.length < MAX_FONT_STYLESHEETS) urls.push(url) }
  for (const tag of parseOpeningTags(html)) {
    if (tag.name === 'head' && headEnd < 0) headEnd = tag.range.end
    const link = googleFontsLink(tag)
    const href = tag.valueRanges.get('href')
    if (link != null && href) {
      if (link) add(link)
      edits.push({ ...href, text: '""' })
    }
    if (tag.content) {
      firstStyle ??= tag.content
      const css = html.slice(tag.content.start, tag.content.end)
      for (const match of css.matchAll(GOOGLE_FONTS_IMPORT)) {
        const url = googleFontsStylesheetUrl(match[2] ?? match[4])
        if (!url) continue
        add(url)
        const start = tag.content.start + match.index
        edits.push({ start, end: start + match[0].length, text: '' })
      }
    }
  }
  return { urls, edits, firstStyle, headEnd }
}

export function googleFontStylesheets(html: string): string[] {
  return googleFontReferences(html).urls
}

// A prepared copy without its Google Fonts references, with `css` (their embedded faces,
// from lib/google-fonts.ts) first in the design's first <style>, or in a new one at the
// top of <head> when it has none.
export function inlineGoogleFonts(html: string, css: string): string {
  const { urls, edits, firstStyle, headEnd } = googleFontReferences(html)
  // The faces are fx0's own serialization; anything that could close the element is dropped.
  if (urls.length && css && !css.includes('<')) {
    if (firstStyle) edits.push({ start: firstStyle.start, end: firstStyle.start, text: css })
    else if (headEnd >= 0) edits.push({ start: headEnd, end: headEnd, text: `<style>${css}</style>` })
  }
  return edits.length ? applyEdits(html, edits) : html
}

// The embedded value lands unquoted in CSS url() and quoted in attributes, so it must
// be a base64 data: image, whose characters need no escaping in either.
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/
export const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
// A marker the wrapper replaces with its image (see markRemoteImages in remote-image.ts).
const IMAGE_MARKER = /^fx0-image-[0-9a-f]{32}-\d{1,2}$/
function embeddedImage(value: string): string {
  return EMBEDDED_IMAGE.test(value) || IMAGE_MARKER.test(value) ? value : BLANK_IMAGE
}

function largestCandidate(value: string): string | null {
  const candidates = remoteSrcset(value)
  if (!candidates) return null
  const size = ({ descriptor }: SrcsetCandidate) => Number.parseFloat(descriptor) || 1
  return candidates.reduce((best, candidate) => (size(candidate) > size(best) ? candidate : best)).url
}

// In a style attribute the browser decodes character references first, so quotes may
// be spelled as references there.
const ATTRIBUTE_QUOTES = ['"', "'", '&quot;', '&#34;', '&#x22;', '&apos;', '&#39;', '&#x27;']
const STYLE_QUOTES = ['"', "'"]

// The url() tokens in a CSS range whose argument is a remote image URL, skipping
// comments and strings. An argument with a CSS escape is left alone (and stays blocked).
// `lower` is the whole source lowercased once by the caller; every scan stays inside `range`.
function cssUrlEdits(source: string, lower: string, range: SourceRange, inAttribute: boolean): (SourceRange & { url: string })[] {
  const quotes = inAttribute ? ATTRIBUTE_QUOTES : STYLE_QUOTES
  const quoteAt = (index: number) => quotes.find((quote) => lower.startsWith(quote, index))
  // The next ")" at or after a position, remembered: positions only grow, so the
  // whole range is searched once however many url( tokens never close.
  let nextClose = -1
  const closeAfter = (index: number) => {
    if (nextClose < index) {
      nextClose = source.indexOf(')', index)
      if (nextClose < 0 || nextClose >= range.end) nextClose = Number.POSITIVE_INFINITY
    }
    return nextClose
  }
  const edits: (SourceRange & { url: string })[] = []
  let index = range.start
  while (index < range.end) {
    if (lower.startsWith('/*', index)) {
      const close = lower.indexOf('*/', index + 2)
      index = close < 0 || close + 2 > range.end ? range.end : close + 2
      continue
    }
    const quote = quoteAt(index)
    if (quote) {
      index = stringEnd(lower, index + quote.length, quote, range.end)
      continue
    }
    if (lower.startsWith('url(', index) && !/[\w-]/.test(lower[index - 1] ?? '')) {
      const token = cssUrlToken(source, lower, index + 4, range.end, quoteAt, closeAfter)
      if (token) {
        const value = (inAttribute ? decodeAttribute(token.value) : token.value).trim()
        const url = value.includes('\\') ? null : imageReference(value)
        if (url) edits.push({ start: index, end: token.end, url })
        index = token.end
        continue
      }
    }
    index++
  }
  return edits
}

function stringEnd(lower: string, index: number, quote: string, limit: number): number {
  while (index < limit) {
    if (lower[index] === '\\') index += 2
    else if (lower.startsWith(quote, index)) return index + quote.length
    else index++
  }
  return limit
}

function cssUrlToken(source: string, lower: string, index: number, limit: number, quoteAt: (index: number) => string | undefined, closeAfter: (index: number) => number) {
  while (index < limit && /\s/.test(source[index])) index++
  const quote = quoteAt(index)
  let value: string
  if (quote) {
    const close = stringEnd(lower, index + quote.length, quote, limit)
    value = source.slice(index + quote.length, close - quote.length)
    index = close
    while (index < limit && /\s/.test(source[index])) index++
  } else {
    const close = closeAfter(index)
    if (close >= limit) return null
    value = source.slice(index, close)
    index = close
  }
  return source[index] === ')' ? { value, end: index + 1 } : null
}

export function validateDesignArtifactHtml(html: string, { remoteImages = remoteImagesEnabled() } = {}): DesignArtifactValidation {
  const source = normalizeDesignArtifactHtml(html)
  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > MAX_DESIGN_ARTIFACT_BYTES) {
    return { ok: false, error: 'design artifact exceeds 512 KiB' }
  }

  if (source.includes('<!--')) {
    return { ok: false, error: 'design artifact must not contain HTML comments' }
  }
  if (!source.startsWith(DOCTYPE)) {
    return { ok: false, error: `design artifact must start with <!doctype html>, but it starts with ${visibleStart(source)}` }
  }
  const afterDoctype = source.slice(DOCTYPE.length)
  if (/<(?:!|\?)/.test(afterDoctype)) {
    return { ok: false, error: 'design artifact must not contain markup declarations' }
  }

  const requiredTags = ['html', 'head', 'body'] as const
  for (const tag of requiredTags) {
    const openings = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'))?.length ?? 0
    const closings = source.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0
    if (openings !== 1 || closings !== 1) {
      return { ok: false, error: `design artifact must contain exactly one <${tag}> element` }
    }
  }

  if (
    !/<html(?:\s[^>]*)?>[\s\S]*<head(?:\s[^>]*)?>[\s\S]*<\/head\s*>[\s\S]*<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>[\s\S]*<\/html\s*>\s*$/i.test(
      source,
    )
  ) {
    return { ok: false, error: 'design artifact must be one complete html document with head and body' }
  }

  for (const tag of parseOpeningTags(source)) {
    const error = validateTag(tag, remoteImages)
    if (error) return { ok: false, error }
  }

  return { ok: true, bytes, html: source }
}
