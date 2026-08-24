/**
 * Signal WAP - Signal-CLI Bridge for WAP Browsers
 * Tested on Nokia 7110
 */

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 8082;
const PASSWORD = process.env.SIGNAL_PASSWORD || 'changeme';
const CACHE_FILE = path.join(__dirname, 'chats_cache.json');
const MSG_STORE_FILE = path.join(__dirname, 'messages_store.json');
const CONTACTS_CACHE_FILE = path.join(__dirname, 'contacts_map.json');

// ==================== Signal CLI Wrapper ====================

function runSignalCli(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
            if (error) {
                reject(stderr || error.message);
            } else {
                resolve(stdout);
            }
        });
    });
}

// ==================== Helpers ====================

function sanitizeText(text) {
    if (!text) return '';
    return String(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7E]/g, '?')
        .trim();
}

function getResolvedName(id) {
    if (!id || id === 'Me') return id || 'Unknown';
    try {
        if (fs.existsSync(CONTACTS_CACHE_FILE)) {
            const map = JSON.parse(fs.readFileSync(CONTACTS_CACHE_FILE, 'utf8'));
            if (map[id]) return map[id];
        }
    } catch {}
    return id.length > 10 ? id.substring(0, 8) + '...' : id;
}

function storeMessage(targetId, senderId, text, timestamp) {
    if (!text || typeof text !== 'string' || text.trim() === '' || !targetId) return;

    let store = {};
    try {
        if (fs.existsSync(MSG_STORE_FILE)) {
            store = JSON.parse(fs.readFileSync(MSG_STORE_FILE, 'utf8'));
        }
    } catch {}

    if (!store[targetId]) store[targetId] = [];

    const exists = store[targetId].some(m => m.timestamp === timestamp && m.text === text);
    if (!exists) {
        store[targetId].push({ senderId: senderId || 'Unknown', text, timestamp });
        store[targetId].sort((a, b) => a.timestamp - b.timestamp);
        if (store[targetId].length > 50) {
            store[targetId] = store[targetId].slice(-50);
        }
        fs.writeFileSync(MSG_STORE_FILE, JSON.stringify(store, null, 2));
    }
}

// ==================== Auth Middleware ====================

