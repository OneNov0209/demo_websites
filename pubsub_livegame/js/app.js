const React = window.React;
const { useEffect, useMemo, useRef, useState } = React;

const L = () => (window && window.lumen) || null;

function nowMs() {
  return Date.now();
}

function randHex(n = 6) {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[(Math.random() * alphabet.length) | 0];
  return out;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function hashColor(str) {
  const s = String(str || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 85% 55%)`;
}

function encodePayload(type, fields) {
  const entries = Object.entries(fields || {}).map(([k, v]) => [String(k), String(v)]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const parts = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `pubsub_livegame|v1|${type}|` + parts.join('|');
}

function decodePayload(payload) {
  const s = String(payload || '');
  const parts = s.split('|');
  if (parts.length < 4) return null;
  if (parts[0] !== 'pubsub_livegame' || parts[1] !== 'v1') return null;
  const type = parts[2];
  const obj = {};
  for (const p of parts.slice(3)) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    obj[k] = decodeURIComponent(v);
  }
  return { type, ...obj };
}

function useLog() {
  const [lines, setLines] = useState([]);
  function push(line) {
    const s = String(line || '');
    if (!s) return;
    setLines((prev) => {
      const next = prev.length > 250 ? prev.slice(prev.length - 200) : prev.slice();
      next.push(`[${new Date().toLocaleTimeString()}] ${s}`);
      return next;
    });
  }
  return { lines, push };
}

function App() {
  const [room, setRoom] = useState('lobby');
  const [nick, setNick] = useState('player-' + randHex(3));
  const [status, setStatus] = useState({ connected: false, topic: '', subId: '', me: null });
  const [peerCount, setPeerCount] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [searchUntil, setSearchUntil] = useState(0);
  const [err, setErr] = useState('');
  const { lines, push } = useLog();

  const canvasRef = useRef(null);
  const loopRef = useRef({ raf: 0, lastSendAt: 0, mouse: { x: 0, y: 0, active: false } });
  const subRef = useRef({ unsubscribe: null });
  const peersRef = useRef(new Map()); // address -> {x,y,nick,ts,color}
  const seenMsgIdRef = useRef(new Set()); // `${addr}:${nonce}`
  const connectSeqRef = useRef(0);

  const topic = useMemo(() => `lumen/pubsub_livegame/v1/${String(room || 'lobby').trim().toLowerCase()}`, [room]);

  async function getActiveProfile() {
    const api = L();
    if (!api?.profiles?.getActive) throw new Error('lumen.profiles.getActive unavailable');
    const p = await api.profiles.getActive();
    const profileId = String(p?.id || '').trim();
    const address = String(p?.walletAddress || p?.address || '').trim();
    if (!profileId || !address) throw new Error('No active wallet profile');
    return { profileId, address };
  }

  async function signPayload(profileId, address, payload) {
    const api = L();
    if (!api?.wallet?.signArbitrary) throw new Error('lumen.wallet.signArbitrary unavailable');
    const res = await api.wallet.signArbitrary({ profileId, address, algo: 'ADR-036', payload });
    if (!res?.ok) throw new Error(res?.error || 'sign failed');
    return res;
  }

  async function verifyPayload(payload, signatureB64, pubkeyB64, address) {
    const api = L();
    if (!api?.wallet?.verifyArbitrary) {
      return { ok: true, signatureValid: true, derivedAddress: '', error: '' }; // best-effort fallback
    }
    const res = await api.wallet.verifyArbitrary({ algo: 'ADR-036', payload, signatureB64, pubkeyB64, address });
    const signatureValid = !!(res && (res.signatureValid ?? res.ok));
    const derivedAddress = String((res && (res.derivedAddress || res.derivedAddr)) || '').trim();
    const error = res && res.error ? String(res.error) : '';
    return { ok: !!(res && res.ok), signatureValid, derivedAddress, error };
  }

  async function publishSigned(type, fields) {
    const api = L();
    if (!api?.pubsub?.publish) throw new Error('lumen.pubsub.publish unavailable');
    const { profileId, address } = await getActiveProfile();
    const payload = encodePayload(type, {
      room: topic,
      ts: String(nowMs()),
      nonce: randHex(8),
      addr: address,
      ...fields,
    });
    const sig = await signPayload(profileId, address, payload);
    const msg = {
      t: type,
      address: sig.address || address,
      pubkeyB64: sig.pubkeyB64,
      signatureB64: sig.signatureB64,
      payload,
    };
    const res = await api.pubsub.publish(topic, msg, { encoding: 'json' });
    if (!res?.ok) throw new Error(res?.error || 'publish failed');
  }

  async function connect() {
    if (connecting || status.connected) return;
    const mySeq = ++connectSeqRef.current;
    setErr('');
    setConnecting(true);
    const api = L();
    if (!api?.pubsub?.subscribe) {
      setErr('window.lumen.pubsub is not available in this context.');
      setConnecting(false);
      return;
    }
    if (!api?.wallet?.signArbitrary) {
      setErr('window.lumen.wallet.signArbitrary is not available in this context.');
      setConnecting(false);
      return;
    }
    peersRef.current = new Map();
    seenMsgIdRef.current = new Set();

    try {
      push('Connecting…');
      const sub = await api.pubsub.subscribe(topic, { encoding: 'json', autoConnect: true }, async (m) => {
        try {
          const data = m?.json;
          if (!data || typeof data !== 'object') return;
          const payload = String(data.payload || '');
          const address = String(data.address || '').trim();
          const pubkeyB64 = String(data.pubkeyB64 || '').trim();
          const signatureB64 = String(data.signatureB64 || '').trim();
          if (!payload || !address || !pubkeyB64 || !signatureB64) return;

          const parsed = decodePayload(payload);
          if (!parsed) return;
          if (String(parsed.room || '') !== topic) return;
          const nonce = String(parsed.nonce || '').trim();
          if (!nonce || nonce.length > 20) return;
          const unverifiedId = `${address}:${nonce}`;
          if (seenMsgIdRef.current.has(unverifiedId)) return;
          if (seenMsgIdRef.current.size > 2500) {
            const next = new Set();
            let i = 0;
            for (const id of seenMsgIdRef.current) {
              if (i++ < 1200) continue;
              next.add(id);
            }
            seenMsgIdRef.current = next;
          }
          seenMsgIdRef.current.add(unverifiedId);

          const v = await verifyPayload(payload, signatureB64, pubkeyB64, address);
          if (!v.signatureValid) return;
          const canonicalAddr = v.derivedAddress || address;

          const t = String(parsed.type || '');
          if (t === 'join') {
            const nn = String(parsed.nick || '').slice(0, 22) || 'player';
            const x = clamp(Number(parsed.x || 0), 0, 1000);
            const y = clamp(Number(parsed.y || 0), 0, 1000);
            peersRef.current.set(canonicalAddr, { x, y, nick: nn, ts: nowMs(), color: hashColor(canonicalAddr) });
          } else if (t === 'state') {
            const x = clamp(Number(parsed.x || 0), 0, 1000);
            const y = clamp(Number(parsed.y || 0), 0, 1000);
            const nn = String(parsed.nick || '').slice(0, 22) || (peersRef.current.get(canonicalAddr)?.nick || 'player');
            peersRef.current.set(canonicalAddr, { x, y, nick: nn, ts: nowMs(), color: hashColor(canonicalAddr) });
          }
        } catch {}
      });

      if (connectSeqRef.current !== mySeq) {
        try { await sub.unsubscribe(); } catch {}
        return;
      }

      subRef.current.unsubscribe = sub.unsubscribe;
      setStatus({ connected: true, topic, subId: String(sub.subId || ''), me: null });
      push(`Subscribed: ${topic}`);
      setPeerCount(0);
      setSearchUntil(Date.now() + 10_000);

      // announce join at random spot
      const sx = 150 + Math.random() * 700;
      const sy = 150 + Math.random() * 700;
      await publishSigned('join', { nick: String(nick || '').trim().slice(0, 22), x: sx.toFixed(1), y: sy.toFixed(1) });
    } catch (e) {
      setErr(String(e?.message || e || 'Connect failed'));
    } finally {
      if (connectSeqRef.current === mySeq) setConnecting(false);
    }
  }

  async function disconnect() {
    connectSeqRef.current += 1;
    setConnecting(false);
    setSearchUntil(0);
    try {
      const u = subRef.current.unsubscribe;
      subRef.current.unsubscribe = null;
      if (u) await u();
    } catch {}
    setStatus({ connected: false, topic: '', subId: '', me: null });
    setPeerCount(0);
    push('Disconnected');
  }

  useEffect(() => {
    return () => {
      try { cancelAnimationFrame(loopRef.current.raf); } catch {}
      disconnect();
    };
  }, []);

  // PubSub peer count (debug)
  useEffect(() => {
    if (!status.connected) return;
    let alive = true;
    const api = L();
    const tick = async () => {
      if (!alive) return;
      try {
        const res = await api?.pubsub?.peers?.(topic);
        const peers = Array.isArray(res?.peers) ? res.peers : [];
        if (alive) setPeerCount(peers.length);
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      try { clearInterval(t); } catch {}
    };
  }, [status.connected, topic]);

  // Hide the "searching" hint after ~10s (or as soon as someone appears).
  useEffect(() => {
    if (!status.connected) return;
    if (peerCount > 0) {
      if (searchUntil) setSearchUntil(0);
      return;
    }
    if (!searchUntil) return;
    const ms = Math.max(0, searchUntil - Date.now());
    const t = setTimeout(() => setSearchUntil(0), ms);
    return () => {
      try { clearTimeout(t); } catch {}
    };
  }, [status.connected, peerCount, searchUntil]);

  // Canvas render loop + local state send
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const state = loopRef.current;
    let meAddr = '';
    let meColor = '';
    let meX = 500;
    let meY = 500;

    (async () => {
      try {
        const { address } = await getActiveProfile();
        meAddr = address;
        meColor = hashColor(address);
      } catch {}
    })();

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      state.mouse = { x, y, active: true };
    };
    const onLeave = () => {
      state.mouse = { x: 0.5, y: 0.5, active: false };
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    const tick = async () => {
      // integrate local
      const targetX = state.mouse.active ? state.mouse.x * 1000 : meX;
      const targetY = state.mouse.active ? state.mouse.y * 1000 : meY;
      meX += (targetX - meX) * 0.10;
      meY += (targetY - meY) * 0.10;

      // prune peers
      const t = nowMs();
      for (const [addr, p] of peersRef.current.entries()) {
        if (t - (p.ts || 0) > 6000) peersRef.current.delete(addr);
      }

      // draw
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;

      // grid
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = '#101010';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) {
        const gx = (i / 10) * w;
        const gy = (i / 10) * h;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // me
      if (meAddr) {
        const mx = (meX / 1000) * w;
        const my = (meY / 1000) * h;
        ctx.fillStyle = meColor || '#1db954';
        ctx.beginPath(); ctx.arc(mx, my, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(nick || '').slice(0, 18), mx, my - 18);
      }

      // peers
      for (const [addr, p] of peersRef.current.entries()) {
        if (addr === meAddr) continue;
        const px = (Number(p.x || 0) / 1000) * w;
        const py = (Number(p.y || 0) / 1000) * h;
        ctx.fillStyle = p.color || '#888';
        ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(p.nick || 'player').slice(0, 18), px, py - 18);
      }

      // send state at 5Hz max
      if (status.connected && nowMs() - state.lastSendAt > 200) {
        state.lastSendAt = nowMs();
        try {
          await publishSigned('state', { nick: String(nick || '').trim().slice(0, 22), x: meX.toFixed(1), y: meY.toFixed(1) });
        } catch {}
      }

      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      try { canvas.removeEventListener('pointermove', onMove); } catch {}
      try { canvas.removeEventListener('pointerleave', onLeave); } catch {}
      try { cancelAnimationFrame(state.raf); } catch {}
    };
  }, [status.connected, topic, nick]);

  return React.createElement(
    React.Fragment,
    null,
    connecting
      ? React.createElement(
          'div',
          { className: 'overlay' },
          React.createElement(
            'div',
            { className: 'overlayCard' },
            React.createElement('div', { className: 'spinner' }),
            React.createElement('div', { style: { fontWeight: 900 } }, 'Connecting…'),
            React.createElement(
              'div',
              { className: 'muted', style: { textAlign: 'center' } },
              'Finding other players and establishing a route.',
            ),
          ),
        )
      : null,
    React.createElement(
      'div',
      { className: 'topbar' },
      React.createElement('div', { className: 'brand' }, 'PubSub Live Game'),
      React.createElement('div', { className: 'pill' }, status.connected ? 'online' : 'offline'),
      status.connected ? React.createElement('div', { className: 'pill' }, `peers ${peerCount}`) : null,
      status.connected ? React.createElement('div', { className: 'muted' }, topic) : null,
    ),
    React.createElement(
      'div',
      { className: 'wrap' },
      React.createElement(
        'div',
        { className: 'grid' },
        React.createElement(
          'div',
          { className: 'card' },
          React.createElement(
            'div',
            { className: 'col' },
            React.createElement('div', { className: 'muted' }, 'Room & Nickname (session only)'),
            React.createElement(
              'label',
              null,
              'Room',
              React.createElement('input', { value: room, onChange: (e) => setRoom(e.target.value), disabled: status.connected }),
            ),
            React.createElement(
              'label',
              null,
              'Nickname',
              React.createElement('input', { value: nick, onChange: (e) => setNick(e.target.value), disabled: status.connected }),
            ),
            err ? React.createElement('div', { className: 'danger' }, err) : null,
            React.createElement(
              'div',
              { className: 'row' },
              status.connected
                ? React.createElement('button', { className: 'btn', type: 'button', onClick: disconnect }, 'Disconnect')
                : React.createElement('button', { className: 'btn primary', type: 'button', onClick: connect, disabled: connecting }, connecting ? 'Connecting…' : 'Connect'),
            ),
            status.connected && peerCount === 0 && searchUntil
              ? React.createElement('div', { className: 'muted' }, 'No players found yet. Keep this tab open…')
              : null,
            React.createElement('div', { className: 'muted' }, 'Move your cursor on the canvas. Updates are signed and broadcast over PubSub.'),
            React.createElement('div', { className: 'log' }, lines.join('\n') || 'Ready.'),
          ),
        ),
        React.createElement(
          'div',
          { className: 'card', style: { padding: 0 } },
          React.createElement('canvas', { ref: canvasRef }),
        ),
      ),
    ),
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App));
