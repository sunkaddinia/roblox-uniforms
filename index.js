require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Trim every value so a stray space/newline pasted into Render can't break anything
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const BLOXLINK_API_KEY = (process.env.BLOXLINK_API_KEY || '').trim();
const API_KEY = (process.env.API_KEY || '').trim();

// ---- Discord REST client (no gateway login, so the bot won't show as online) ----
const discord = axios.create({
    baseURL: 'https://discord.com/api/v10',
    headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'User-Agent': 'DiscordBot (roblox-discord-api, 1.0.0)',
    },
    timeout: 10000,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// If Discord rate-limits/blocks us, stop sending requests until the block ends
// (hammering a blocked IP makes the block last longer)
let blockedUntil = 0;

async function discordGet(path) {
    if (Date.now() < blockedUntil) {
        const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
        const err = new Error(`Discord is rate-limiting us, not retrying for ${secs}s`);
        err.skipped = true;
        throw err;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return (await discord.get(path)).data;
        } catch (err) {
            if (err.response?.status !== 429) throw err;
            const retryAfter = Number(err.response.headers?.['retry-after'] ?? err.response.data?.retry_after) || 60;
            if (attempt === 0 && retryAfter <= 3) {   // short limit: wait and retry once
                await sleep(retryAfter * 1000);
                continue;
            }
            blockedUntil = Date.now() + Math.min(Math.max(retryAfter, 5), 600) * 1000;
            console.error(`Discord 429 on ${path}, pausing Discord requests for ${Math.round(retryAfter)}s`);
            throw err;
        }
    }
}

// ---- Caches (fewer requests to Discord/Bloxlink = fewer rate limits) ----
const FRESH_MS = 60 * 1000;          // reuse roles for 1 minute
const STALE_MS = 60 * 60 * 1000;     // if Discord is failing, serve roles up to 1 hour old
const ID_CACHE_MS = 5 * 60 * 1000;   // Roblox -> Discord ID lookups cached 5 minutes

let guildRoles = { at: 0, map: new Map() };
const memberCache = new Map();       // discordId -> { at, roles }
const idCache = new Map();           // robloxId  -> { at, discordId }

setInterval(() => {                  // keep the caches from growing forever
    const now = Date.now();
    for (const [k, v] of memberCache) if (now - v.at > STALE_MS) memberCache.delete(k);
    for (const [k, v] of idCache) if (now - v.at > ID_CACHE_MS) idCache.delete(k);
}, 10 * 60 * 1000).unref();

async function getGuildRoles() {
    if (guildRoles.map.size && Date.now() - guildRoles.at < FRESH_MS) return guildRoles.map;
    try {
        const data = await discordGet(`/guilds/${GUILD_ID}/roles`);
        guildRoles = { at: Date.now(), map: new Map(data.map(r => [r.id, r.name])) };
    } catch (err) {
        if (guildRoles.map.size && Date.now() - guildRoles.at < STALE_MS) return guildRoles.map;
        throw err;
    }
    return guildRoles.map;
}

async function getRoleNames(discordId) {
    const cached = memberCache.get(discordId);
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.roles;
    try {
        const [member, roleMap] = await Promise.all([
            discordGet(`/guilds/${GUILD_ID}/members/${discordId}`),
            getGuildRoles(),
        ]);
        const roles = member.roles.map(id => roleMap.get(id)).filter(Boolean); // @everyone isn't included
        memberCache.set(discordId, { at: Date.now(), roles });
        return roles;
    } catch (err) {
        if (err.response?.status === 404) {          // left the server: don't serve old roles
            memberCache.delete(discordId);
            throw err;
        }
        if (cached && Date.now() - cached.at < STALE_MS) {
            console.warn('Discord failed, serving cached roles for', discordId);
            return cached.roles;
        }
        throw err;
    }
}

// ---- Helper: Get Discord ID from Roblox ID via Bloxlink ----
async function getDiscordId(robloxId) {
    const cached = idCache.get(robloxId);
    if (cached && Date.now() - cached.at < ID_CACHE_MS) return cached.discordId;
    try {
        const res = await axios.get(
            `https://api.blox.link/v4/public/guilds/${GUILD_ID}/roblox-to-discord/${encodeURIComponent(robloxId)}`,
            { headers: { Authorization: BLOXLINK_API_KEY }, timeout: 10000 }
        );
        const discordId = res.data.discordIDs?.[0] ?? null;
        if (discordId) idCache.set(robloxId, { at: Date.now(), discordId });
        return discordId;
    } catch (err) {
        console.error('Bloxlink lookup failed | status:', err.response?.status, '|', err.response?.data ?? err.message);
        return null;
    }
}

// ---- Health check (also handy for waking the service up) ----
app.get('/', (req, res) => res.send('OK'));

// ---- Main Route ----
app.get('/roles', async (req, res) => {

    // 1. Check API key
    if (req.headers['apikey'] !== API_KEY) {
        return res.json({ status: "FAILED", message: "Invalid API key" });
    }

    // 2. Check user ID was sent
    const robloxId = req.headers['userid'];
    if (!robloxId) {
        return res.json({ status: "FAILED", message: "No userid provided" });
    }

    // 3. Look up their Discord ID
    const discordId = await getDiscordId(robloxId);
    if (!discordId) {
        return res.json({ status: "FAILED", message: "User not found in Bloxlink" });
    }

    // 4. Fetch their roles from Discord
    try {
        const roleNames = await getRoleNames(discordId);
        return res.json({ status: "SUCCESS", roles: roleNames });
    } catch (err) {
        if (!err.skipped) {
            const body = err.response?.data;
            console.error('Member fetch failed | status:', err.response?.status ?? 'none', '|',
                typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body ?? err.message));
        }
        return res.json({ status: "FAILED", message: "Could not fetch member" });
    }
});

// ---- Start Server ----
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
