# CyberNetServerWeb: the StudioNet intranet server (one page)

ConsciousNode SoftWorks, MIT. Xinu rules: one self-contained HTML file, zero dependencies, offline. The only network API is `BroadcastChannel("studionet-v1")`. **Inline everything, and label every inline**: every lifted block keeps a provenance comment (source file + line range) and is listed in `LIFTS.md` with its SHA-256 and every intentional change.

CyberNetServerWeb (name `cybernetserverweb`, alias `cnsw`, node `0x00FD`) is the studio's small intranet. It's one page you leave open in a browser tab. Every studio machine on StudioNet can reach it: SpiralOS on TabComp, Hummingbird and Triton, and TritOS. It serves pages, hosts files, holds a small encyclopedia, and lets a tiny language model chat. The server does the heavy lifting (layout, search, inference), so the guest OSes only show results. That's how the 1995 web worked.

## Attached

- **`studionet/STUDIONET-1.0.md`**: the protocol contract. Implement the server side exactly.
- **`studionet/studionet-ref.js`**, **`golden-vectors.json`**, **`selftest.js`**: the reference implementation and vectors. **Tests only.** The server must have its **own** StudioNet implementation, written from the contract, so tests can compare two independent implementations. Do not copy or import the reference into the server page.
- **`vanta/index.html`**: Vanta, the studio's from-scratch HTML/CSS engine (`new VantaEngine().render(html, css)`). Lift it.
- **`convergence/convergence.html`** and its `SPEC.md`/`REPORT.md`: the gateway that already renders pages with Vanta and produces a SpiralWeb **projection** and a **snapshot** for SpiralOS. Lift its projection and snapshot code. Keep `/snap` byte-compatible with what SpiralOS's SpiralWeb expects.
- **`pip-suite/pips-room.html`**: Pip's Room, the studio's companion app with an in-browser model loader and inference engine. Lift **only**:
  - model file loading (from a local file the user picks);
  - tokenizer, inference and sampling;
  - streaming generation;
  - the user-discretion note.
  
  Leave out the soul, living memory, dreams, journal, thoughts and resident identity: Chat Jeepy Tea is a plain chat box.
- **`minipedia-cnsw.json`**: MiniPedia's built-in articles about studio projects, written by Kehai Interim (MIT).
- **`cnsw-mark.svg`**, **`cnsw-lockup.svg`**: the studio logo, for the server's own landing page.

## What to build: `cybernetserverweb.html`

**1. Host stack**
- A StudioNet 1.0 node in JS: SNS (HELLO with `kind 4`, the naming rules, the peer table) and a full SRRP server (`GET`/`PUT`/`POST`/`LIST`/`DEL`, multi-frame with SACK, an adaptive window, selective resend, `Window: 16`, 413 at the first frame, legacy one-frame requests).
- An echo responder, and a peer list in the UI.
- An operator panel showing traffic counters, a frame log (the last 500 frames, exportable as JSON), peers, uploads, and the model status.

**2. Pages and Vanta.** Pages live in the server's own store, `/www`, editable in the operator panel and kept in IndexedDB. **Uploaded files and imported data also live in IndexedDB**: this is the only storage API allowed, and it never leaves the browser. Each page can be requested three ways:
- `GET /path` with `Accept: text/hts`: the **projection**, a SpiralWeb-subset page (`<h1>`, `<p>`, `<hr>`, `<a href>`), derived from **Vanta's parsed document and box tree** (as Convergence does), never from the HTML text directly;
- `GET /snap/path?fmt=spiral`: a Vanta render downsampled into the SpiralOS palette, in the format SpiralWeb's Snap already displays;
- `GET /snap/path?fmt=t3`: `Type: image/t3-snap`. That's `width` u16, `height` u16 (160 × 100), then palette values in −364..+364 as trytes16, quantized into Triton's 729-color palette.

Links in projections stay clickable; forms become `POST`s.

**3. Files (`/files`)**
- `PUT /files/<name>` stores a file. Name rules per §4.3; caps of 1 MB per file and 64 MB total, both configurable; `413` / `507 FULL`.
- `LIST /files` and `GET /files/<name>` (with the `Encoding` the file was stored with) and `DEL /files/<name>`.
- Uploaded files are **never executed or rendered as pages**. They are served as stored data, with `Type` from a fixed extension whitelist; anything else is `application/octet-stream`.
- Operator panel: list, download, delete.

**4. MiniPedia (`/minipedia`)**
- Article pages; an index; a search form (`POST /minipedia/search`, body `q=…`) over titles and text with a ranked result list; and "random article".
- **Built-in content:** `minipedia-cnsw.json`, MIT, with the byline on each article.
- **Importer (operator panel):** loads a **Wikipedia abstract dump** the operator provides (`*-abstract.xml`: `<doc><title>`, `<url>`, `<abstract>`), streaming, with a configurable article cap. Imported articles carry their source URL and **"Text from Wikipedia, CC BY-SA 4.0"** on every page, and are stored and exported **separately** from the MIT content, so the licenses never mix. There's a `/minipedia/license` page.

