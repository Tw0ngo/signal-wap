/**
 * Signal WAP - Signal-CLI Bridge for WAP Browsers
 * Tested on Nokia 7110 (WML 1.1, ~1.4 KB compiled deck limit, no cookies)
 *
 * Talks to one long-running `signal-cli jsonRpc` process over stdin/stdout:
 * no shell, no JVM start per request, messages arrive as they come in.
 */

const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '8082', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.SIGNAL_PASSWORD || '';
const ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
const SIGNAL_CLI = process.env.SIGNAL_CLI || 'signal-cli';
const SIGNAL_CONFIG = process.env.SIGNAL_CONFIG || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || '50', 10);
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const TZ = process.env.TZ || 'Europe/Berlin';

// The 7110 refuses compiled decks over ~1400 bytes. These budgets keep the
// visible text of a deck well below that, leaving room for markup and URLs.
const TEXT_BUDGET = parseInt(process.env.TEXT_BUDGET || '600', 10);
const CHATS_PER_PAGE = 8;
const NAME_LEN = 14;

if (!PASSWORD || PASSWORD === 'changeme') {
    console.error('Set SIGNAL_PASSWORD in .env (not "changeme").');
    process.exit(1);
}

const MSG_STORE_FILE = path.join(DATA_DIR, 'messages_store.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ==================== Persistence ====================

function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// messages_store.json keeps the original format: { chatId: [{senderId, text, timestamp}] }
const store = loadJson(MSG_STORE_FILE, {});
const state = Object.assign(
    { shortIds: {}, nextShortId: 1, lastRead: {}, sessions: {} },
    loadJson(STATE_FILE, {})
);
const longIds = {};
for (const [id, s] of Object.entries(state.shortIds)) longIds[s] = id;

let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            saveJson(MSG_STORE_FILE, store);
            saveJson(STATE_FILE, state);
        } catch (e) {
            console.error('[Store] save failed:', e.message);
        }
    }, 1000);
}

// Signal ids are 36-44 chars; a short number keeps URLs (and decks) small.
function shortId(id) {
    if (!state.shortIds[id]) {
        const s = String(state.nextShortId++);
        state.shortIds[id] = s;
        longIds[s] = id;
        scheduleSave();
    }
    return state.shortIds[id];
}

// ==================== Contacts ====================

const contacts = {};      // id -> display name
const uuidToNumber = {};  // uuid -> phone number
const groupIds = new Set();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One chat per person, whether signal-cli reports their number or their uuid.
function canonical(id) {
    if (!id) return id;
    return uuidToNumber[id] || id;
}

function displayName(id) {
    if (!id) return 'Unknown';
    if (id === 'Me') return 'Me';
    const n = contacts[id] || contacts[canonical(id)];
    if (n) return n;
    return id.length > 12 ? id.substring(0, 8) + '..' : id;
}

// Messages that arrived before the contact list was loaded may sit under a uuid.
function mergeAliases() {
    for (const [uuid, number] of Object.entries(uuidToNumber)) {
        if (store[uuid]) {
            for (const m of store[uuid]) {
                storeMessage(number, m.senderId === uuid ? number : m.senderId, m.text, m.timestamp, m.q);
            }
            delete store[uuid];
            state.lastRead[number] = Math.max(state.lastRead[number] || 0, state.lastRead[uuid] || 0);
            delete state.lastRead[uuid];
        }
        if (state.shortIds[uuid] && !state.shortIds[number]) {
            state.shortIds[number] = state.shortIds[uuid];
        }
        if (state.shortIds[uuid]) {
            longIds[state.shortIds[uuid]] = number;
            delete state.shortIds[uuid];
        }
        for (const list of Object.values(store)) {
            for (const m of list) {
                if (m.senderId === uuid) m.senderId = number;
                if (m.q?.a === uuid) m.q.a = number;
            }
        }
    }
    scheduleSave();
}

async function refreshContacts() {
    try {
        const list = await signal.call('listContacts', {});
        if (Array.isArray(list)) {
            for (const c of list) {
                const uuid = c.uuid || c.aci;
                if (uuid && c.number) uuidToNumber[uuid] = c.number;
                const name = c.name
                    || [c.givenName, c.familyName].filter(Boolean).join(' ')
                    || [c.profile?.givenName, c.profile?.familyName].filter(Boolean).join(' ')
                    || c.profileName
                    || c.username;
                const id = c.number || uuid;
                if (id && name) contacts[id] = ascii(name);
            }
        }
        mergeAliases();
    } catch (e) {
        console.error('[Contacts]', e.message || e);
    }
    try {
        const groups = await signal.call('listGroups', {});
        if (Array.isArray(groups)) {
            for (const g of groups) {
                if (!g.id) continue;
                groupIds.add(g.id);
                contacts[g.id] = '#' + ascii(g.name || 'Group');
            }
        }
    } catch (e) {
        console.error('[Groups]', e.message || e);
    }
}

