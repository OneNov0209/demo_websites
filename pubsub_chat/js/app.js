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

function hashColor(str) {
  const s = String(str || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 85% 55%)`;
}

function shortAddr(addr) {
  const a = String(addr || '');
  if (a.length <= 16) return a;
  return `${a.slice(0, 7)}…${a.slice(-5)}`;
}

function encodePayload(type, fields) {
  const entries = Object.entries(fields || {}).map(([k, v]) => [String(k), String(v)]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const parts = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `pubsub_chat|v1|${type}|` + parts.join('|');
}

function decodePayload(payload) {
  const s = String(payload || '');
  const parts = s.split('|');
  if (parts.length < 4) return null;
  if (parts[0] !== 'pubsub_chat' || parts[1] !== 'v1') return null;
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

const BLOCKLIST_KEY_PREFIX = 'lumen.pubsub_chat.blocklist.v1:';
const MY_NICK_KEY = 'lumen.pubsub_chat.myNick.v1';
const CHAT_DB_NAME = 'lumen_pubsub_chat_v1';
const CHAT_DB_VERSION = 1;

function blocklistStorageKey(topic) {
  return `${BLOCKLIST_KEY_PREFIX}${encodeURIComponent(String(topic || '').trim())}`;
}

function loadBlocklist(topic) {
  try {
    const raw = localStorage.getItem(blocklistStorageKey(topic));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveBlocklist(topic, blocklist) {
  try {
    localStorage.setItem(blocklistStorageKey(topic), JSON.stringify(blocklist || {}));
  } catch {}
}

function loadMyNick() {
  try {
    const s = String(localStorage.getItem(MY_NICK_KEY) || '').trim();
    return s ? s.slice(0, 22) : '';
  } catch {
    return '';
  }
}

function saveMyNick(nick) {
  try {
    const s = String(nick || '').trim().slice(0, 22);
    if (!s) return;
    localStorage.setItem(MY_NICK_KEY, s);
  } catch {}
}

let CHAT_DB_PROMISE = null;

function openChatDb() {
  if (CHAT_DB_PROMISE) return CHAT_DB_PROMISE;
  CHAT_DB_PROMISE = new Promise((resolve, reject) => {
    try {
      const idb = window?.indexedDB;
      if (!idb) return reject(new Error('indexedDB unavailable'));
      const req = idb.open(CHAT_DB_NAME, CHAT_DB_VERSION);
      req.onerror = () => reject(req.error || new Error('db_open_failed'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'pk' });
          store.createIndex('by_topic_ts', ['topic', 'ts'], { unique: false });
        }
        if (!db.objectStoreNames.contains('names')) {
          const store = db.createObjectStore('names', { keyPath: 'pk' });
          store.createIndex('by_topic', 'topic', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
    } catch (e) {
      reject(e);
    }
  });
  return CHAT_DB_PROMISE;
}

function dbTx(db, storeNames, mode) {
  const tx = db.transaction(storeNames, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('tx_failed'));
    tx.onabort = () => reject(tx.error || new Error('tx_aborted'));
  });
  return { tx, done };
}

async function dbPutName(topic, addr, nick, updatedAt) {
  const t = String(topic || '').trim();
  const a = String(addr || '').trim();
  const n = String(nick || '').trim().slice(0, 22);
  if (!t || !a || !n) return;
  const db = await openChatDb();
  const { tx, done } = dbTx(db, ['names'], 'readwrite');
  tx.objectStore('names').put({ pk: `${t}|${a}`, topic: t, addr: a, nick: n, updatedAt: Number(updatedAt || 0) || nowMs() });
  await done;
}

async function dbGetNames(topic) {
  const t = String(topic || '').trim();
  if (!t) return {};
  const db = await openChatDb();
  const { tx, done } = dbTx(db, ['names'], 'readonly');
  const store = tx.objectStore('names');
  const idx = store.index('by_topic');
  const out = {};
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(t));
    req.onerror = () => reject(req.error || new Error('cursor_failed'));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      try {
        const v = cur.value;
        const addr = String(v?.addr || '').trim();
        const nick = String(v?.nick || '').trim();
        if (addr && nick) out[addr] = nick;
      } catch {}
      cur.continue();
    };
  });
  await done.catch(() => {});
  return out;
}

async function dbPutMessage(topic, entry) {
  const t = String(topic || '').trim();
  const id = String(entry?.id || '').trim();
  const addr = String(entry?.addr || '').trim();
  const text = String(entry?.text || '');
  const ts = Number(entry?.ts || 0) || nowMs();
  if (!t || !id || !addr) return;
  const db = await openChatDb();
  const { tx, done } = dbTx(db, ['messages'], 'readwrite');
  tx.objectStore('messages').put({ pk: `${t}|${id}`, topic: t, ts, id, addr, text });
  await done;
}

async function dbGetRecentMessages(topic, limit = 240) {
  const t = String(topic || '').trim();
  const lim = Math.max(1, Math.min(2000, Number(limit || 0) || 240));
  if (!t) return [];
  const db = await openChatDb();
  const { tx, done } = dbTx(db, ['messages'], 'readonly');
  const store = tx.objectStore('messages');
  const idx = store.index('by_topic_ts');
  const maxTs = Number.MAX_SAFE_INTEGER;
  const range = IDBKeyRange.bound([t, 0], [t, maxTs]);
  const rows = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(range, 'prev');
    req.onerror = () => reject(req.error || new Error('cursor_failed'));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      rows.push(cur.value);
      if (rows.length >= lim) return resolve();
      cur.continue();
    };
  });
  await done.catch(() => {});
  rows.reverse();
  return rows.map((r) => ({
    id: String(r?.id || '').trim(),
    addr: String(r?.addr || '').trim(),
    text: String(r?.text || ''),
    ts: Number(r?.ts || 0) || nowMs(),
  })).filter((m) => m.id && m.addr);
}

async function dbClearMessages(topic) {
  const t = String(topic || '').trim();
  if (!t) return;
  const db = await openChatDb();
  const { tx, done } = dbTx(db, ['messages'], 'readwrite');
  const store = tx.objectStore('messages');
  const idx = store.index('by_topic_ts');
  const maxTs = Number.MAX_SAFE_INTEGER;
  const range = IDBKeyRange.bound([t, 0], [t, maxTs]);
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(range);
    req.onerror = () => reject(req.error || new Error('cursor_failed'));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      try { cur.delete(); } catch {}
      cur.continue();
    };
  });
  await done.catch(() => {});
}

const POW_DIFFICULTY_BITS = 12;
const AUTO_BLOCK_WINDOW_MS = 2000;
const AUTO_BLOCK_MAX_MESSAGES = 10;
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_FIRST_DELAY_MS = 12_000;
const PEER_STALE_MS = 12_000;
const PRESENCE_LEAVE_TIMEOUT_MS = 90_000;
const PRESENCE_SWEEP_INTERVAL_MS = 5_000;

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    for (let i = 7; i >= 0; i--) {
      if (b & (1 << i)) return bits;
      bits += 1;
    }
    return bits;
  }
  return bits;
}

async function sha256Utf8(str) {
  const s = String(str || '');
  const cryptoObj = window?.crypto;
  if (!cryptoObj?.subtle?.digest) throw new Error('WebCrypto unavailable (crypto.subtle.digest)');
  const data = new TextEncoder().encode(s);
  const hash = await cryptoObj.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

async function hasValidPow(payload, bits = POW_DIFFICULTY_BITS) {
  const hash = await sha256Utf8(payload);
  return leadingZeroBits(hash) >= bits;
}

async function minePowPayload(type, baseFields, bits = POW_DIFFICULTY_BITS) {
  let attempts = 0;
  const base = { ...(baseFields || {}) };
  while (true) {
    const nonce = randHex(16);
    const payload = encodePayload(type, { ...base, nonce });
    if (await hasValidPow(payload, bits)) return { payload, nonce, attempts: attempts + 1 };
    attempts += 1;
    if (attempts % 64 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

function useToast() {
  const [toast, setToast] = useState({ open: false, kind: 'info', title: '', message: '' });
  const timerRef = useRef(null);

  function hide() {
    setToast((t) => ({ ...t, open: false }));
  }

  function show(title, message, kind = 'info', ms = 2500) {
    const t = String(title || '').trim();
    const m = String(message || '').trim();
    if (!t && !m) return;
    setToast({ open: true, kind, title: t, message: m });
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

function App() {
  const [room, setRoom] = useState('lobby');
  const [nick, setNick] = useState(() => loadMyNick() || 'anon-' + randHex(3));
  const [text, setText] = useState('');
  const [status, setStatus] = useState({ connected: false, topic: '', subId: '', address: '', topics: [] });
  const [err, setErr] = useState('');
  const [peerCount, setPeerCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState([]); // {id, addr, kind, text, ts}
  const [nameByAddr, setNameByAddr] = useState({}); // addr -> nick
  const [rxStats, setRxStats] = useState({ total: 0, accepted: 0, dropped: 0, lastDrop: '' });
  const [blockedByAddr, setBlockedByAddr] = useState(() =>
    loadBlocklist(`lumen/pubsub_chat/v1/${String(room || 'lobby').trim().toLowerCase()}`)
  ); // addr -> {addr,name,blockedAt,reason}
  const [userModal, setUserModal] = useState(null); // { addr }
  const { toast, show } = useToast();

  const chatBodyRef = useRef(null);
  const subRef = useRef({ unsubscribe: null });
  const connectSeqRef = useRef(0);
  const lastSentAtRef = useRef(0);
  const lastAcceptedAtRef = useRef(new Map()); // addr -> ms
  const recentNoncesRef = useRef(new Map()); // addr -> array of nonces
  const seenMsgIdRef = useRef(new Set()); // message ids
  const spamWindowRef = useRef(new Map()); // addr -> timestamps (last 2s)
  const blockedByAddrRef = useRef({});
  const lastPeerSeenAtRef = useRef(0);
  const lastRemoteSeenAtRef = useRef(0);
  const lastHeartbeatAtRef = useRef(0);
  const lastPersistedNameRef = useRef(new Map()); // addr -> nick
  const presenceRef = useRef(new Map()); // addr -> { lastSeenAt }
  const heartbeatInFlightRef = useRef(false);
  const sendingRef = useRef(false);
  const topicRef = useRef(`lumen/pubsub_chat/v1/${String(room || 'lobby').trim().toLowerCase()}`);

  const topic = useMemo(
    () => `lumen/pubsub_chat/v1/${String(room || 'lobby').trim().toLowerCase()}`,
    [room]
  );

  useEffect(() => {
    topicRef.current = topic;
    setUserModal(null);
    presenceRef.current = new Map();
  }, [topic]);

  useEffect(() => {
    const next = loadBlocklist(topic);
    setBlockedByAddr(next);
  }, [topic]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [names, msgs] = await Promise.all([
          dbGetNames(topic).catch(() => ({})),
          dbGetRecentMessages(topic, 240).catch(() => []),
        ]);
        if (!alive) return;
        const blocked = loadBlocklist(topic);
        lastPersistedNameRef.current = new Map(Object.entries(names || {}));
        setNameByAddr(names || {});
        setMessages(Array.isArray(msgs) ? msgs.filter((m) => !blocked[String(m?.addr || '').trim()]) : []);
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [topic]);

  useEffect(() => {
    blockedByAddrRef.current = blockedByAddr || {};
    saveBlocklist(topicRef.current, blockedByAddrRef.current);
  }, [blockedByAddr]);

  useEffect(() => {
    const blocked = blockedByAddr || {};
    setMessages((prev) => prev.filter((m) => !blocked[String(m?.addr || '').trim()]));
  }, [blockedByAddr]);

  function canSendNow() {
    const now = nowMs();
    return now - lastSentAtRef.current >= 1000;
  }

  function scrollToBottom() {
    try {
      const el = chatBodyRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    } catch {}
  }

  useEffect(() => {
    scrollToBottom();
  }, [messages.length]);

  useEffect(() => {
    saveMyNick(nick);
  }, [nick]);

  useEffect(() => {
    if (status.address) updateName(status.address, nick);
  }, [status.address, nick]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

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
    if (!api?.wallet?.verifyArbitrary) throw new Error('lumen.wallet.verifyArbitrary unavailable');
    const res = await api.wallet.verifyArbitrary({
      algo: 'ADR-036',
      payload,
      signatureB64,
      pubkeyB64,
      address,
    });
    const signatureValid = !!(res && (res.signatureValid ?? res.ok));
    const addressMatches = !!(res && (res.addressMatches ?? res.ok));
    const derivedAddress = String((res && (res.derivedAddress || res.derivedAddr)) || '').trim();
    const error = res && res.error ? String(res.error) : '';
    return { ok: !!(res && res.ok), signatureValid, addressMatches, derivedAddress, error };
  }

  function markSeenNonce(address, nonce) {
    const addr = String(address || '').trim();
    const n = String(nonce || '').trim();
    if (!addr || !n) return false;
    const existing = recentNoncesRef.current.get(addr) || [];
    if (existing.includes(n)) return false;
    const next = existing.length >= 24 ? existing.slice(existing.length - 20) : existing.slice();
    next.push(n);
    recentNoncesRef.current.set(addr, next);
    return true;
  }

  function isRateLimited(address) {
    const addr = String(address || '').trim();
    if (!addr) return true;
    const last = lastAcceptedAtRef.current.get(addr) || 0;
    const now = nowMs();
    if (now - last < 1000) return true; // 1 msg/sec
    lastAcceptedAtRef.current.set(addr, now);
    return false;
  }

  function recordSpam(address) {
    const addr = String(address || '').trim();
    if (!addr) return 0;
    const now = nowMs();
    const prev = spamWindowRef.current.get(addr) || [];
    const next = prev.filter((t) => now - t < AUTO_BLOCK_WINDOW_MS);
    next.push(now);
    spamWindowRef.current.set(addr, next);
    return next.length;
  }

  function updateName(address, nextNick) {
    const addr = String(address || '').trim();
    const nn = String(nextNick || '').trim().slice(0, 22);
    if (!addr || !nn) return;
    setNameByAddr((prev) => {
      if (prev[addr] === nn) return prev;
      return { ...prev, [addr]: nn };
    });
    const last = lastPersistedNameRef.current.get(addr) || '';
    if (last !== nn) {
      lastPersistedNameRef.current.set(addr, nn);
      void dbPutName(topicRef.current, addr, nn, nowMs()).catch(() => {});
    }
  }

  function isBlocked(address) {
    const addr = String(address || '').trim();
    if (!addr) return false;
    return !!blockedByAddrRef.current[addr];
  }

  function blockUser(address, reason = 'manual', displayName) {
    const addr = String(address || '').trim();
    if (!addr) return;
    if (addr && status.address && addr === status.address) return;

    const display = String(displayName || nameByAddr[addr] || 'anon')
      .trim()
      .slice(0, 22) || 'anon';
    const ts = nowMs();
    setBlockedByAddr((prev) => {
      if (prev && prev[addr]) return prev;
      const next = { ...(prev || {}) };
      next[addr] = { addr, name: display, blockedAt: ts, reason: String(reason || 'manual') };
      return next;
    });

    setMessages((prev) => prev.filter((m) => m.addr !== addr));
    try { presenceRef.current.delete(addr); } catch {}
    show('User blocked', `${shortAddr(addr)} blocked in this room`, 'info', 2200);
  }

  function unblockUser(address) {
    const addr = String(address || '').trim();
    if (!addr) return;
    setBlockedByAddr((prev) => {
      if (!prev || !prev[addr]) return prev || {};
      const next = { ...prev };
      delete next[addr];
      return next;
    });
    show('User unblocked', `${shortAddr(addr)} can speak again in this room`, 'success', 2200);
  }

  function openUserModalFor(address) {
    const addr = String(address || '').trim();
    if (!addr) return;
    if (addr && status.address && addr === status.address) return;
    setUserModal({ addr });
  }

  function pushMessage(entry) {
    setMessages((prev) => {
      const next = prev.length > 240 ? prev.slice(prev.length - 200) : prev.slice();
      next.push(entry);
      return next;
    });
    if (entry && (entry.kind === 'system' || entry.persist === false)) return;
    void dbPutMessage(topicRef.current, entry).catch(() => {});
  }

  function pushPresenceEvent(event, address) {
    const ev = String(event || '').trim();
    const addr = String(address || '').trim();
    if (!ev || !addr) return;
    const ts = nowMs();
    pushMessage({ id: `sys:${ev}:${addr}:${ts}`, kind: 'system', event: ev, addr, ts, persist: false });
  }

  async function publishSigned(type, fields) {
    const api = L();
    if (!api?.pubsub?.publish) throw new Error('lumen.pubsub.publish unavailable');
    const { profileId, address } = await getActiveProfile();
    const safeNick = String(nick || '').trim().slice(0, 22) || 'anon';
    const ts = nowMs();
    const baseFields = {
      room: topic,
      ts: String(ts),
      addr: address,
      nick: safeNick,
      ...fields,
    };
    const { payload, nonce } = await minePowPayload(type, baseFields, POW_DIFFICULTY_BITS);
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
    return { address: msg.address, nonce, ts, type, payload };
  }

  async function connect() {
    if (status.connected) return;
    const mySeq = ++connectSeqRef.current;
    setErr('');
    const api = L();
    if (!api?.pubsub?.subscribe) {
      setErr('window.lumen.pubsub is not available in this context.');
      return;
    }
    if (!api?.wallet?.signArbitrary || !api?.wallet?.verifyArbitrary) {
      setErr('window.lumen.wallet.signArbitrary/verifyArbitrary is not available in this context.');
      return;
    }

    setRxStats({ total: 0, accepted: 0, dropped: 0, lastDrop: '' });
    lastAcceptedAtRef.current = new Map();
    recentNoncesRef.current = new Map();
    seenMsgIdRef.current = new Set();
    spamWindowRef.current = new Map();
    lastPeerSeenAtRef.current = 0;
    lastRemoteSeenAtRef.current = 0;
    lastHeartbeatAtRef.current = 0;
    presenceRef.current = new Map();

    show('Connecting', `Subscribing to ${topic}`, 'info', 2200);

    try {
      const { address: selfAddress } = await getActiveProfile();
      updateName(selfAddress, nick);
      const sub = await api.pubsub.subscribe(
        topic,
        { encoding: 'json', autoConnect: true },
        async (m) => {
          try {
            setRxStats((s) => ({ ...s, total: s.total + 1 }));
            const data = m?.json;
            if (!data || typeof data !== 'object') {
              const sample = String(m?.text || '').trim().replace(/\s+/g, ' ').slice(0, 60);
              setRxStats((s) => ({
                ...s,
                dropped: s.dropped + 1,
                lastDrop: sample ? `bad_json:${sample}` : 'bad_json',
              }));
              return;
            }

            const payload = String(data.payload || '');
            const address = String(data.address || '').trim();
            const pubkeyB64 = String(data.pubkeyB64 || '').trim();
            const signatureB64 = String(data.signatureB64 || '').trim();
            if (!payload || !address || !pubkeyB64 || !signatureB64) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'missing_fields' }));
              return;
            }

            const parsed = decodePayload(payload);
            if (!parsed) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'bad_payload' }));
              return;
            }
            if (String(parsed.room || '') !== topic) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'wrong_room' }));
              return;
            }

            const nonce = String(parsed.nonce || '').trim();
            if (!nonce || nonce.length > 20) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'bad_nonce' }));
              return;
            }

            try {
              const okPow = await hasValidPow(payload, POW_DIFFICULTY_BITS);
              if (!okPow) {
                setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'bad_pow' }));
                return;
              }
            } catch (e) {
              const suffix = String(e?.message || e || '').trim();
              setRxStats((s) => ({
                ...s,
                dropped: s.dropped + 1,
                lastDrop: suffix ? `pow_error:${suffix.slice(0, 40)}` : 'pow_error',
              }));
              return;
            }

            const v = await verifyPayload(payload, signatureB64, pubkeyB64, address);
            if (!v.signatureValid) {
              const suffix = v.error ? `:${String(v.error).slice(0, 60)}` : '';
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: `bad_sig${suffix}` }));
              return;
            }

            const canonicalAddr = v.derivedAddress || address;
            const msgId = `${canonicalAddr}:${nonce}`;
            if (seenMsgIdRef.current.has(msgId)) return;
            seenMsgIdRef.current.add(msgId);

            if (isBlocked(canonicalAddr)) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'blocked' }));
              return;
            }

            if (!markSeenNonce(canonicalAddr, nonce)) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'nonce_replay' }));
              return;
            }

            const safeNick = String(parsed.nick || '').trim().slice(0, 22);
            if (safeNick) updateName(canonicalAddr, safeNick);

            const kind = String(parsed.type || '');

            const spamCount = recordSpam(canonicalAddr);
            if (spamCount > AUTO_BLOCK_MAX_MESSAGES) {
              blockUser(canonicalAddr, 'auto_spam', safeNick);
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'auto_blocked' }));
              return;
            }

            // Presence (best-effort): emit join/leave events in the chat stream.
            if (canonicalAddr && canonicalAddr !== selfAddress) {
              if (kind === 'leave') {
                if (presenceRef.current.has(canonicalAddr)) presenceRef.current.delete(canonicalAddr);
                pushPresenceEvent('leave', canonicalAddr);
              } else {
                const existed = presenceRef.current.has(canonicalAddr);
                presenceRef.current.set(canonicalAddr, { lastSeenAt: nowMs() });
                if (!existed) pushPresenceEvent('join', canonicalAddr);
              }
            }

            if (kind === 'profile') {
              if (isRateLimited(canonicalAddr)) {
                setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'rate_limited' }));
                return;
              }
              if (canonicalAddr && canonicalAddr !== selfAddress) lastRemoteSeenAtRef.current = nowMs();
              setRxStats((s) => ({ ...s, accepted: s.accepted + 1 }));
              return;
            }

            if (kind === 'ping') {
              if (canonicalAddr && canonicalAddr !== selfAddress) lastRemoteSeenAtRef.current = nowMs();
              setRxStats((s) => ({ ...s, accepted: s.accepted + 1 }));
              return;
            }

            if (kind === 'leave') {
              if (canonicalAddr && canonicalAddr !== selfAddress) lastRemoteSeenAtRef.current = nowMs();
              setRxStats((s) => ({ ...s, accepted: s.accepted + 1 }));
              return;
            }

            if (kind !== 'msg') {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'unknown_type' }));
              return;
            }

            if (isRateLimited(canonicalAddr)) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'rate_limited' }));
              return;
            }
            if (canonicalAddr && canonicalAddr !== selfAddress) lastRemoteSeenAtRef.current = nowMs();

            const txt = String(parsed.text || '').trim();
            if (!txt) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'empty_text' }));
              return;
            }
            if (txt.length > 500) {
              setRxStats((s) => ({ ...s, dropped: s.dropped + 1, lastDrop: 'text_too_long' }));
              return;
            }

            const ts = Number(parsed.ts || 0) || nowMs();
            pushMessage({
              id: msgId,
              addr: canonicalAddr,
              text: txt,
              ts,
            });
            setRxStats((s) => ({ ...s, accepted: s.accepted + 1 }));
          } catch {
            // ignore invalid messages
          }
        }
      );

      if (connectSeqRef.current !== mySeq) {
        try { await sub.unsubscribe(); } catch {}
        return;
      }

      subRef.current.unsubscribe = sub.unsubscribe;
      setStatus({
        connected: true,
        topic,
        subId: String(sub.subId || ''),
        address: selfAddress,
        topics: Array.isArray(sub.topics) ? sub.topics : [],
      });
      show('Connected', `Room: ${room}`, 'success', 1800);

      // announce my nickname (signed)
      try {
        await publishSigned('profile', {});
      } catch {}
    } catch (e) {
      setErr(String(e?.message || e || 'Connect failed'));
      show('Connect failed', String(e?.message || e || 'unknown error'), 'error', 3500);
    }
  }

  async function disconnect() {
    connectSeqRef.current += 1;
    setPeerCount(0);
    try {
      if (status.connected) await publishSigned('leave', {});
    } catch {}
    try {
      const u = subRef.current.unsubscribe;
      subRef.current.unsubscribe = null;
      if (u) await u();
    } catch {}
    presenceRef.current = new Map();
    setStatus({ connected: false, topic: '', subId: '', address: '', topics: [] });
    show('Disconnected', 'Stopped listening to PubSub', 'info', 1800);
  }

  // PubSub peer count (best-effort)
  useEffect(() => {
    if (!status.connected) return;
    let alive = true;
    const api = L();
    const tick = async () => {
      if (!alive) return;
      try {
        const res = await api?.pubsub?.peers?.(topic);
        const peers = Array.isArray(res?.peers) ? res.peers : [];
        if (peers.length > 0) lastPeerSeenAtRef.current = nowMs();
        if (alive) setPeerCount(peers.length);
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      try { clearInterval(t); } catch {}
    };
  }, [status.connected, topic]);

  // Best-effort presence: if a peer stops sending (no msg/profile/ping/leave), emit "left" after a timeout.
  useEffect(() => {
    if (!status.connected) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const now = nowMs();
      const selfAddr = String(status.address || '').trim();
      for (const [addr, rec] of presenceRef.current.entries()) {
        if (!addr || addr === selfAddr) continue;
        const lastSeenAt = Number(rec?.lastSeenAt || 0) || 0;
        if (lastSeenAt && now - lastSeenAt > PRESENCE_LEAVE_TIMEOUT_MS) {
          presenceRef.current.delete(addr);
          pushPresenceEvent('leave', addr);
        }
      }
    };
    const t = setInterval(tick, PRESENCE_SWEEP_INTERVAL_MS);
    return () => {
      alive = false;
      try { clearInterval(t); } catch {}
    };
  }, [status.connected, status.address]);

  // Heartbeat (signed + PoW) to keep PubSub streams active.
  useEffect(() => {
    if (!status.connected) return;
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      if (sendingRef.current) return;
      const peerSeenAt = Math.max(lastPeerSeenAtRef.current, lastRemoteSeenAtRef.current);
      if (!peerSeenAt) return; // don't mine heartbeats while truly alone
      const now = nowMs();
      if (now - lastHeartbeatAtRef.current < HEARTBEAT_INTERVAL_MS - 500) return;
      if (heartbeatInFlightRef.current) return;

      heartbeatInFlightRef.current = true;
      try {
        await publishSigned('ping', {});
        lastHeartbeatAtRef.current = nowMs();
      } catch {}
      heartbeatInFlightRef.current = false;
    };

    const t0 = setTimeout(tick, HEARTBEAT_FIRST_DELAY_MS);
    const t = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => {
      alive = false;
      try { clearTimeout(t0); } catch {}
      try { clearInterval(t); } catch {}
      heartbeatInFlightRef.current = false;
    };
  }, [status.connected, topic]);

  async function sendMessage() {
    if (!status.connected) {
      show('Not connected', 'Connect to a room first', 'warning', 2200);
      return;
    }
    if (sending) return;
    const msg = String(text || '').trim();
    if (!msg) return;
    if (msg.length > 500) {
      show('Message too long', 'Max 500 characters', 'warning', 2200);
      return;
    }
    if (!canSendNow()) {
      show('Slow down', '1 message per second', 'warning', 1600);
      return;
    }
    if (peerCount <= 0 && nowMs() - Math.max(lastPeerSeenAtRef.current, lastRemoteSeenAtRef.current) > PEER_STALE_MS) {
      show('No peers detected', 'Message will be sent anyway, but may not be received yet.', 'info', 2400);
    }
    setSending(true);
    lastSentAtRef.current = nowMs();
    try {
      const res = await publishSigned('msg', { text: msg });
      setText('');
      if (res?.address && res?.nonce) {
        updateName(res.address, String(nick || '').trim().slice(0, 22));
        const msgId = `${res.address}:${res.nonce}`;
        if (!seenMsgIdRef.current.has(msgId)) {
          seenMsgIdRef.current.add(msgId);
          markSeenNonce(res.address, res.nonce);
          pushMessage({
            id: msgId,
            addr: res.address,
            text: msg,
            ts: res.ts || nowMs(),
          });
        }
      }
    } catch (e) {
      show('Send failed', String(e?.message || e || 'unknown error'), 'error', 3200);
    } finally {
      setSending(false);
    }
  }

  async function updateProfile() {
    if (!status.connected) {
      show('Not connected', 'Connect to a room first', 'warning', 2200);
      return;
    }
    if (!canSendNow()) {
      show('Slow down', '1 message per second', 'warning', 1600);
      return;
    }
    lastSentAtRef.current = nowMs();
    try {
      await publishSigned('profile', {});
      show('Updated', 'Your display name was broadcast', 'success', 1600);
    } catch (e) {
      show('Update failed', String(e?.message || e || 'unknown error'), 'error', 2800);
    }
  }

  const myDisplay = useMemo(() => {
    if (!status.address) return '';
    const n = nameByAddr[status.address] || String(nick || '').trim().slice(0, 22);
    return n ? `${n} (${shortAddr(status.address)})` : shortAddr(status.address);
  }, [status.address, nameByAddr, nick]);

  const blockedList = useMemo(() => {
    const values = Object.values(blockedByAddr || {}).filter(Boolean);
    values.sort((a, b) => Number(b.blockedAt || 0) - Number(a.blockedAt || 0));
    return values;
  }, [blockedByAddr]);

  const isAlone =
    status.connected && peerCount <= 0 && nowMs() - Math.max(lastPeerSeenAtRef.current, lastRemoteSeenAtRef.current) > PEER_STALE_MS;
  const composeDisabled = !status.connected || sending;

  const modalAddr = String(userModal?.addr || '').trim();
  const modalBlock = modalAddr ? blockedByAddr[modalAddr] : null;
  const modalName = modalAddr ? String(nameByAddr[modalAddr] || modalBlock?.name || 'anon').trim() : '';

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'topbar' },
      React.createElement('div', { className: 'brand' }, 'PubSub Chat'),
      React.createElement('span', { className: 'pill' }, 'signed messages • ADR-036 • PoW'),
      React.createElement('span', { className: 'pill' }, status.connected ? 'connected' : 'disconnected'),
      status.connected
        ? React.createElement('span', { className: 'pill' }, `rx: ${rxStats.accepted}/${rxStats.total}`)
        : null,
      status.connected && rxStats.lastDrop
        ? React.createElement('span', { className: 'pill' }, `drop: ${rxStats.lastDrop}`)
        : null,
      React.createElement('div', { style: { marginLeft: 'auto' } }),
      status.connected
        ? React.createElement('button', { className: 'btn danger', type: 'button', onClick: disconnect }, 'Disconnect')
        : React.createElement('button', { className: 'btn primary', type: 'button', onClick: connect }, 'Connect')
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
            React.createElement(
              'label',
              null,
              'Room',
              React.createElement('input', {
                value: room,
                onChange: (e) => setRoom(String(e?.target?.value || '')),
                disabled: status.connected,
                placeholder: 'lobby',
              })
            ),
            React.createElement(
              'label',
              null,
              'Display name',
              React.createElement('input', {
                value: nick,
                onChange: (e) => setNick(String(e?.target?.value || '').slice(0, 22)),
                placeholder: 'Your name',
              })
            ),
            React.createElement(
              'div',
              { className: 'row' },
              React.createElement(
                'button',
                { className: 'btn', type: 'button', onClick: updateProfile, disabled: !status.connected },
                'Broadcast name'
              ),
              React.createElement(
                'button',
                {
                  className: 'btn',
                  type: 'button',
                  onClick: async () => {
                    setMessages([]);
                    try { await dbClearMessages(topicRef.current); } catch {}
                    show('Cleared', 'Local chat cleared', 'info', 1400);
                  },
                },
                'Clear'
              )
            ),
            status.connected
              ? React.createElement('div', { className: 'muted' }, 'Connected as ', React.createElement('b', null, myDisplay))
              : React.createElement('div', { className: 'muted' }, 'Connect to start chatting.'),
            status.connected && status.topics && status.topics.length
              ? React.createElement(
                  'div',
                  { className: 'muted', style: { fontSize: 12 } },
                  React.createElement('b', null, 'Subscribed topic variants:'),
                  ' ',
                  status.topics.join(', ')
                )
              : null,
            status.connected && rxStats.lastDrop
              ? React.createElement(
                  'div',
                  { className: 'muted', style: { fontSize: 12 } },
                  `Last drop: ${rxStats.lastDrop} (dropped ${rxStats.dropped})`
                )
              : null,
            React.createElement(
              'div',
              { className: 'muted', style: { fontSize: 12 } },
              React.createElement('b', null, 'Security:'),
              ` ADR-036 signatures + PoW (${POW_DIFFICULTY_BITS} bits). Rate-limit: 1 msg/sec accepted. Auto-block: >${AUTO_BLOCK_MAX_MESSAGES} msgs/${AUTO_BLOCK_WINDOW_MS}ms.`
            ),
            React.createElement(
              'div',
              { className: 'muted', style: { fontSize: 12 } },
              React.createElement('b', null, 'Blocklist (this room):'),
              ' click a user message to block.'
            ),
            blockedList.length
              ? React.createElement(
                  'ul',
                  { className: 'list' },
                  blockedList.map((b) => {
                    const n = String(nameByAddr[b.addr] || b.name || 'anon')
                      .trim()
                      .slice(0, 22);
                    return React.createElement(
                      'li',
                      { key: b.addr, className: 'listItem' },
                      React.createElement(
                        'div',
                        { className: 'listLeft' },
                        React.createElement('div', { className: 'listTitle' }, n || 'anon'),
                        React.createElement('div', { className: 'listSub' }, shortAddr(b.addr))
                      ),
                      React.createElement(
                        'button',
                        { className: 'btn', type: 'button', onClick: () => unblockUser(b.addr) },
                        'Unblock'
                      )
                    );
                  })
                )
              : React.createElement(
                  'div',
                  { className: 'muted', style: { fontSize: 12 } },
                  status.connected ? 'No blocked users in this room.' : 'No blocked users for this room.'
                ),
            err ? React.createElement('div', { className: 'danger' }, err) : null
          )
        ),
        React.createElement(
          'div',
          { className: 'chat' },
          React.createElement(
            'div',
            { className: 'chatHeader' },
            React.createElement('div', { style: { fontWeight: 900 } }, status.connected ? `#${room}` : 'Chat'),
            React.createElement('div', { className: 'muted' }, status.connected ? 'connected' : 'offline')
          ),
          React.createElement(
            'div',
            { className: 'chatBody', ref: chatBodyRef },
            isAlone
              ? React.createElement(
                  'div',
                  {
                    className: 'muted',
                    style: {
                      padding: 10,
                      border: '1px dashed var(--border)',
                      borderRadius: 12,
                      background: 'rgba(0,0,0,.18)',
                      marginBottom: 10,
                    },
                  },
                  React.createElement('b', { style: { color: '#fff' } }, 'No peers detected yet.'),
                  ' You can still send messages, but they may not be received until someone joins.'
                )
              : null,
            messages.length
              ? messages.map((m) => {
                  if (m && m.kind === 'system') {
                    const addr = String(m.addr || '').trim();
                    const ev = String(m.event || '').trim();
                    const n = addr ? String(nameByAddr[addr] || 'anon').trim().slice(0, 22) : '';
                    const who = addr ? `${n || 'anon'} (${shortAddr(addr)})` : 'unknown';
                    const line = ev === 'join' ? `${who} joined.` : ev === 'leave' ? `${who} left.` : String(m.text || '').trim();
                    return React.createElement(
                      'div',
                      {
                        key: m.id,
                        className: 'muted',
                        style: { padding: '6px 10px', textAlign: 'center', fontSize: 12 },
                      },
                      line
                    );
                  }
                  const name = nameByAddr[m.addr] || 'anon';
                  const color = hashColor(m.addr);
                  const letter = String(name || '?').slice(0, 1).toUpperCase();
                  const isMine = !!(status.address && m.addr === status.address);
                  return React.createElement(
                    'div',
                    {
                      key: m.id,
                      className: 'msg',
                      onClick: isMine ? null : () => openUserModalFor(m.addr),
                      style: isMine ? null : { cursor: 'pointer' },
                      title: isMine ? null : 'Click for actions',
                    },
                    React.createElement('div', { className: 'avatar', style: { borderColor: color, color } }, letter),
                    React.createElement(
                      'div',
                      { className: 'msgMain' },
                      React.createElement(
                        'div',
                        { className: 'msgMeta' },
                        React.createElement('div', { className: 'msgName', style: { color } }, name),
                        React.createElement('div', { className: 'msgAddr' }, shortAddr(m.addr)),
                        React.createElement('div', { className: 'msgTime' }, new Date(m.ts || nowMs()).toLocaleTimeString())
                      ),
                      React.createElement('div', { className: 'msgText' }, m.text)
                    )
                  );
                })
              : React.createElement(
                  'div',
                  { className: 'muted', style: { padding: 10 } },
                  status.connected ? 'No messages yet.' : 'Connect to start chatting.'
                )
          ),
          React.createElement(
            'div',
            { className: 'composer' },
            React.createElement('input', {
              value: text,
              onChange: (e) => setText(String(e?.target?.value || '').slice(0, 500)),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              },
              placeholder: status.connected
                ? isAlone
                  ? 'No peers yet (you can still send).'
                  : 'Type a message.'
                : 'Connect to a room to chat.',
              disabled: composeDisabled,
            }),
            React.createElement(
              'button',
              { className: 'btn primary', type: 'button', onClick: sendMessage, disabled: composeDisabled },
              sending ? 'Sending…' : 'Send'
            )
          )
        )
      )
    ),
    modalAddr
      ? React.createElement(
          'div',
          { className: 'modalBackdrop', onClick: () => setUserModal(null) },
          React.createElement(
            'div',
            {
              className: 'modal',
              onClick: (e) => {
                try {
                  e.stopPropagation();
                } catch {}
              },
            },
            React.createElement(
              'div',
              { className: 'modalHeader' },
              React.createElement('div', { className: 'modalTitle' }, 'User'),
              React.createElement(
                'button',
                { className: 'iconBtn', type: 'button', onClick: () => setUserModal(null) },
                '×'
              )
            ),
            React.createElement(
              'div',
              { className: 'modalBody' },
              React.createElement('div', { style: { fontWeight: 900, marginBottom: 4 } }, modalName || 'anon'),
              React.createElement('div', { className: 'muted', style: { fontSize: 12, wordBreak: 'break-all' } }, modalAddr),
              modalBlock
                ? React.createElement(
                    'div',
                    { className: 'warn', style: { marginTop: 10, fontSize: 12 } },
                    `Blocked in this room (${String(modalBlock.reason || 'manual')})`
                  )
                : React.createElement(
                    'div',
                    { className: 'muted', style: { marginTop: 10, fontSize: 12 } },
                    'Not blocked in this room.'
                  )
            ),
            React.createElement(
              'div',
              { className: 'modalFooter' },
              React.createElement(
                'button',
                { className: 'btn', type: 'button', onClick: () => setUserModal(null) },
                'Close'
              ),
              modalBlock
                ? React.createElement(
                    'button',
                    {
                      className: 'btn primary',
                      type: 'button',
                      onClick: () => {
                        unblockUser(modalAddr);
                        setUserModal(null);
                      },
                    },
                    'Unblock'
                  )
                : React.createElement(
                    'button',
                    {
                      className: 'btn danger',
                      type: 'button',
                      onClick: () => {
                        blockUser(modalAddr, 'manual');
                        setUserModal(null);
                      },
                    },
                    'Block'
                  )
            )
          )
        )
      : null,
    toast.open
      ? React.createElement(
          'div',
          { className: 'toast' },
          React.createElement(
            'div',
            { className: `toastCard ${toast.kind}` },
            toast.title ? React.createElement('div', { className: 'toastTitle' }, toast.title) : null,
            React.createElement('div', { className: 'toastMsg' }, toast.message)
          )
        )
      : null
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(React.createElement(App));