function checkAuth(req, res, next) {
    const providedPwd = req.query?.pwd || req.body?.pwd || req.cookies?.signal_pwd;

    if (!providedPwd || providedPwd !== PASSWORD) {
        res.setHeader('Content-Type', 'text/vnd.wap.wml');
        return res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="err" title="Login"><p>Session expired or incorrect password.<br/><br/><anchor>Login<go href="/" method="get"/></anchor></p></card></wml>`);
    }

    if (req.cookies?.signal_pwd !== PASSWORD) {
        res.cookie('signal_pwd', PASSWORD, { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true });
    }

    next();
}

// ==================== Background Cache Updater ====================

let isUpdatingCache = false;

async function updateChatsCache() {
    if (isUpdatingCache) return;
    isUpdatingCache = true;

    try {
        let contactMap = {};

        // Load contacts
        const contactsOutput = await runSignalCli('signal-cli --output=json listContacts').catch(() => '[]');
        try {
            const contacts = JSON.parse(contactsOutput);
            if (Array.isArray(contacts)) {
                contacts.forEach(c => {
                    const identifier = c.number || c.aci;
                    if (identifier) {
                        contactMap[identifier] = sanitizeText(c.name || c.profileName || identifier);
                    }
                });
            }
        } catch {}

        // Load groups
        const groupsOutput = await runSignalCli('signal-cli --output=json listGroups').catch(() => '[]');
        try {
            const groups = JSON.parse(groupsOutput);
            if (Array.isArray(groups)) {
                groups.forEach(g => {
                    if (g.id) {
                        contactMap[g.id] = '[Group] ' + sanitizeText(g.name || 'Unnamed');
                    }
                    if (Array.isArray(g.members)) {
                        g.members.forEach(m => {
                            const mId = m.number || m.aci;
                            if (mId && m.name && !contactMap[mId]) {
                                contactMap[mId] = sanitizeText(m.name);
                            }
                        });
                    }
                });
            }
        } catch {}

        fs.writeFileSync(CONTACTS_CACHE_FILE, JSON.stringify(contactMap, null, 2));

        // Receive messages
        const receiveOutput = await runSignalCli('signal-cli --output=json receive').catch(() => '');
        if (receiveOutput) {
            receiveOutput.split('\n').filter(l => l.trim()).forEach(line => {
                try {
                    const data = JSON.parse(line);
                    const envelope = data.envelope || data;
                    const source = envelope.sourceNumber || envelope.source || 'Unknown';
                    const timestamp = envelope.timestamp || Date.now();
                    let msgText = '';
                    let groupId = null;

                    if (envelope.dataMessage) {
                        if (envelope.dataMessage.reaction) return;
                        if (envelope.dataMessage.quote) {
                            const quotedAuthor = getResolvedName(envelope.dataMessage.quote.authorNumber || envelope.dataMessage.quote.author);
                            const quotedText = sanitizeText(envelope.dataMessage.quote.text || '').substring(0, 20);
                            msgText = `[Replying to ${quotedAuthor}: "${quotedText}"]\n`;
                        }
                        msgText += envelope.dataMessage.message || '';
                        if (envelope.dataMessage.groupInfo?.groupId) {
                            groupId = envelope.dataMessage.groupInfo.groupId;
                        }
                    }

                    if (msgText && msgText.trim()) {
                        storeMessage(groupId || source, source, msgText, timestamp);
                    }

                    // Handle sent sync
                    if (envelope.syncMessage?.sentMessage) {
                        const sent = envelope.syncMessage.sentMessage;
                        const dest = sent.destination || sent.destinationNumber;
                        const syncGroupId = sent.groupInfo?.groupId;
                        let sentText = sent.message || '';

                        if (sent.quote) {
                            const quotedAuthor = getResolvedName(sent.quote.authorNumber || sent.quote.author);
                            const quotedText = sanitizeText(sent.quote.text || '').substring(0, 20);
                            sentText = `[Replying to ${quotedAuthor}: "${quotedText}"]\n` + sentText;
                        }

                        if (sentText.trim()) {
                            storeMessage(syncGroupId || dest, 'Me', sentText, sent.timestamp || timestamp);
                        }
                    }
                } catch {}
            });
        }

        // Build chat list
        let store = {};
        try {
            if (fs.existsSync(MSG_STORE_FILE)) {
                store = JSON.parse(fs.readFileSync(MSG_STORE_FILE, 'utf8'));
            }
        } catch {}

        const chatList = [];
        const allIds = new Set([...Object.keys(contactMap), ...Object.keys(store)]);

        allIds.forEach(id => {
            const lastTimestamp = store[id]?.[store[id].length - 1]?.timestamp || 1;
            chatList.push({
                identifier: id,
                displayName: sanitizeText(contactMap[id] || id).substring(0, 15),
                timestamp: lastTimestamp
            });
        });

        chatList.sort((a, b) => b.timestamp - a.timestamp);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(chatList, null, 2));

    } catch (err) {
        console.error('[Cache] Background error:', err.message);
    } finally {
        isUpdatingCache = false;
    }
}

// Start background sync
updateChatsCache();
setInterval(updateChatsCache, 20000);

// ==================== Routes ====================

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="login" title="Signal Login"><p><strong>Password:</strong><br/><input name="pwd" type="password" format="*M"/><br/><anchor>Sign In<go href="/chats" method="post"><postfield name="pwd" value="$pwd"/></go></anchor></p></card></wml>`);
});

app.all('/chats', checkAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    let chats = [];
    try {
        if (fs.existsSync(CACHE_FILE)) {
            chats = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
    } catch {}

    const list = chats.slice(0, 10).map(c => `<a href="/messages?id=${encodeURIComponent(c.identifier)}">${c.displayName}</a><br/>`).join('');
    res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="chats" title="Signal Chats"><p><strong>Search:</strong><br/><input name="q"/><br/><anchor>Search<go href="/search" method="get"><postfield name="q" value="$q"/></go></anchor><br/><br/><strong>Recent Chats:</strong><br/>${list || '<em>No chats found.</em>'}<br/><br/><anchor>&#xab; Logout<go href="/" method="get"/></anchor></p></card></wml>`);
});