// ==================== Text helpers ====================

const CHAR_MAP = {
    'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
    '€': 'EUR', '„': '"', '“': '"', '”': '"', '‘': "'", '’': "'", '‚': "'",
    '–': '-', '—': '-', '…': '...', ' ': ' ',
    '😂': ':D', '🤣': ':D', '😀': ':D', '😃': ':D', '😄': ':D', '😁': ':D',
    '🙂': ':)', '😊': ':)', '☺': ':)', '😉': ';)', '😢': ":'(", '😭': ":'(",
    '🙁': ':(', '☹': ':(', '😛': ':P', '😜': ';P', '😮': ':O', '😘': ':*',
    '❤': '<3', '♥': '<3', '👍': '(y)', '👎': '(n)', '🙏': '(pray)',
};
const CHAR_RE = new RegExp(Object.keys(CHAR_MAP).join('|'), 'gu');

// The 7110 only renders plain ASCII reliably.
function ascii(text) {
    if (text == null) return '';
    return String(text)
        .replace(/[︎️‍]/g, '')
        .replace(CHAR_RE, c => CHAR_MAP[c])
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[^\x20-\x7E\n]+/gu, '?')
        .trim();
}

// Escape for WML text and attributes. `$` starts a WML variable, so it is doubled.
function esc(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/\$/g, '$$$$');
}

function escLines(text) {
    return esc(text).replace(/\n/g, '<br/>');
}

function fmtTime(ts) {
    const d = new Date(ts);
    const opts = { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false };
    const day = { timeZone: TZ, day: '2-digit', month: '2-digit' };
    const sameDay = d.toLocaleDateString('de-DE', day) === new Date().toLocaleDateString('de-DE', day);
    return (sameDay ? '' : d.toLocaleDateString('de-DE', day) + ' ') + d.toLocaleTimeString('de-DE', opts);
}

// ==================== Message store ====================

function storeMessage(chatId, senderId, text, timestamp, quote) {
    if (!chatId || !text || !String(text).trim()) return;
    const list = store[chatId] || (store[chatId] = []);
    if (list.some(m => m.timestamp === timestamp && m.text === text)) return;
    const msg = { senderId: senderId || 'Unknown', text, timestamp };
    if (quote) msg.q = quote;
    list.push(msg);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
    shortId(chatId);
    scheduleSave();
}

function quoteOf(dm) {
    if (!dm.quote) return undefined;
    return {
        a: canonical(dm.quote.authorNumber || dm.quote.authorUuid || dm.quote.author),
        t: ascii(dm.quote.text || '').substring(0, 20),
    };
}

function describe(dm) {
    let text = '';
    if (dm.message) text += dm.message;
    if (dm.sticker) text += (text ? '\n' : '') + '[Sticker]';
    for (const a of dm.attachments || []) {
        const type = (a.contentType || '').split('/')[0];
        const label = { image: 'Image', video: 'Video', audio: 'Voice' }[type] || 'File';
        text += (text ? '\n' : '') + `[${label}]`;
    }
    return text;
}

function handleEnvelope(env) {
    if (!env) return;
    const source = canonical(env.sourceNumber || env.sourceUuid || env.source) || 'Unknown';
    const ts = env.timestamp || Date.now();

    const dm = env.dataMessage || env.editMessage?.dataMessage;
    if (dm && !dm.reaction && !dm.remoteDelete) {
        const text = describe(dm);
        const chat = dm.groupInfo?.groupId || source;
        if (text) storeMessage(chat, source, (env.editMessage ? '(edited) ' : '') + text, ts, quoteOf(dm));
    }

    const sent = env.syncMessage?.sentMessage;
    if (sent && !sent.reaction && !sent.remoteDelete) {
        const text = describe(sent);
        const chat = sent.groupInfo?.groupId
            || canonical(sent.destinationNumber || sent.destinationUuid || sent.destination);
        if (text && chat) storeMessage(chat, 'Me', text, sent.timestamp || ts, quoteOf(sent));
    }
}

