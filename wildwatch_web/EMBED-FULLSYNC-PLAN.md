# Embed panels: full-colony sync (offline + instant), plan

## Goal

The nestcheck bird/box panels are WebView embeds of the wildwatch panel
(`/bird/<peng>?embed=1`, `/box/<name>?embed=1`). They currently work but feel a bit slow,
and they **require network** for every open (each open does a live scoped fetch of
`bird-detail.php` / `box-detail.php`).

Make them fast and **offline-capable** by syncing the whole colony into the same per-colony
IndexedDB the browser already uses, then querying that — exactly like the full wildwatch app.
After the first sync, every panel (and every bird↔box link tapped inside it) is an instant,
offline local query.

**Decided usage pattern: one colony per session.** So the one-time full sync (~900KB gzipped,
a few seconds) is paid once when the user starts on a colony, then everything is instant. (If
usage were frequent colony-hopping, the per-open scoped fetch would be the better default —
see "Colony change" below.)

## Already shipped (on `main`, keep as-is)

- `snapshot_columns.php` — shared SELECT column definitions (the row-shape contract).
- `bird-detail.php`, `box-detail.php` — live, `Bearer`-authed, self-contained scoped endpoints
  (each returns the snapshot-shaped tables scoped to one bird's boxes / one box). Closure
  mirrored between the two; both share `snapshot_columns.php`. **Verified vs live.**
- `BoxPanel` component in `App.tsx` — box detail body (breeding history + observations),
  shared by the full app and the embed.
- `EmbeddedPanel` in `App.tsx` (currently the **scoped-fetch** version) + `?embed=1` branch in
  `main.tsx` + `.embed-bird` / `.embed-box` CSS.
- nestcheck `MainActivity.cs`: `OpenEmbedPanel` / `ShowBirdPanel` / `ShowBoxPanel` /
  `EmbedWebViewClient` — bird & box badges open the panel in a modal WebView; token injected as
  `window.__WW_TOKEN__` (never in the URL).

## Phase 1 — switch the embed from scoped-fetch to full colony sync

**Only `EmbeddedPanel` in `App.tsx` changes.** No server changes. Replace the per-open scoped
fetch with the browser's sync path: `setActiveColony` → `primeFromCache` (instant paint from a
prior sync; also what makes it work offline) → `syncDatabase` (background refresh). Because the
whole colony is then in `mem`, `useBirdDetail` / `useBoxDetail` for **any** id are instant, and
in-panel navigation needs no fetch.

Concrete replacement for `EmbeddedPanel` (the body between the doc-comment and `function App()`):

```tsx
/**
 * Chrome-less panel for embedding (nestcheck WebView modal). Renders ONLY the bird OR box
 * panel. Syncs the whole colony into the SAME per-colony IndexedDB the browser uses
 * (primeFromCache for instant paint + offline, then syncDatabase), so after the first sync
 * every panel — and every bird/box link tapped inside it — is an instant, offline-capable
 * local query. Reuses the same BirdPage / BoxPanel / computeBoxFamilies as the full app.
 *
 * URL: /bird/<peng>?embed=1&colony_id=<n>  or  /box/<name>?embed=1&colony_id=<n>
 * Token: window.__WW_TOKEN__ (injected by host), or ?token=, or the stored web token.
 */
export function EmbeddedPanel() {
  const params = new URLSearchParams(window.location.search);
  const initialKind: 'box'|'bird' = /\/box\//.test(window.location.pathname) ? 'box' : 'bird';
  const initialId = decodeURIComponent(
    window.location.pathname.match(/\/(?:box|bird)\/([^/?#]+)/)?.[1]
    || params.get('peng') || params.get('peng_num') || params.get('box') || '');
  const colonyId = parseInt(params.get('colony_id') || '1', 10) || 1;
  const token = (window as any).__WW_TOKEN__ || params.get('token') || localStorage.getItem('ww_token') || '';

  const [view, setView] = useState<{ kind: 'box'|'bird'; id: string }>({ kind: initialKind, id: initialId });
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [progress, setProgress] = useState('');
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);

  const birdData = useBirdDetail(status === 'ready' && view.kind === 'bird' ? view.id : null);
  const boxData = useBoxDetail(status === 'ready' && view.kind === 'box' ? view.id : null);
  const allPenguins = useAllPenguins();

  // Sync the colony once into its own IndexedDB. primeFromCache paints instantly from a prior
  // sync (and lets the panel work fully offline); syncDatabase refreshes in the background.
  // Re-runs only on colony change (setActiveColony clears mem + swaps DB).
  useEffect(() => {
    let cancelled = false;
    if (token) localStorage.setItem('ww_token', token); // so snapshot.php / fetchHistory authenticate
    setActiveColony(colonyId, `1-${colonyId}`);          // this colony's cache (region is irrelevant to the sync)
    setStatus('loading'); setProgress('');
    (async () => {
      let primed = false;
      try { primed = await primeFromCache(); if (!cancelled && primed) setStatus('ready'); }
      catch { /* fall through to full sync */ }
      try {
        await syncDatabase((msg) => { if (!cancelled) setProgress(msg); });
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled && !primed) { setStatus('error'); setErrMsg(String((e as any)?.message || e)); }
      }
    })();
    return () => { cancelled = true; };
  }, [colonyId, token]);

  // Navigation is instant — the whole colony is in mem, so no fetch per bird/box.
  const goBird = (num: string) => { if (num) { setHighlightObs(null); setScrollToObs(null); setView({ kind: 'bird', id: num }); } };
  const goBox = (box: string) => { if (box) { setHighlightObs(null); setScrollToObs(null); setView({ kind: 'box', id: box }); } };
  const scrollObs = (t: string) => { setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(t); setScrollToObs(t); }, 10); };

  if (status === 'error') return <div className="embed-state embed-error">Couldn't load colony data<div className="muted" style={{marginTop:6, fontSize:12}}>{errMsg}</div></div>;
  if (status !== 'ready') return <div className="embed-state">Syncing colony…<div className="muted" style={{marginTop:6, fontSize:12}}>{progress}</div></div>;

  if (view.kind === 'box') {
    if (!boxData?.location) return <div className="embed-state embed-error">Box {view.id} not found</div>;
    return (
      <div className="embed-box">
        <div className="page-header"><div className="box-header-left"><h2>Box {view.id}</h2><StatusLegend /></div></div>
        <BreedingStatusBar observations={boxData.observations} hideLegend onHighlight={setHighlightObs} onScrollTo={scrollObs} />
        <div className="detail-split">
          <BoxPanel data={boxData} boxName={view.id} allPenguins={allPenguins}
            onBirdClick={goBird} onDayClick={() => {}}
            highlightObs={highlightObs} scrollToObs={scrollToObs} onScrollToObs={scrollObs}
            token={token} canEdit={false} />
        </div>
      </div>
    );
  }

  if (!birdData?.penguin) return <div className="embed-state embed-error">Bird {view.id} not found</div>;
  return (
    <div className="embed-bird">
      <BirdPage data={birdData} onBirdClick={goBird} onBoxClick={goBox} onSightingClick={(box: string) => goBox(box)} onDayClick={undefined} token={token} canEdit={false} />
    </div>
  );
}
```

