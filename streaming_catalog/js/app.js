const React = window.React;
const { useEffect, useMemo, useRef, useState } = React;

const L = () => (window && window.lumen) || null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s, n = 10) {
  const str = String(s || '');
  if (!str) return '';
  return str.length <= 2 * n + 3 ? str : str.slice(0, n) + '...' + str.slice(-n);
}

function useToast() {
  const [toast, setToast] = useState({ open: false, kind: 'info', message: '' });
  const timerRef = useRef(null);

  function hide() {
    setToast((t) => ({ ...t, open: false }));
  }

  function show(message, kind = 'info', ms = 2600) {
    const msg = String(message || '').trim();
    if (!msg) return;

    setToast({ open: true, kind, message: msg });

    try {
      if (timerRef.current) clearTimeout(timerRef.current);
    } catch {}
    timerRef.current = setTimeout(() => hide(), ms);
  }

  useEffect(() => {
    return () => {
      try {
        if (timerRef.current) clearTimeout(timerRef.current);
      } catch {}
    };
  }, []);

  return { toast, show, hide };
}

let __gatewayBasePromise = null;
async function getGatewayBase() {
  if (__gatewayBasePromise) return __gatewayBasePromise;
  __gatewayBasePromise = (async () => {
    // 1) If running inside the Lumen Browser app renderer, use its settings.
    try {
      const api = L();
      if (api?.settingsGetAll) {
        const res = await api.settingsGetAll();
        const base = String(res?.settings?.localGatewayBase || '').trim();
        if (base) return base.replace(/\/+$/, '');
      }
    } catch {}

    // 2) Use the document <base href="..."> injected by the Lumen Browser (domain viewer).
    //    Prefer the <base> element because some browsers keep document.baseURI as "blob:".
    const candidates = [];
    try {
      const baseEl = document.querySelector('base[href]');
      if (baseEl?.href) candidates.push(String(baseEl.href));
    } catch {}
    try {
      if (document.baseURI) candidates.push(String(document.baseURI));
    } catch {}
    try {
      if (location?.href) candidates.push(String(location.href));
    } catch {}
    for (const c of candidates) {
      try {
        const u = new URL(String(c || ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
      } catch {}
    }

    // 3) Last resort fallback for local testing.
    return 'http://127.0.0.1:8080';
  })();
  return __gatewayBasePromise;
}

async function resolveUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  try {
    if (L()?.resolveUrl) return await L().resolveUrl(raw);
  } catch {}
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^lumen:\/\//i.test(raw)) {
    const s = raw.replace(/^lumen:\/\//i, '');
    const base = await getGatewayBase();
    return base.replace(/\/+$/, '') + '/' + s.replace(/^\/+/, '');
  }
  if (/^\/(ipfs|ipns)\//i.test(raw)) {
    const base = await getGatewayBase();
    return base.replace(/\/+$/, '') + raw;
  }
  return raw;
}

function pickCategory(it) {
  return String(it?.category || 'Catalog').trim() || 'Catalog';
}

function normalizeItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const title = String(it.title || '').trim();
  const cid = String(it.cid || '').trim();
  const cover = String(it.cover || '').trim();
  const year = Number(it.year || 0) || null;
  const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  const category = pickCategory(it);
  const author = String(it.author || '').trim();
  return { title, cid, cover, year, tags, category, author };
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'failed') };
  }
}

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [hero, setHero] = useState(null);
  const [search, setSearch] = useState('');
  const [player, setPlayer] = useState({ open: false, title: '', src: '' });
  const { toast, show: showToast, hide: hideToast } = useToast();

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('catalog.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load catalog.json');
        const data = await res.json();
        const listRaw = Array.isArray(data?.items) ? data.items : [];
        const list = listRaw.map(normalizeItem).filter((it) => it.title && it.cid && it.cover);
        setItems(list);
        setHero(list[0] || null);
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    const q = String(search || '').trim().toLowerCase();
    const filtered = q
      ? items.filter((it) => it.title.toLowerCase().includes(q) || it.tags.join(' ').toLowerCase().includes(q))
      : items;
    const m = new Map();
    for (const it of filtered) {
      const cat = pickCategory(it);
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(it);
    }
    return Array.from(m.entries()).map(([category, list]) => ({ category, list }));
  }, [items, search]);

  async function play(it) {
    const src = await resolveUrl(it.cid);
    setPlayer({ open: true, title: it.title, src });
  }

  async function pin(it) {
    const fn = L()?.save || L()?.pin;
    if (!fn) {
      showToast('Save not available in this context.', 'warn');
      return;
    }
    const res = await safeCall(() => fn({ cidOrUrl: it.cid, name: it.title }));
    if (res?.ok) showToast('Saved.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else showToast('Save failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  async function tip(it) {
    if (!L()?.sendToken) {
      showToast('Tip not available in this context.', 'warn');
      return;
    }
    const to = it.author || '';
    const memo = `Tip for ${it.title}`;
    const res = await safeCall(() => L().sendToken({ to, memo, amountLmn: 1 }));
    if (res?.ok) showToast('Sent.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else if (res?.error && res.error !== 'user_cancelled') showToast('Send failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  function Hero() {
    if (!hero) return null;
    const [bg, setBg] = useState('');
    useEffect(() => {
      (async () => setBg(await resolveUrl(hero.cover)))();
    }, [hero]);

    return (
      React.createElement('section', { className: 'relative h-[62vh] min-h-[420px] w-full overflow-hidden' },
        bg ? React.createElement('img', {
          src: bg,
          className: 'absolute inset-0 w-full h-full object-cover opacity-90',
          alt: '',
          onError: () => console.warn('[streaming_catalog] hero cover failed to load', { cover: hero.cover, resolved: bg })
        }) : null,
        React.createElement('div', { className: 'shade absolute inset-0' }),
        React.createElement('div', { className: 'relative z-10 max-w-6xl mx-auto px-6 pt-24' },
          React.createElement('div', { className: 'max-w-xl' },
            React.createElement('h1', { className: 'text-4xl md:text-5xl font-extrabold leading-tight' }, hero.title),
            React.createElement('div', { className: 'mt-3 flex flex-wrap items-center gap-2 text-sm text-white/80' },
              hero.year ? React.createElement('span', { className: 'px-2 py-1 rounded bg-white/10' }, hero.year) : null,
              (hero.tags || []).slice(0, 3).map((t) => React.createElement('span', { key: t, className: 'px-2 py-1 rounded bg-white/10' }, t))
            ),
            React.createElement('div', { className: 'mt-6 flex flex-wrap gap-3' },
              React.createElement('button', { className: 'px-5 py-3 rounded bg-white text-black font-bold hover:bg-white/90', onClick: () => play(hero) }, 'Play'),
              React.createElement('button', { className: 'px-5 py-3 rounded bg-white/20 font-bold hover:bg-white/25', onClick: () => tip(hero) }, 'Tip'),
              React.createElement('button', { className: 'px-5 py-3 rounded bg-white/20 font-bold hover:bg-white/25', onClick: () => pin(hero) }, 'Save')
            )
          )
        )
      )
    );
  }

  function Row({ title, list }) {
    const ref = useRef(null);
    return (
      React.createElement('section', { className: 'mt-8' },
        React.createElement('div', { className: 'px-6 max-w-6xl mx-auto' },
          React.createElement('div', { className: 'flex items-center justify-between mb-2' },
            React.createElement('h2', { className: 'text-xl font-bold' }, title)
          )
        ),
        React.createElement('div', { className: 'relative row-mask' },
          React.createElement('div', { ref, className: 'flex gap-3 overflow-x-auto px-6 pb-2 max-w-6xl mx-auto scroll-smooth' },
            list.map((it) => React.createElement(Card, { key: it.cid, it, onPlay: play, onTip: tip, onPin: pin }))
          )
        )
      )
    );
  }

  function Card({ it, onPlay, onTip, onPin }) {
    const [src, setSrc] = useState('');
    useEffect(() => { (async () => setSrc(await resolveUrl(it.cover)))(); }, [it.cover]);
    return (
      React.createElement('div', { className: 'relative w-[160px] md:w-[190px] flex-none group' },
        React.createElement('button', { className: 'w-full text-left', onClick: () => onPlay(it) },
          React.createElement('div', { className: 'relative overflow-hidden rounded-md bg-neutral-900 aspect-[2/3]' },
            src ? React.createElement('img', {
              src,
              className: 'absolute inset-0 w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200',
              alt: '',
              loading: 'lazy',
              onError: () => console.warn('[streaming_catalog] card cover failed to load', { cover: it.cover, resolved: src })
            }) : null,
            React.createElement('div', { className: 'absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors' }),
            React.createElement('div', { className: 'absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity' },
              React.createElement('button', { className: 'px-2 py-1 rounded bg-black/70 text-xs', onClick: (e) => { e.preventDefault(); e.stopPropagation(); onTip(it); } }, 'Tip'),
              React.createElement('button', { className: 'px-2 py-1 rounded bg-black/70 text-xs', onClick: (e) => { e.preventDefault(); e.stopPropagation(); onPin(it); } }, 'Save')
            )
          ),
          React.createElement('div', { className: 'mt-2' },
            React.createElement('div', { className: 'text-sm font-semibold leading-snug' }, it.title),
            React.createElement('div', { className: 'text-xs text-white/60 flex items-center gap-2' },
              it.year ? React.createElement('span', null, it.year) : null
            )
          )
        )
      )
    );
  }

  function PlayerOverlay() {
    if (!player.open) return null;
    return (
      React.createElement('div', { className: 'fixed inset-0 bg-black/80 z-[9999] flex items-center justify-center p-6', onClick: () => setPlayer({ open: false, title: '', src: '' }) },
        React.createElement('div', { className: 'w-full max-w-5xl', onClick: (e) => e.stopPropagation() },
          React.createElement('div', { className: 'flex items-center justify-between mb-3' },
            React.createElement('div', { className: 'text-lg font-bold' }, player.title),
            React.createElement('button', { className: 'px-3 py-2 rounded bg-white/10 hover:bg-white/15', onClick: () => setPlayer({ open: false, title: '', src: '' }) }, 'Close')
          ),
          React.createElement('div', { className: 'bg-black rounded-lg overflow-hidden border border-white/10' },
            React.createElement('video', { src: player.src, controls: true, playsInline: true, className: 'w-full h-[60vh] bg-black' })
          )
        )
      )
    );
  }

  return (
    React.createElement('div', null,
      React.createElement('header', { className: 'sticky top-0 z-20 bg-black/70 backdrop-blur border-b border-white/10' },
        React.createElement('div', { className: 'px-6 max-w-6xl mx-auto h-14 flex items-center justify-between' },
          React.createElement('div', { className: 'flex items-center gap-4' },
            React.createElement('div', { className: 'text-lg font-extrabold tracking-wide text-[var(--nf-red)]' }, 'Lumen'),
            React.createElement('nav', { className: 'nf-nav hidden md:flex gap-4 text-sm' },
              React.createElement('a', { href: '#', onClick: (e) => e.preventDefault() }, 'Catalog')
            )
          ),
          React.createElement('div', { className: 'flex items-center gap-3' },
            React.createElement('input', {
              className: 'bg-white/10 text-sm px-3 py-2 rounded w-[220px] outline-none border border-white/10 focus:border-white/30',
              placeholder: 'Search…',
              value: search,
              onChange: (e) => setSearch(e.target.value)
            })
          )
        )
      ),

      loading
        ? React.createElement('div', { className: 'px-6 max-w-6xl mx-auto py-16 text-white/80' }, 'Loading catalog…')
        : error
          ? React.createElement('div', { className: 'px-6 max-w-6xl mx-auto py-16 text-red-300' }, error)
          : React.createElement(React.Fragment, null,
              React.createElement(Hero, null),
              React.createElement('main', { className: 'pb-24' },
                grouped.map((g) => React.createElement(Row, { key: g.category, title: g.category, list: g.list }))
              )
            ),

      React.createElement(PlayerOverlay, null)
      ,
      toast?.open
        ? React.createElement('div', { className: 'fixed bottom-4 right-4 z-[99999] max-w-[90vw]' },
            React.createElement('div', {
              className: `px-4 py-3 rounded-lg shadow-lg border border-white/10 backdrop-blur bg-black/70 text-sm flex items-start gap-3 ${
                toast.kind === 'error'
                  ? 'text-red-200'
                  : toast.kind === 'success'
                    ? 'text-green-200'
                    : toast.kind === 'warn'
                      ? 'text-amber-200'
                      : 'text-white/90'
              }`
            },
              React.createElement('div', { className: 'flex-1' }, toast.message),
              React.createElement('button', { className: 'text-white/60 hover:text-white', onClick: hideToast, type: 'button' }, '×')
            )
          )
        : null
    )
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App));