**5. Chat Jeepy Tea (`/chat`)**
- The operator loads a model file (GGUF, as Pip's Room supports) in the panel. The page shows the **model's name, parameter count and quantization as read from the file**, and nothing invented.
- Clients `POST /chat` with `q=…&conv=<id>` and get back a page with the conversation so far. Generation runs on the server.
- Because SRRP is request/response, a client polls `GET /chat/<id>?after=<n>` to receive new tokens while the reply streams. A reply page says `(thinking…)` until it is done.
- One generation at a time; other requests get `503 BUSY` with a retry hint.
- Settings: temperature, top-p, max tokens, and an optional system prompt (empty by default).
- The user-discretion note appears on `/chat` and in the panel.

**6. Landing page (`/`)**
- The CNSW mark, links to MiniPedia, Chat Jeepy Tea, Files and Sonder (if `sonder.gw` is on the network);
- the peer list ("who's on StudioNet right now").

## Forbidden

- Importing or copying `studionet-ref.js` into the server.
- Network APIs other than BroadcastChannel; external assets.
- Projections built from page source text instead of Vanta's tree.
- Precomputed snapshots or projections.
- **Fabricated model output:** canned replies, or a fallback "AI" when no model is loaded. With no model, `/chat` says `No model loaded.`
- Mixing Wikipedia text into the MIT content or the repo.
- Executing uploaded files.
- **Verbatim:** "If a requirement can't be met, or conflicts with another, say so in REPORT.md and leave it failing. Never change emulator or VM accessors, I/O, consoles, test harnesses, or the auditor's scripts to make a check pass. An emulator must never read or write a guest's private memory."
- Do not predict, rank or praise results anywhere in code, docs or UI.

## Tests (Node for the logic, plus Playwright/headless Chromium for everything that touches the page)

1. **Golden vectors:** the server stack produces and parses every vector (field-exact, with its own `seq` values), and answers every SRRP vector correctly.
2. **Differential:** the reference (`studionet-ref.js`) acts as the client in a second browser context over BroadcastChannel, doing GET/PUT/LIST/DEL/POST on 1 KB, 64 KB and 1 MB bodies over a seeded fault-injecting relay (drop, duplicate, reorder). Results must be byte-identical; report resends and timeouts.
   - **Positive controls:**
     - 100% loss gives `TIMEOUT` on the client;
     - an oversize PUT gives 413 before the body;
     - `../x` gives 403;
     - a corrupted reference (SACK bitmap zeroed) still completes, but with more resends, which is reported.
3. **Naming:** two server tabs come up as `cnsw1`/`cnsw2` in join order.
4. **Vanta is in the loop:**
   - monkey-patch Vanta's layout to shift every box by 1 px, and the snapshot changes;
   - patch its parser to drop one element, and the projection changes accordingly;
   - a page with CSS-only differences gives different snapshots but the same projection.
5. **`/snap` compatibility:** the `fmt=spiral` bytes for a fixed page equal what Convergence's gateway produces for the same HTML (run both lifts side by side).
6. **MiniPedia:**
   - all built-in articles are served;
   - search ranks an exact title match first;
   - an imported 1,000-article sample (generate a **synthetic** dump with obviously fake titles for the test; don't ship Wikipedia text) shows the CC BY-SA line on every page, and an MIT export contains 0 imported articles.
7. **Chat Jeepy Tea:**
   - with no model, the page says `No model loaded.`;
   - with a **tiny randomly initialized test model** written by the test (same file format), the server generates tokens, polling returns them in order, and a second concurrent request gets `503 BUSY`;
   - the model info shown matches the file header;
   - the lifted engine hash-matches its source lines in `pips-room.html`.
8. **Files:** round trip at 1 B, 480 B and 1 MB; quota → `507`; whitelist types; an uploaded `.html` is served as data, never rendered.
9. **Static scan:** a strict CSP; no network APIs except BroadcastChannel; storage only through IndexedDB; every inline block labeled; the reference not present in the page.
10. **Real browser:** the page loads with 0 page errors; two client tabs (reference peers) and the server see each other in `peers`.

## Report

`REPORT.md`:
- what was built, every test's printed numbers (copied, never typed), every unmet requirement, and anything consulted besides the attachments;
- the IndexedDB schema and the formats you chose.

Package the repo tree (`cybernetserverweb.html`, `tests/`, docs, `LIFTS.md`, `LICENSE`) plus test logs as a zip.