// ==================== signal-cli JSON-RPC ====================

class SignalRpc extends EventEmitter {
    constructor() {
        super();
        this.nextId = 1;
        this.pending = new Map();
        this.proc = null;
    }

    start() {
        const args = [];
        if (SIGNAL_CONFIG) args.push('--config', SIGNAL_CONFIG);
        if (ACCOUNT) args.push('-a', ACCOUNT);
        args.push('jsonRpc');

        console.log('[signal-cli] starting:', SIGNAL_CLI, args.join(' '));
        const proc = spawn(SIGNAL_CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc = proc;

        readline.createInterface({ input: proc.stdout }).on('line', line => this.onLine(line));
        readline.createInterface({ input: proc.stderr }).on('line', line => console.error('[signal-cli]', line));

        proc.on('error', e => console.error('[signal-cli] spawn failed:', e.message));
        proc.on('exit', code => {
            console.error(`[signal-cli] exited (${code}), restarting in 10s`);
            this.proc = null;
            for (const p of this.pending.values()) p.reject(new Error('signal-cli exited'));
            this.pending.clear();
            setTimeout(() => this.start(), 10000);
        });
        this.emit('start');
    }

    onLine(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'signal-cli error'));
            else p.resolve(msg.result);
        } else if (msg.method === 'receive') {
            const params = msg.params || {};
            this.emit('envelope', params.envelope || params.result?.envelope);
        }
    }

    call(method, params, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            if (!this.proc) return reject(new Error('signal-cli not running'));
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: v => { clearTimeout(timer); resolve(v); },
                reject: e => { clearTimeout(timer); reject(e); },
            });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
        });
    }
}

const signal = new SignalRpc();
signal.on('envelope', env => {
    try { handleEnvelope(env); } catch (e) { console.error('[receive]', e.message); }
});
signal.on('start', () => setTimeout(refreshContacts, 3000));
setInterval(refreshContacts, 10 * 60 * 1000);

// ==================== Sessions ====================
// The 7110 (and many WAP gateways) drop cookies, so the session token
// travels in the URL as ?s=...

const failedLogins = [];

function newSession() {
    const token = crypto.randomBytes(6).toString('base64url');
    state.sessions[token] = Date.now() + SESSION_DAYS * 86400000;
    scheduleSave();
    return token;
}

function validSession(token) {
    const exp = token && state.sessions[token];
    if (!exp) return false;
    if (exp < Date.now()) {
        delete state.sessions[token];
        scheduleSave();
        return false;
    }
    return true;
}

