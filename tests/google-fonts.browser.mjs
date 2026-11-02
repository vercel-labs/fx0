import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, designFrameCsp, designFrameHtml, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { DESIGN_CAPTURE_RELAY, designCaptureScript } from '../lib/design-capture.ts'
import { compileGoogleFontCss, embedGoogleFonts } from '../lib/google-fonts.ts'

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&display=swap'
const TEXT = 'WWW iii café niño'

test('Google Fonts load and appear in captures after hot edits, history reload and offline export', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  const font = await readFile(new globalThis.URL('./fixtures/fonts/playfair-display-latin-variable.woff2', import.meta.url))
  const css = await compileGoogleFontCss(`/* latin */ @font-face {font-family:'Playfair Display';font-style:normal;font-weight:400 900;src:url(https://fonts.gstatic.com/s/playfair/v1/latin.woff2) format('woff2');}`, async () => font)
  const probeStyle = (revision) => `display:inline-block;font-family:'Playfair Display',monospace;font-weight:700;font-size:${revision === 2 ? 48 : 40}px;line-height:1.5;color:#000`
  const source = (revision) => `<!doctype html><html><head><style media="print">body{color:red}</style><style type="text/plain">not CSS</style><link rel="stylesheet" href="${URL}"><style${revision === 3 ? ' media="print"' : ''}>html,body{margin:0;background:#fff}body{padding:40px}#probe{${probeStyle(revision)}}</style></head><body${revision === 3 ? ' style="margin:0;padding:40px;background:#fff"' : ''}><span id="probe"${revision === 3 ? ` style="${probeStyle(revision)}"` : ''}>${TEXT}</span><script>
addEventListener('message',async event=>{
  if(event.data!=='measure-font')return;
  try {
    const probe=document.getElementById('probe'), style=getComputedStyle(probe);
    await document.fonts.load('700 '+style.fontSize+' "Playfair Display"',probe.textContent);
    const context=document.createElement('canvas').getContext('2d'); context.font='700 '+style.fontSize+' monospace';
    top.postMessage({type:'font-metrics',viewport:innerWidth,width:probe.getBoundingClientRect().width,fallback:context.measureText(probe.textContent).width,loaded:[...document.fonts].some(face=>face.family.includes('Playfair Display')&&face.status==='loaded')},'*');
  }catch(error){top.postMessage({type:'font-metrics',error:String(error)},'*');}
});
addEventListener('securitypolicyviolation',event=>top.postMessage({type:'font-csp',blocked:event.blockedURI},'*'));
</script></body></html>`
  const payloads = new Map()
  for (const revision of [1, 2, 3]) {
    const html = source(revision)
    const checked = validateDesignArtifactHtml(html)
    assert.equal(checked.ok, true, checked.error)
    const renderHtml = await embedGoogleFonts(html, async () => css)
    assert.doesNotMatch(renderHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
    payloads.set(revision, { protocol: 1, sessionId: 'font-test', revision, sourceHtml: html, renderHtml, images: [] })
  }
  const exported = await embedGoogleFonts(source(3), async () => css)
  const outPage = `<!doctype html><html><body><pre id="out">{}</pre><iframe id="preview" style="width:800px;height:400px"></iframe><script>
const out={metrics:{},shots:{},violations:[]}, waits=[];
const frame=document.getElementById('preview');
const next=test=>new Promise(resolve=>waits.push({test,resolve}));
const bounded=(p,label)=>Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject(new Error(label+' timed out')),10000))]);
addEventListener('message',({data,source})=>{
  if(data?.type==='font-csp')out.violations.push(data.blocked);
  const index=waits.findIndex(wait=>wait.test(data,source));
  if(index>=0)waits.splice(index,1)[0].resolve(data);
});
const child=()=>frame.contentDocument.querySelector('#frame-root iframe');
const open=async(revision,hot=true)=>{
  const ready=next((data,source)=>source===frame.contentWindow&&data?.type==='fx0-artifact-painted'&&(!hot||data.updateReady));
  frame.src='/frame?rev='+revision;
  return bounded(ready,'preview');
};
const measure=async target=>{
  const reply=next((data,source)=>source===target.contentWindow&&data?.type==='font-metrics');
  target.contentWindow.postMessage('measure-font','*');
  return bounded(reply,'font metrics');
};
const shot=async name=>{
  const reply=next((data,source)=>source===frame.contentWindow&&data?.type==='fx0-artifact-captured'&&data.cid===name);
  frame.contentWindow.postMessage({type:'fx0-capture',cid:name,full:false},location.origin);
  const data=await bounded(reply,'screenshot');
  if(data.error)throw new Error(data.error);
  const image=await createImageBitmap(data.blobs[0]);
  const canvas=new OffscreenCanvas(image.width,image.height), context=canvas.getContext('2d');context.drawImage(image,0,0);
  const pixels=context.getImageData(0,0,image.width,180).data;
  let min=image.width,max=-1;
  for(let y=35;y<160;y++)for(let x=30;x<image.width;x++){
    const at=(y*image.width+x)*4;
    if(pixels[at]<80&&pixels[at+1]<80&&pixels[at+2]<80){min=Math.min(min,x);max=Math.max(max,x);}
  }
  return {inkWidth:max-min+1,width:image.width,height:image.height};
};
(async()=>{
  const first=await open(1);
  out.metrics.initial=await measure(child());out.shots.initial=await shot('initial');
  const payload=await(await fetch('/payload')).json(), requestId='font-hot-update';
  const applied=next((data,source)=>source===frame.contentWindow&&data?.type==='fx0-preview-result'&&data.requestId===requestId);
  frame.contentWindow.postMessage({type:'fx0-preview-update',protocol:1,requestId,documentId:first.documentId,baseRevision:1,payload},location.origin);
  out.update=await bounded(applied,'update');
  out.metrics.edited=await measure(child());out.shots.edited=await shot('edited');
  await open(1);
  out.metrics.history=await measure(child());out.shots.history=await shot('history');
  const conditional=await open(3,false);out.conditionalUpdateReady=conditional.updateReady;
  out.metrics.conditional=await measure(child());out.shots.conditional=await shot('conditional');
  const download=await(await fetch('/export')).text();
  const saved=document.createElement('iframe'); saved.style.cssText='width:800px;height:400px';saved.setAttribute('sandbox','allow-scripts');document.body.append(saved);
  const loaded=new Promise(resolve=>saved.onload=resolve);saved.srcdoc=download;await bounded(loaded,'export');
  out.metrics.export=await measure(saved);
})().then(()=>out.done=true,error=>out.error=String(error)).then(()=>{
  document.getElementById('out').textContent=JSON.stringify(out);return fetch('/done');
});
</script><img src="/hold" alt=""></body></html>`
  const requests = [], holds = []
  const server = http.createServer((request, response) => {
    const path = new globalThis.URL(request.url, 'http://test')
    requests.push(path.pathname)
    if (path.pathname === '/frame') {
      const payload = payloads.get(Number(path.searchParams.get('rev')))
      const token = crypto.randomUUID()
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': designFrameCsp() })
      return response.end(designFrameHtml(prepareDesignArtifactHtml(payload.renderHtml, DESIGN_ARTIFACT_EMBEDDED_CSP, token), token, [], payload, { relay: DESIGN_CAPTURE_RELAY, script: designCaptureScript }))
    }
    if (path.pathname === '/payload') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payloads.get(2)))
    if (path.pathname === '/export') return response.writeHead(200, { 'content-type': 'text/plain' }).end(prepareDesignArtifactHtml(exported, DESIGN_ARTIFACT_EMBEDDED_CSP))
    if (path.pathname === '/hold') {
      holds.push(response)
      setTimeout(() => { if (!response.writableEnded) response.writeHead(404).end() }, 30000).unref()
      return
    }
    if (path.pathname === '/done') {
      for (const held of holds) if (!held.writableEnded) held.writeHead(404).end()
      return response.writeHead(204).end()
    }
    if (path.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(outPage)
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'fx0-fonts-browser-'))
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.equal(out.error, undefined, out.error)
    assert.equal(out.done, true)
    assert.equal(out.update.status, 'applied', JSON.stringify(out.update))
    assert.equal(out.conditionalUpdateReady, false, 'an inserted font style safely uses reloads instead of hot updates')
    assert.deepEqual(out.violations, [])
    for (const [name, metrics] of Object.entries(out.metrics)) {
      assert.equal(metrics.viewport, 800, `${name}: compare at the same CSS viewport`)
      assert.equal(metrics.loaded, true, `${name}: the real font loaded`)
      assert.ok(Math.abs(metrics.width - metrics.fallback) > 15, `${name}: the fallback must not pass`)
      if (out.shots[name]) {
        assert.deepEqual([out.shots[name].width, out.shots[name].height], [800, 400])
        assert.ok(Math.abs(out.shots[name].inkWidth - metrics.width) < 16, `${name}: screenshot glyph width ${out.shots[name].inkWidth} vs DOM ${metrics.width}`)
      }
    }
    assert.equal(out.metrics.history.width, out.metrics.initial.width)
    assert.equal(out.metrics.export.width, out.metrics.initial.width)
    assert.ok(Math.abs(out.metrics.edited.width / out.metrics.initial.width - 1.2) < 0.01)
    assert.ok(requests.every(path => ['/', '/frame', '/payload', '/export', '/hold', '/done', '/favicon.ico'].includes(path)), JSON.stringify(requests))
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
