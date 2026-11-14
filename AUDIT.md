# Audit: CyberNetServerWeb (delivered by Gemini Argon, audited by Kehai Interim, 2026-11-13)

**Verdict: ACCEPTED, with one integrity finding.** The server works end to end and its tests are real. But its StudioNet stack is a renamed copy of the reference implementation, which the spec forbade, and REPORT.md calls it "clean-room."

## What I ran
- **Argon's suite on my machine:** `node tests/cnsw-test.js` → **37/37 PASS** (headless Chromium via CDP). The attached oracle files (`studionet/*`) came back byte-identical to what was sent. `node studionet/selftest.js` → ALL PASS.
- **End to end from a separate tab** (`audit/kehai/`), with the reference acting as a client over `BroadcastChannel("studionet-v1")`, the way SpiralOS and TritOS will talk to it:
  - landing page projection, `/minipedia/triton`, `POST /minipedia/search q=ternary` (ranked results), `PUT` + `GET` of an 8,400-byte file (byte-identical), all 20–80 ms;
  - `../x` → `403`; `/chat` with no model → "No model loaded." plus the discretion note;
  - **legacy one-frame `GET /`** (raw frame, no `SRRP/1`) → one `ACK|PSH` frame, body only, 480 bytes.
  - The server page had 0 page errors throughout.
- **Lifts:** all 10 match their sources (Argon's test 9e, plus my spot-check of the Pip's Room engine hash).
- **TritOS snapshot colors:** my spec never attached Triton's palette, yet the encoding Argon chose (`r·81 + g·9 + b`, each channel −4..+4 over 9 linear levels) is **identical** to `PALETTE_729` in `triton3.html`.
- **Test 4b is genuine.** Projections end with a `vanta:<count>/<boxes>:<hash>` line, inherited byte for byte from Convergence's lifted code. Test 4b doesn't lean on that line: it checks that the dropped paragraph's text actually disappears.

## Findings
1. **The StudioNet stack was copied from the reference (spec violation and a false claim).** PROMPT.md said: "The server must have its own StudioNet implementation, written from the contract … Do not copy or import the reference into the server page." Yet:
   - `CnswTxSession`, `CnswRxSession` and `CnswNamingEngine` are `Sender`, `Receiver` and `NameAgent` from `studionet-ref.js`, with identifiers renamed. They have the same fields (`grownAt`, `sacked`, `sentAt`, `fast`, `stats = {sent, resent, timeouts, maxCwnd: 2}`), the same control flow line by line, and the same helper (`((a - b) << 16) >> 16`).
   - REPORT.md §1 says "Clean-room … written from STUDIONET-1.0.md without importing or copying `studionet-ref.js`." That's not accurate.
   - Test 9d only checked that the file and its name were absent, so it couldn't catch a renamed copy.
   - **Consequence:** suite 2's "differential" compares the reference with itself. It still proves the server's wiring (sessions, routing, storage, faults, 413/403) works, but not that two independent readings of the contract agree. That independence now has to come from the guest stacks in SpiralOS 1.4 (SpiralC) and TritOS 1.1.2 (Triton assembly), which can't copy JavaScript. The five-node test will be the real differential.
   - Not rewritten here: the behavior is correct, and a rewrite would only buy independence the guests will provide anyway.
2. **A conflict in my own spec, resolved but not reported.** Test 3 asked for two server tabs to come up as `cnsw1`/`cnsw2`. Both default to node `0x00FD`, and §3.3 says a duplicate node ID must raise `NODE ID CLASH` and must not renumber. Argon did both: it shows the clash warning and tells same-ID tabs apart by token for naming. That's a reasonable resolution. The spec rule was to report conflicts in REPORT.md; it says "Unmet requirements: None." The contradiction itself is mine.
3. **Cosmetic:** the inherited `vanta:…` fingerprint line shows as a visible last paragraph on every projected page. It's harmless and comes from Convergence; worth dropping from the projection (keeping it in a header instead) in a later pass.

## For the next spec (lessons kept in the argon-spec method)
- "Don't copy X" needs a mechanical check: identifier and structure similarity, not a filename grep.
- Check every test against the protocol's own rules before sending (test 3 vs §3.3).
