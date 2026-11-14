import sys, time, socket, subprocess, json
from playwright.sync_api import sync_playwright
s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]; s.close()
srv=subprocess.Popen([sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1'],cwd='/tmp/e2e',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
def req(page, text, sport, body=None):
    return page.evaluate("""async ([t, sp, body]) => {
      const enc = new TextEncoder(); let head = enc.encode(t);
      if (body) { const b = enc.encode(body); const h2 = enc.encode(t.replace(/\\n\\n$/, '\\nSize: ' + b.length + '\\n\\n')); const m = new Uint8Array(h2.length + b.length); m.set(h2); m.set(b, h2.length); head = m; }
      const r = await window.request(head, sp);
      return r.ok ? { ok: true, text: new TextDecoder().decode(new Uint8Array(r.msg)), ms: Math.round(r.ms) } : r; }""", [text, sport, body])
out={}
try:
  with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--no-sandbox']); ctx=b.new_context()
    srvp=ctx.new_page(); errs=[]; srvp.on('pageerror', lambda e: errs.append(str(e)))
    srvp.goto(f'http://127.0.0.1:{port}/cybernetserverweb.html'); time.sleep(5)
    cl=ctx.new_page(); cl.goto(f'http://127.0.0.1:{port}/client.html'); time.sleep(1)
    tests=[('landing','GET / SRRP/1\nAccept: text/hts\n\n',None),
           ('minipedia triton','GET /minipedia/triton SRRP/1\nAccept: text/hts\n\n',None),
           ('search','POST /minipedia/search SRRP/1\nType: form\n\n','q=ternary'),
           ('put file','PUT /files/kehai-e2e.txt SRRP/1\nEncoding: bytes\n\n','hello from the porch '*400),
           ('get file','GET /files/kehai-e2e.txt SRRP/1\n\n',None),
           ('traversal','GET /files/..%2Fx SRRP/1\n\n',None),
           ('chat no model','POST /chat SRRP/1\nType: form\n\n','q=hi&conv=e2e'),
           ('legacy GET','GET /',None)]
    for i,(name,t,body) in enumerate(tests):
        r=req(cl,t,49200+i,body); out[name]=r
    out['serverPageErrors']=errs
    b.close()
finally: srv.terminate()
for k,v in out.items():
    if isinstance(v,dict) and v.get('ok'): print(f"{k}: {v['ms']} ms | {v['text'][:300]!r}{' ...(%d B)'%len(v['text']) if len(v['text'])>300 else ''}")
    else: print(k, v)
