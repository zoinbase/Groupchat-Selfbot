const { Client, Intents } = require('discord.js-selfbot-v13');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const {
    token,
    groupId,
    ownerIds = [],
    votekickTime = 30000,
    votesRequired = 3,
    commandCooldownTime = 3000,
} = config;
// Extra users allowed to use ,s (kept from the old hardcoded ID, can also be set in config.json)
const snipeIds = new Set([...ownerIds, '247324823116578817', ...(config.snipeIds || [])]);

const SNIPE_LIMIT = 7;
const VOTEKICK_LOCKOUT = 60000;
const QUEUE_DELAY = 800;      // ms between API calls
const QUEUE_MAX = 30;         // drop work instead of building a huge backlog
const TASK_TIMEOUT = 15000;   // a hung request can't stall the queue forever

// Reaction feedback
const OK = '✅', FAIL = '❌', WAIT = '⏳', BANNED = '🔨';

// ─── Never die on a stray error ───────────────────────────────────────────────
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

const client = new Client({
    ws: { properties: { os: 'iOS', browser: 'Discord iOS', device: 'Discord iOS' } },
    presence: { status: 'online' },
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES],
});

client.on('error', (e) => console.error('[client error]', e?.message || e));
client.on('warn', (m) => console.warn('[client warn]', m));
client.on('rateLimit', (i) => console.warn(`[rateLimit] ${i.method} ${i.path} – retry in ${i.timeout}ms`));

// ─── Persistence (atomic writes so a crash can't corrupt the files) ───────────
function loadJson(file, fallback) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
    catch { return fallback; }
}
function saveJson(file, data) {
    try {
        fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
        fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error(`Failed saving ${file}:`, e.message); }
}

const bannedUsers = loadJson('banned.json', {});
const saveBans = () => saveJson('banned.json', bannedUsers);

// Snipes are saved to disk, so they survive a crash/restart
const snipes = Array.isArray(loadJson('snipes.json', [])) ? loadJson('snipes.json', []) : [];
const saveSnipes = () => saveJson('snipes.json', snipes);

// Edit snipes: who edited, from what, to what
const loadedEdits = loadJson('esnipes.json', []);
const editSnipes = Array.isArray(loadedEdits) ? loadedEdits : [];
const saveEditSnipes = () => saveJson('esnipes.json', editSnipes);

// ─── State ────────────────────────────────────────────────────────────────────
const commandCooldown = new Set();
let lastVoteKickTime = 0;
const reAddTracker = {}; // { bannedUserId: { adderId: count } }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanId = (s) => (s || '').replace(/[<@!>]/g, '').trim();

// ─── Rate-limit-safe queue: EVERYTHING that hits the API goes through here ────
class RateLimitQueue {
    constructor(delayMs) {
        this.queue = [];
        this.running = false;
        this.delay = delayMs;
    }
    push(fn, urgent = false) {
        return new Promise((resolve, reject) => {
            if (!urgent && this.queue.length >= QUEUE_MAX) return reject(new Error('Queue full, dropped'));
            // urgent work (kicking banned users) jumps ahead of reactions/DMs
            if (urgent) this.queue.unshift({ fn, resolve, reject });
            else this.queue.push({ fn, resolve, reject });
            if (!this.running) this._run();
        });
    }
    async _run() {
        this.running = true;
        while (this.queue.length) {
            const { fn, resolve, reject } = this.queue.shift();
            try {
                resolve(await Promise.race([
                    fn(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('API call timed out')), TASK_TIMEOUT)),
                ]));
            } catch (e) { reject(e); }
            await sleep(this.delay + Math.random() * 300); // jitter looks less robotic
        }
        this.running = false;
    }
}
const apiQueue = new RateLimitQueue(QUEUE_DELAY);

const queuedSend = (target, content) => apiQueue.push(() => target.send(content));
const queuedRemoveUser = (channel, user, urgent = false) => apiQueue.push(() => channel.removeUser(user), urgent);
// Reactions are feedback only, so they never throw
const react = (message, emoji) => apiQueue.push(() => message.react(emoji)).catch(() => {});

function addCooldown(userId) {
    commandCooldown.add(userId);
    setTimeout(() => commandCooldown.delete(userId), commandCooldownTime);
}

