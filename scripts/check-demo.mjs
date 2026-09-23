import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const svgPath = resolve(process.argv[2] ?? join(root, "docs/assets/demo.svg"));
const svg = readFileSync(svgPath, "utf8");
const port = 9229;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "about:blank",
], { stdio: "ignore" });
let ws;
let sequence = 0;
let failed = false;
const pending = new Map();

const request = (method, params = {}) => new Promise((resolveResult, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: resolveResult, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
try {
  let target;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page"); } catch {}
    if (target) break;
    await sleep(100);
  }
  if (!target) throw new Error("headless Chrome did not expose a page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { ws.addEventListener("open", resolveOpen); ws.addEventListener("error", rejectOpen); });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
  });
  const page = `<!doctype html><style>html,body{margin:0;background:white}svg{display:block;width:680px;height:400px}</style>${svg}`;
  await request("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` });
  await sleep(100);
const duration = Number(svg.match(/animation:k0 ([0-9.]+)s/)?.[1] ?? 37.9);
const knownOpacityReveal = /class="c6[78]"[^>]*opacity="0"/.test(svg);
  const samples = [];
  for (let t = 0; t <= duration * 2 + 0.001; t += 0.05) samples.push(Number(t.toFixed(2)));
  for (const t of samples) {
    const result = await request("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(() => {
      const ms = (${t} % 37.9) * 1000; document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; });
      const body = [...document.querySelectorAll('rect')].find((r) => r.getAttribute('width') === '232' && r.getAttribute('height') === '324');
      const br = body.getBoundingClientRect();
      const alpha = (el) => { let a=1; for(let n=el;n&&n.nodeType===1;n=n.parentElement){const cs=getComputedStyle(n); a*=Number(cs.opacity||1)*Number(cs.fillOpacity||1);} return a; };
      const lead = [...document.querySelectorAll('text')].map((el,index)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);const text=el.textContent.trim();return {index,text,x:r.x,y:r.y,w:r.width,h:r.height,opacity:alpha(el),visibility:cs.visibility,inside:!!el.closest('.c71'),excluded:!!el.closest('.c23,.c30,.c37')||['hive','one store, many sessions','lead'].includes(text),start:r.x<br.x+8};}).filter((x)=>!x.excluded&&x.x<br.right+2&&x.x+x.w>br.x-2&&x.y>br.y-80&&x.y<br.bottom+80);
      const rawLead = [...document.querySelectorAll('text')].map((el)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);const text=el.textContent.trim();return {text,x:r.x,y:r.y,w:r.width,h:r.height,opacity:alpha(el),visibility:cs.visibility,start:r.x<br.x+8,excluded:!!el.closest('.c23,.c30,.c37')||['hive','one store, many sessions','lead'].includes(text)};}).filter((x)=>!x.excluded&&x.x<br.right+20&&x.x+x.w>br.x-20&&x.y>br.y-120&&x.y<br.bottom+120);
      const covers = [...document.querySelectorAll('[class^="c"]')].map((el)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,opacity:Number(cs.opacity),fill:cs.fill};}).filter((x)=>x.opacity>.01&&x.fill==='rgb(20, 26, 34)'&&x.right-x.x>100);
      const covered = (line) => covers.some((c)=>c.y < line.y+line.h && c.bottom > line.y && c.x <= line.x+1 && c.right >= line.x+line.w-1);
      const visibleLead = lead.filter((line) => line.opacity > .05 && line.visibility !== 'hidden' && !covered(line));
      const cursorEls = [...document.querySelectorAll('.c15,.c16')];
      const cursors = cursorEls.map((el) => { const r=el.getBoundingClientRect(),cs=getComputedStyle(el); return {x:r.x,y:r.y,w:r.width,h:r.height,opacity:Number(cs.opacity),visibility:cs.visibility,inside:!!el.closest('.c71')}; }).filter((x) => x.opacity > .05 && x.visibility !== 'hidden');
      const rows=[]; for(const line of visibleLead){const center=line.y+line.h/2; if(!rows.some((y)=>Math.abs(y-center)<7)) rows.push(center);}
      const out=[];
      if(document.querySelector('.c67,.c68,.c69')) out.push('tail-opacity-early');
      const tailVisible=[...document.querySelectorAll('text')].map((el)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);return {text:el.textContent.trim(),x:r.x,y:r.y,w:r.width,h:r.height,opacity:alpha(el),visibility:cs.visibility};}).filter((x)=>/What would you like|Top of the board|^ go$/.test(x.text)&&x.opacity>.05&&x.visibility!=='hidden'&&!covered(x));
      const tailStarts=duration>35?[28.645,31.865,34.725]:[26.4,28.4,30.4]; const tm=(${t}%duration); for(const line of tailVisible){const n=line.text.startsWith('What')?0:line.text.startsWith('Top')?1:2; if(tm<tailStarts[n]) out.push('tail-early:'+line.text);}
      for(const el of document.querySelectorAll('.c67,.c68,.c69')){if(alpha(el)>.05)out.push('tail-opacity-early:'+el.textContent.trim());}
      const status=document.querySelector('text[y="274"]'); for(const el of document.querySelectorAll('text')) if(/What would you like|Top of the board/.test(el.textContent)&&el.getAttribute('y')==='274') out.push('line-overlap-rendered:'+el.textContent.trim());
      const cursorRows = rows.concat(rows.length ? [Math.max(...rows)+23.3] : []);
      for(const c of cursors){const cy=c.y+c.h/2; const row=cursorRows.reduce((best,y)=>Math.abs(y-cy)<Math.abs(best-cy)?y:best,cursorRows[0]??cy); if(Math.abs(row-cy)>40) out.push('cursor-y:'+Math.round(cy)+' nearest:'+Math.round(row));}
      for(let i=0;i<lead.length;i++) for(let j=i+1;j<lead.length;j++){const a=lead[i],b=lead[j]; const vy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y),hx=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x); if(a.opacity>.05&&b.opacity>.05&&vy>2&&hx>2&&a.start&&b.start) out.push('line-overlap:'+a.text+'|'+b.text);}
      for(let i=0;i<rawLead.length;i++) for(let j=i+1;j<rawLead.length;j++){const a=rawLead[i],b=rawLead[j]; const vy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y),hx=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x); if(a.opacity>.001&&b.opacity>.001&&vy>2&&hx>2&&a.start&&b.start) out.push('line-overlap-raw:'+a.text+'|'+b.text);}
      const wanted=['human:','3/3 done','What would you like to work on next?','Top of the board: auth tests','human:']; const starts=wanted.map((label)=>visibleLead.find((line)=>line.start&&line.text.includes(label))); for(let i=1;i<starts.length;i++) if(starts[i]&&!starts[i-1]) out.push('order-before:'+wanted[i]);
      for(const line of visibleLead) if(!line.inside&&(line.y<br.y+24||line.y+line.h>br.bottom-2)) out.push('outside:'+line.text);
      return out;
    })()` });
    for (const violation of result.result.value ?? []) { console.log(`FAIL t=${t.toFixed(2)} ${violation}`); failed = true; }
    if (knownOpacityReveal && t === 0) { console.log('FAIL t=0.00 tail-opacity-reveal'); failed = true; }
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) { console.error(`checker error: ${error.message}`); process.exitCode = 1; }
finally { ws?.close(); chrome.kill(); }
