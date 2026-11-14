import sys, time, socket, subprocess
from playwright.sync_api import sync_playwright
s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]; s.close()
srv=subprocess.Popen([sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1'],cwd='/tmp/e2e',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(0.6)
try:
  with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--no-sandbox']); ctx=b.new_context()
    a=ctx.new_page(); a.goto(f'http://127.0.0.1:{port}/cybernetserverweb.html'); time.sleep(5)
    c=ctx.new_page(); c.goto(f'http://127.0.0.1:{port}/client.html'); time.sleep(1)
    r=c.evaluate("""() => new Promise(res => {
      const R = StudioNetRef, bc2 = new BroadcastChannel('studionet-v1');
      bc2.onmessage = ev => { const u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data); const f = R.decodeFrame(u8);
        if (f.ok && f.dst === 0x0301 && f.dport === 49300) res({flags: f.flags, len: f.payload.length, text: new TextDecoder().decode(f.payload).slice(0, 160)}); };
      const p = new TextEncoder().encode('GET /');
      bc2.postMessage(R.encodeFrame({dst: 0x00FD, src: 0x0301, proto: 3, flags: R.FLAG.SYN|R.FLAG.PSH, sport: 49300, dport: 80, seq: 7, payload: p}));
      setTimeout(() => res('no reply'), 4000); })""")
    print(r); b.close()
finally: srv.terminate()
