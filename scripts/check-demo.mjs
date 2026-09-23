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
  const duration = 37.9;
  const samples = [];
  for (let t = 0; t <= duration * 2 + 0.001; t += 0.05) samples.push(Number(t.toFixed(2)));
  for (const t of samples) {
    const result = await request("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(() => {
      const ms = (${t} % 37.9) * 1000; document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; });
      const body = [...document.querySelectorAll('rect')].find((r) => r.getAttribute('width') === '232' && r.getAttribute('height') === '324');
      const br = body.getBoundingClientRect();
      const alpha = (el) => { let a=1; for(let n=el;n&&n.nodeType===1;n=n.parentElement){const cs=getComputedStyle(n); a*=Number(cs.opacity||1)*Number(cs.fillOpacity||1);} return a; };
      const texts = [...document.querySelectorAll('text')].map((el, index) => { const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return {index,text:el.textContent.trim(),x:r.x,y:r.y,w:r.width,h:r.height,opacity:alpha(el),visibility:cs.visibility,excluded:!!el.closest('.c23,.c30,.c37')}; }).filter((x) => x.opacity > .05 && x.visibility !== 'hidden' && !x.excluded && x.x >= br.x-2 && x.x < br.right+2 && x.y > br.y+20 && x.y < br.bottom+20);
      const lead = texts.filter((x) => x.x < br.right+2 && x.x+x.w > br.x-2 && x.y > br.y+20 && x.y < br.bottom+40).map((x) => ({...x,start:x.x < br.x+8}));
      const covers = [...document.querySelectorAll('[class^="c"]')].map((el)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,opacity:Number(cs.opacity),fill:cs.fill};}).filter((x)=>x.opacity>.01&&x.fill==='rgb(20, 26, 34)'&&x.right-x.x>100);
      const covered = (line) => covers.some((c)=>c.y < line.y+line.h && c.bottom > line.y && c.x <= line.x+1 && c.right >= line.x+line.w-1);
      const visibleLead = lead.filter((line) => !covered(line));
      const cursorEls = [...document.querySelectorAll('.c15,.c16')];
      const cursors = cursorEls.map((el) => { const r=el.getBoundingClientRect(),cs=getComputedStyle(el); return {x:r.x,y:r.y,w:r.width,h:r.height,opacity:Number(cs.opacity),visibility:cs.visibility,inside:!!el.closest('.c71')}; }).filter((x) => x.opacity > .05 && x.visibility !== 'hidden');
      const rows=[]; for(const line of lead){const center=line.y+line.h/2; if(!rows.some((y)=>Math.abs(y-center)<7)) rows.push(center);}
      const out=[];
      const tailEls = [...document.querySelectorAll('text')].filter((el)=>/What would you like|Top of the board|^ go$/.test(el.textContent.trim()));
      for(const el of tailEls){if(!el.closest('.c71')) out.push('tail-outside-scroll-group:'+el.textContent.trim()); if(el.classList.contains('c67')||el.classList.contains('c68')||el.classList.contains('c69')) out.push('tail-opacity-reveal:'+el.textContent.trim());}
      const cursorRows = rows.concat(rows.length ? [Math.max(...rows)+23.3] : []);
      for(const c of cursors){const cy=c.y+c.h/2; const row=cursorRows.reduce((best,y)=>Math.abs(y-cy)<Math.abs(best-cy)?y:best,cursorRows[0]??cy); if(Math.abs(row-cy)>40) out.push('cursor-y:'+Math.round(cy)+' nearest:'+Math.round(row));}
      for(const c of cursors) if(!c.inside) out.push('cursor-outside-scroll-group');
      for(let i=1;i<rows.length;i++) if(rows[i]<rows[i-1]-2) out.push('row-order');
      for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) if(Math.abs(rows[i]-rows[j])>2&&Math.abs(rows[i]-rows[j])<14) out.push('line-overlap:'+Math.round(rows[i])+':'+Math.round(rows[j]));
      for(const y of rows){const starts=visibleLead.filter((line)=>Math.abs(line.y+line.h/2-y)<7&&line.start); if(starts.length>1) out.push('line-overlap:'+Math.round(y)+':'+starts.map((line)=>line.text).join('|'));}
      return out;
    })()` });
    for (const violation of result.result.value ?? []) { console.log(`FAIL t=${t.toFixed(2)} ${violation}`); failed = true; }
  }
  process.exitCode = failed ? 1 : 0;
} catch (error) { console.error(`checker error: ${error.message}`); process.exitCode = 1; }
finally { ws?.close(); chrome.kill(); }