Import cleanups in `App.tsx` line 4 (both become unused after this change):
- remove `loadBirdDetailIntoMem`
- remove `setColonyId` (a local `useState` setter shadows it elsewhere; the import is unused)
- ensure `setActiveColony`, `primeFromCache`, `syncDatabase` are imported (they already are)

Verify: `npx tsc --noEmit -p tsconfig.app.json` should stay at the 7 pre-existing errors (no new
ones). Deploy, then load `https://wildwatch.co.nz/box/5?embed=1` logged in — first load syncs
(spinner + progress), then navigating bird↔box is instant; toggle airplane mode to confirm it
still works offline after a sync.

### Fate of the scoped endpoints
After Phase 1, `bird-detail.php` / `box-detail.php` and localdb's `loadBirdDetailIntoMem` are
**no longer called by the embed**. Options: leave them (harmless, and a fallback for a
"lightweight" mode) or delete `bird-detail.php`, `box-detail.php`, and `loadBirdDetailIntoMem`.
Recommendation: leave for now; remove later if nothing else uses them.

## Colony change

Falls out of the per-colony IndexedDB scheme (already in production for the browser). Each
colony has its own cache DB (`getColonyKey()` → `wildwatch-<key>`); `setActiveColony` clears
`mem` and swaps which DB is live. The embed keys everything off the `colony_id` in the URL
(`snapshot.php` only needs `colony_id`; the DB name only needs a stable per-colony string, so
`1-<colony_id>` is fine — region is irrelevant to the sync).

- **Colony already synced on this device** → `primeFromCache` → instant, then a tiny incremental sync.
- **New colony** → one full sync (~900KB), then cached forever (until a `CACHE_VERSION` bump).
- No cross-contamination — different colony = different DB.

## Phase 2 — persistent, pre-warmed WebView (nestcheck), optional, biggest cold-start win

Phase 1 removes the per-open network cost. The remaining per-open cost is the **WebView
cold-start** (create WebView, load bundle, boot React). Kill it by keeping **one hidden WebView
alive**, pre-loaded with the embed app and pre-synced:

1. On nestcheck startup (or when a colony is selected), create a hidden `WebView` loading e.g.
   `https://wildwatch.co.nz/box/_?embed=1&colony_id=<current>` so it boots + runs the colony
   sync in the background — warm before the user taps anything.
2. On badge tap: show the dialog hosting the already-booted WebView and tell it what to render
   via a JS bridge instead of a fresh `LoadUrl`, e.g. `webView.EvaluateJavascript("wwShow('box','5')", null)`.
   Requires `EmbeddedPanel` to expose a small global (e.g. `window.wwShow = (kind,id) => setView({kind,id})`)
   and, ideally, listen for `window.wwSetColony(n)` to re-sync when nestcheck switches colony
   (call `setActiveColony` + re-run the sync).
3. On colony switch in nestcheck: fire `webView.EvaluateJavascript("wwSetColony(<n>)", null)` so
   the warm WebView re-syncs the new colony in the background.

This makes panel opens near-instant (no bundle reload, no React boot, no network) and keeps the
warm WebView correct across colony changes.

## Trade-offs (accepted)

- **Duplicate data**: nestcheck already syncs observations/scans natively for its core function;
  the WebView syncs the same DB again into JS-land (~900KB periodically). Bridging native data
  into the WebView instead is much more work — not worth it now.
- **First-run cost** moves from per-open to one upfront colony sync.
- **Staleness**: handled by `syncDatabase`'s incremental sync (same as the browser); Phase 2 can
  add polling/refresh if wanted.
- **Memory**: full `mem` in a live WebView is tens of MB — fine on modern phones.