function passwordOk(pwd) {
    const a = crypto.createHash('sha256').update(String(pwd || '')).digest();
    const b = crypto.createHash('sha256').update(PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
}

// ==================== WML ====================

const HEAD = '<?xml version="1.0"?>\n<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml">\n';

function sendDeck(res, title, body, extra = '') {
    res.set({
        'Content-Type': 'text/vnd.wap.wml',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    });
    res.send(
        HEAD +
        '<wml><head><meta http-equiv="Cache-Control" content="max-age=0" forua="true"/></head>' +
        `<card id="c" title="${esc(title)}">${extra}` +
        '<do type="prev" label="Back"><prev/></do>' +
        `<p>${body}</p></card></wml>`
    );
}

// Build a URL with the session token; `&` is escaped for WML.
function link(req, route, params = {}) {
    const q = new URLSearchParams({ ...params, s: req.session });
    return esc(`${route}?${q.toString()}`);
}

function a(href, label) {
    return `<a href="${href}">${label}</a>`;
}

// ==================== App ====================

const app = express();
app.use(express.urlencoded({ extended: false }));

function auth(req, res, next) {
    const token = req.query.s || req.body?.s;
    if (!validSession(token)) {
        return sendDeck(res, 'Login', 'Session expired.<br/>' + a('/', 'Login'));
    }
    req.session = token;
    next();
}

app.get('/', (req, res) => {
    sendDeck(res, 'Signal',
        'Password:<br/><input name="pwd" type="password" format="*M" emptyok="false"/><br/>' +
        '<anchor>Sign in<go href="/login" method="post"><postfield name="pwd" value="$(pwd)"/></go></anchor>');
});

app.post('/login', (req, res) => {
    const now = Date.now();
    while (failedLogins.length && failedLogins[0] < now - 10 * 60000) failedLogins.shift();
    if (failedLogins.length >= 5) {
        return sendDeck(res, 'Login', 'Too many attempts. Try again later.');
    }
    if (!passwordOk(req.body.pwd)) {
        failedLogins.push(now);
        return sendDeck(res, 'Login', 'Wrong password.<br/>' + a('/', 'Retry'));
    }
    req.session = newSession();
    // The onevent clears the typed password from the phone's WML variables.
    sendDeck(res, 'Signal', a(link(req, '/chats'), 'Open chats'),
        '<onevent type="onenterforward"><refresh><setvar name="pwd" value=""/></refresh></onevent>');
});

function chatList() {
    return Object.keys(store)
        .filter(id => store[id].length)
        .map(id => {
            const last = store[id][store[id].length - 1];
            return { id, ts: last.timestamp, unread: last.senderId !== 'Me' && last.timestamp > (state.lastRead[id] || 0) };
        })
        .sort((x, y) => y.ts - x.ts);
}

app.get('/chats', auth, (req, res) => {
    const page = Math.max(0, parseInt(req.query.p || '0', 10) || 0);
    const all = chatList();
    const items = all.slice(page * CHATS_PER_PAGE, (page + 1) * CHATS_PER_PAGE);

    let body = items.map(c =>
        (c.unread ? '*' : '') + a(link(req, '/m', { c: shortId(c.id) }), esc(displayName(c.id).substring(0, NAME_LEN)))
    ).join('<br/>') || 'No chats yet.';

    const nav = [];
    if (page > 0) nav.push(a(link(req, '/chats', { p: page - 1 }), '&lt;Prev'));
    if (all.length > (page + 1) * CHATS_PER_PAGE) nav.push(a(link(req, '/chats', { p: page + 1 }), 'More&gt;'));
    if (nav.length) body += '<br/>' + nav.join(' ');

    body += '<br/>' + a(link(req, '/find'), 'Contacts') + ' ' + a(link(req, '/chats', { t: Date.now() % 1000 }), 'Refresh');
    sendDeck(res, 'Chats', body);
});

app.get('/find', auth, (req, res) => {
    sendDeck(res, 'Search',
        'Name or number:<br/><input name="q" emptyok="true"/><br/>' +
        `<anchor>Search<go href="/search" method="get"><postfield name="s" value="${esc(req.session)}"/>` +
        '<postfield name="q" value="$(q)"/></go></anchor>');
});

app.get('/search', auth, (req, res) => {
    const q = ascii(req.query.q || '').toLowerCase();
    const page = Math.max(0, parseInt(req.query.p || '0', 10) || 0);
    const hits = Object.keys(contacts)
        .filter(id => !q || contacts[id].toLowerCase().includes(q) || id.toLowerCase().includes(q))
        .sort((x, y) => contacts[x].localeCompare(contacts[y], 'de', { sensitivity: 'base' }));
    const items = hits.slice(page * CHATS_PER_PAGE, (page + 1) * CHATS_PER_PAGE);

    let body = `${hits.length} found<br/>` +
        items.map(id => a(link(req, '/m', { c: shortId(id) }), esc(contacts[id].substring(0, NAME_LEN)))).join('<br/>');
    const nav = [];
    if (page > 0) nav.push(a(link(req, '/search', { q, p: page - 1 }), '&lt;Prev'));
    if (hits.length > (page + 1) * CHATS_PER_PAGE) nav.push(a(link(req, '/search', { q, p: page + 1 }), 'More&gt;'));
    if (nav.length) body += '<br/>' + nav.join(' ');
    body += '<br/>' + a(link(req, '/chats'), 'Chats');
    sendDeck(res, 'Contacts', body);
});

function chatFrom(req, res) {
    const id = longIds[req.query.c || req.body?.c];
    if (!id) {
        sendDeck(res, 'Error', 'Unknown chat.<br/>' + a(link(req, '/chats'), 'Chats'));
        return null;
    }
    return id;
}

function fullText(m) {
    return (m.q ? `[Re ${displayName(m.q.a).substring(0, 8)}: ${m.q.t}]\n` : '') + ascii(m.text);
}

// Messages, newest first, as many as fit in the deck budget.
app.get('/m', auth, (req, res) => {
    const id = chatFrom(req, res);
    if (!id) return;
    const c = shortId(id);
    const msgs = store[id] || [];
    const start = Math.max(0, parseInt(req.query.o || '0', 10) || 0);   // how many newest to skip
    const isGroup = groupIds.has(id) || !(id.startsWith('+') || UUID_RE.test(id));

    if (msgs.length) {
        state.lastRead[id] = Math.max(state.lastRead[id] || 0, msgs[msgs.length - 1].timestamp);
        scheduleSave();
    }

    let body = a(link(req, '/w', { c }), '[Write]') + '<br/>';
    let used = 0;
    let shown = 0;
    for (let i = msgs.length - 1 - start; i >= 0; i--) {
        const m = msgs[i];
        const who = m.senderId === 'Me' ? 'Me' : (isGroup ? displayName(m.senderId).substring(0, 8) : '');
        const head = `${who ? who + ' ' : ''}${fmtTime(m.timestamp)}`;
        let text = fullText(m);
        const room = TEXT_BUDGET - used - head.length;
        if (shown > 0 && room < Math.min(text.length, 80)) break;
        let more = '';
        if (text.length > Math.max(room, 80)) {
            text = text.substring(0, Math.max(room, 80));
            more = ' ' + a(link(req, '/r', { c, t: m.timestamp, x: text.length }), '[more]');
        }
        body += `<b>${esc(head)}</b><br/>${escLines(text)}${more}<br/>`;
        used += head.length + text.length;
        shown++;
    }
    if (!msgs.length) body += 'No messages.<br/>';

    const older = start + shown;
    if (older < msgs.length) body += a(link(req, '/m', { c, o: older }), 'Older&gt;') + '<br/>';
    body += a(link(req, '/chats'), 'Chats');
    sendDeck(res, displayName(id).substring(0, NAME_LEN), body);
});

// Read one long message in chunks.
app.get('/r', auth, (req, res) => {
    const id = chatFrom(req, res);
    if (!id) return;
    const c = shortId(id);
    const t = Number(req.query.t);
    const m = (store[id] || []).find(x => x.timestamp === t);
    if (!m) return sendDeck(res, 'Error', 'Message gone.<br/>' + a(link(req, '/m', { c }), 'Back'));
    const text = fullText(m);
    const off = Math.max(0, parseInt(req.query.x || '0', 10) || 0);
    let body = escLines(text.substring(off, off + TEXT_BUDGET)) + '<br/>';
    if (off + TEXT_BUDGET < text.length) body += a(link(req, '/r', { c, t, x: off + TEXT_BUDGET }), '[more]') + '<br/>';
    body += a(link(req, '/m', { c }), 'Chat');
    sendDeck(res, 'Message', body);
});

// Compose. The onenterforward event empties the field each time the card is opened,
// so the previous message is not pre-filled.
app.get('/w', auth, (req, res) => {
    const id = chatFrom(req, res);
    if (!id) return;
    const c = shortId(id);
    sendDeck(res, 'To ' + displayName(id).substring(0, NAME_LEN),
        '<input name="msg" maxlength="500" emptyok="false"/><br/>' +
        `<anchor>Send<go href="/send" method="post"><postfield name="s" value="${esc(req.session)}"/>` +
        `<postfield name="c" value="${c}"/><postfield name="msg" value="$(msg)"/></go></anchor><br/>` +
        a(link(req, '/m', { c }), 'Cancel'),
        '<onevent type="onenterforward"><refresh><setvar name="msg" value=""/></refresh></onevent>');
});

app.post('/send', auth, async (req, res) => {
    const id = chatFrom(req, res);
    if (!id) return;
    const c = shortId(id);
    const text = String(req.body.msg || '').trim();
    if (!text) return sendDeck(res, 'Error', 'Empty message.<br/>' + a(link(req, '/w', { c }), 'Back'));

    const isGroup = groupIds.has(id) || !(id.startsWith('+') || UUID_RE.test(id));
    const params = isGroup ? { groupId: id, message: text } : { recipient: [id], message: text };
    try {
        const result = await signal.call('send', params);
        storeMessage(id, 'Me', text, result?.timestamp || Date.now());
        sendDeck(res, 'Sent', 'Sent.<br/>' + a(link(req, '/m', { c }), 'Chat'));
    } catch (e) {
        console.error('[send]', e.message);
        sendDeck(res, 'Error', 'Send failed.<br/>' + a(link(req, '/w', { c }), 'Retry') + ' ' + a(link(req, '/m', { c }), 'Chat'));
    }
});

// ==================== Server ====================

signal.start();
app.listen(PORT, HOST, () => {
    console.log(`Signal WAP running on http://${HOST}:${PORT}`);
});

function shutdown() {
    try { saveJson(MSG_STORE_FILE, store); saveJson(STATE_FILE, state); } catch {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