// ─── Snipe formatting ─────────────────────────────────────────────────────────
function formatSnipe(s) {
    let out = `**${s.author}** at <t:${Math.floor(s.ts / 1000)}:f>:\n`;
    if (s.content) out += '```' + s.content.replace(/```/g, "'''").slice(0, 1500) + '```\n';
    if (s.attachments?.length) out += s.attachments.join('\n') + '\n';
    return out.trimEnd();
}

function formatEditSnipe(s) {
    const fence = (t) => '```' + (t || '(empty)').replace(/```/g, "'''").slice(0, 700) + '```';
    return `**${s.author}** edited at <t:${Math.floor(s.ts / 1000)}:f>:
**Before:**${fence(s.before)}**After:**${fence(s.after)}`;
}

// Splits into chunks that fit under Discord's 2000 char limit
function chunkMessages(entries, limit = 1900, format = formatSnipe) {
    const chunks = [];
    let cur = '';
    for (const e of entries) {
        const part = format(e);
        if (cur && cur.length + part.length + 2 > limit) { chunks.push(cur); cur = ''; }
        cur += (cur ? '\n\n' : '') + part;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const isOwner = (m) => ownerIds.includes(m.author.id);

const commands = {
    async kick(message, args) {
        if (!isOwner(message)) return;
        const uid = cleanId(args[0]);
        if (!uid) return react(message, FAIL);
        const user = await client.users.fetch(uid);
        if (ownerIds.includes(user.id)) return react(message, FAIL);
        await queuedRemoveUser(message.channel, user);
        await react(message, OK);
    },

    async ban(message, args) {
        if (!isOwner(message)) return;
        const target = message.mentions.users.first() ||
            (args[0] ? await client.users.fetch(cleanId(args[0])).catch(() => null) : null);
        if (!target || ownerIds.includes(target.id)) return react(message, FAIL);
        bannedUsers[target.id] = 'banned';
        saveBans();
        await queuedRemoveUser(message.channel, target, true).catch((e) => console.error('Ban removal failed:', e.message));
        await react(message, BANNED);
    },

    async unban(message, args) {
        if (!isOwner(message)) return;
        const uid = cleanId(args[0]);
        if (!uid || !bannedUsers[uid]) return react(message, FAIL);
        delete bannedUsers[uid];
        delete reAddTracker[uid];
        saveBans();
        await react(message, OK);
    },

    // List output needs real text, so this one still sends a message
    async banlist(message) {
        if (!isOwner(message)) return;
        const keys = Object.keys(bannedUsers);
        if (!keys.length) return react(message, OK);
        const lines = keys.map((id) => `<@${id}>`);
        for (let i = 0; i < lines.length; i += 20) {
            await queuedSend(message.channel, lines.slice(i, i + 20).join('\n'));
        }
    },

    async votekick(message, args) {
        const userId = message.mentions.users.first()?.id || cleanId(args[0]);
        if (!userId) return react(message, FAIL);
        if (Date.now() - lastVoteKickTime < VOTEKICK_LOCKOUT) return react(message, WAIT);
        lastVoteKickTime = Date.now(); // only burn the lockout once the vote is valid
        await handleVoteKick(message, userId);
    },

    async s(message) {
        if (!snipeIds.has(message.author.id)) return;
        if (!snipes.length) return react(message, FAIL);
        const chunks = chunkMessages([...snipes].reverse()); // newest first
        try {
            for (const c of chunks) await queuedSend(message.author, c);
            await react(message, OK);
        } catch (e) {
            console.error('Snipe DM failed:', e.message);
            await react(message, FAIL);
        }
    },

    async esnipe(message) {
        if (!snipeIds.has(message.author.id)) return;
        if (!editSnipes.length) return react(message, FAIL);
        const chunks = chunkMessages([...editSnipes].reverse(), 1900, formatEditSnipe);
        try {
            for (const c of chunks) await queuedSend(message.author, c);
            await react(message, OK);
        } catch (e) {
            console.error('Edit snipe DM failed:', e.message);
            await react(message, FAIL);
        }
    },
};

// ─── Message handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
    try {
        if (message.channel?.id !== groupId || !message.author || message.author.bot) return;

        // ── Banned-user auto-kick on re-add ──────────────────────────────────
        if (message.type === 'RECIPIENT_ADD') {
            const added = message.mentions.users.first();
            if (!added || !bannedUsers[added.id]) return;
            const adderId = message.author.id;
            if (ownerIds.includes(adderId)) return;

            reAddTracker[added.id] ??= {};
            const count = (reAddTracker[added.id][adderId] = (reAddTracker[added.id][adderId] || 0) + 1);

            if (count >= 3) {
                await queuedRemoveUser(message.channel, added, true).catch((e) => console.error('Auto-kick banned failed:', e.message));
                await queuedRemoveUser(message.channel, message.author, true).catch((e) => console.error('Auto-kick adder failed:', e.message));
                return;
            }
            // kick FIRST, warn after, so the warning never delays the removal
            await queuedRemoveUser(message.channel, added, true).catch((e) => console.error('Banned-user removal failed:', e.message));
            if (count === 2) {
                await queuedSend(message.channel, `<@${adderId}> stop adding banned users.`).catch(() => {});
            }
            return;
        }

        if (!message.content || !message.content.startsWith(',')) return;
        if (commandCooldown.has(message.author.id)) return;

        const args = message.content.trim().split(/\s+/);
        const name = args.shift().slice(1).toLowerCase();
        const handler = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : null;
        if (!handler) return;

        addCooldown(message.author.id);
        try {
            await handler(message, args);
        } catch (e) {
            console.error(`Command ,${name} failed:`, e.message);
            await react(message, FAIL);
        }
    } catch (e) {
        console.error('messageCreate error:', e?.stack || e);
    }
});

// ─── Vote kick ────────────────────────────────────────────────────────────────
async function handleVoteKick(message, userId) {
    await react(message, OK);

    const votes = (r) => Math.max(0, (r?.count ?? 1) - (r?.me ? 1 : 0)); // don't count our own ✅
    const filter = (reaction, user) => reaction.emoji.name === OK && !user.bot;
    const collector = message.createReactionCollector({ filter, time: votekickTime });
    let kicked = false;

    collector.on('collect', async (reaction) => {
        if (kicked || votes(reaction) < votesRequired) return;
        kicked = true;
        collector.stop('success');
        try {
            const target = await client.users.fetch(userId);
            if (ownerIds.includes(target.id)) return react(message, FAIL);
            await queuedRemoveUser(message.channel, target);
            await react(message, BANNED);
        } catch (e) {
            console.error('Votekick action error:', e.message);
            await react(message, FAIL);
        }
    });

    collector.on('end', async (_c, reason) => {
        if (reason !== 'success' && !kicked) await react(message, FAIL);
    });
}

// ─── Message delete logger (the snipe source) ─────────────────────────────────
client.on('messageDelete', (message) => {
    try {
        if (message.channel?.id !== groupId) return;
        if (message.author?.bot) return;
        const content = message.content || '';
        const attachments = message.attachments ? [...message.attachments.values()].map((a) => a.url) : [];
        if (!content && !attachments.length) return;
        if (content.startsWith(',')) return;

        snipes.push({
            author: message.author?.username || 'Unknown',
            content,
            attachments,
            ts: message.createdTimestamp || Date.now(),
        });
        while (snipes.length > SNIPE_LIMIT) snipes.shift();
        saveSnipes();
    } catch (e) {
        console.error('messageDelete error:', e?.stack || e);
    }
});

// ─── Message edit logger (the esnipe source) ──────────────────────────────────
client.on('messageUpdate', (oldMsg, newMsg) => {
    try {
        if (newMsg.channel?.id !== groupId) return;
        const author = newMsg.author || oldMsg.author;
        if (author?.bot) return;
        const before = oldMsg.content, after = newMsg.content;
        if (before == null || after == null || before === after) return; // uncached or embed-only update
        editSnipes.push({
            author: author?.username || 'Unknown',
            before,
            after,
            ts: newMsg.editedTimestamp || Date.now(),
        });
        while (editSnipes.length > SNIPE_LIMIT) editSnipes.shift();
        saveEditSnipes();
    } catch (e) {
        console.error('messageUpdate error:', e?.stack || e);
    }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', () => console.log(`${client.user.username} is online on Discord iOS!`));

client.login(token).catch((e) => { console.error('Login failed:', e.message); process.exit(1); });