app.get('/search', checkAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    const query = (req.query.q || '').toLowerCase().trim();
    const page = parseInt(req.query.page || '0', 10);
    const pageSize = 10;

    let contactMap = {};
    try {
        if (fs.existsSync(CONTACTS_CACHE_FILE)) {
            contactMap = JSON.parse(fs.readFileSync(CONTACTS_CACHE_FILE, 'utf8'));
        }
    } catch {}

    let allEntries = Object.keys(contactMap).map(id => ({ identifier: id, displayName: contactMap[id] })).filter(c => !query || c.displayName.toLowerCase().includes(query) || c.identifier.toLowerCase().includes(query)).sort((a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }));

    const startIndex = page * pageSize;
    const endIndex = startIndex + pageSize;
    const pageEntries = allEntries.slice(startIndex, endIndex);

    let wml = `<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="searchres" title="Contacts"><p><strong>Results (${allEntries.length}):</strong><br/>`;
    pageEntries.forEach(c => {
        wml += `<a href="/messages?id=${encodeURIComponent(c.identifier)}">${c.displayName.substring(0, 15)}</a><br/>`;
    });
    wml += `<br/>${page > 0 ? `<anchor>&lt;&lt; Back<go href="/search" method="get"><postfield name="q" value="${query}"/><postfield name="page" value="${page - 1}"/></go></anchor> ` : ''}${endIndex < allEntries.length ? `<anchor>Next &gt;&gt;<go href="/search" method="get"><postfield name="q" value="${query}"/><postfield name="page" value="${page + 1}"/></go></anchor>` : ''}<br/><br/><anchor>&#xab; Main Menu<go href="/chats" method="get"/></anchor></p></card></wml>`;
    res.send(wml);
});

app.get('/messages', checkAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    const contactId = req.query.id;

    let store = {};
    try {
        if (fs.existsSync(MSG_STORE_FILE)) {
            store = JSON.parse(fs.readFileSync(MSG_STORE_FILE, 'utf8'));
        }
    } catch {}

    const messages = store[contactId] || [];
    const msgs = messages.slice(-5).reverse().map(m => {
        const sender = m.senderId === 'Me' ? 'Me' : sanitizeText(getResolvedName(m.senderId)).substring(0, 8);
        const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<u>${sender} ${time}</u><br/>${sanitizeText(m.text).substring(0, 40)}<br/><br/>`;
    }).join('');

    res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="msgs" title="Chat"><p><a href="/compose?id=${encodeURIComponent(contactId)}">[ Write ]</a><br/><br/>${msgs || '<em>No messages in history.</em>'}<br/><br/><anchor>&#xab; Back<go href="/chats" method="get"/></anchor></p></card></wml>`);
});

app.get('/compose', checkAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    const contactId = req.query.id;
    res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="compose" title="Reply"><p><strong>Message:</strong><br/><input name="msg"/><br/><anchor>Send<go href="/send" method="post"><postfield name="id" value="${contactId}"/><postfield name="msg" value="$msg"/></go></anchor><br/><anchor>&#xab; Cancel<go href="/messages?id=${encodeURIComponent(contactId)}" method="get"/></anchor></p></card></wml>`);
});

app.post('/send', checkAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/vnd.wap.wml');
    const targetId = req.body.id;
    const messageText = req.body.msg;

    try {
        const safeText = messageText.replace(/"/g, '\\"');
        let sendCmd = targetId.startsWith('+') || targetId.length === 36
            ? `signal-cli send -m "${safeText}" "${targetId}"`
            : `signal-cli send -m "${safeText}" -g "${targetId}"`;

        await runSignalCli(sendCmd);
        storeMessage(targetId, 'Me', messageText, Date.now());

        res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="sent" title="Sent"><p>Message sent!<br/><br/><anchor>&#xab; Back<go href="/messages?id=${encodeURIComponent(targetId)}" method="get"/></anchor></p></card></wml>`);
    } catch {
        res.send(`<?xml version="1.0"?><!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml"><wml><card id="err" title="Error"><p>Failed to send!<br/><br/><anchor>Back<go href="/messages?id=${encodeURIComponent(targetId)}" method="get"/></anchor></p></card></wml>`);
    }
});

// ==================== Server ====================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Signal WML running on http://127.0.0.1:${PORT}`);
});
