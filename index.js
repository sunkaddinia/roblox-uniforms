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

console.log(
    'Env check -> BOT_TOKEN:', BOT_TOKEN.length,
    '| GUILD_ID:', GUILD_ID.length,
    '| BLOXLINK_API_KEY:', BLOXLINK_API_KEY.length,
    '| API_KEY:', API_KEY.length
);

// ---- Discord REST client (no gateway login needed to read roles) ----
const discord = axios.create({
    baseURL: 'https://discord.com/api/v10',
    headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'User-Agent': 'DiscordBot (roblox-discord-api, 1.0.0)',
    },
    timeout: 10000,
});

function logDiscordError(label, err) {
    const status = err.response?.status;
    let body = err.response?.data ?? err.message;
    if (typeof body === 'string') body = body.slice(0, 200); // Cloudflare blocks return HTML
    else if (typeof body === 'object') body = JSON.stringify(body).slice(0, 300);
    console.error(`${label} | status: ${status ?? 'none'} | ${body}`);
}

// ---- Startup self-check: tells you in the logs if Render can reach Discord ----
(async () => {
    try {
        const { data } = await discord.get('/users/@me');
        console.log(`Discord token OK: logged in as ${data.username}`);
        const guild = await discord.get(`/guilds/${GUILD_ID}`);
        console.log(`Bot can see the server: ${guild.data.name}`);
    } catch (err) {
        logDiscordError('Startup check failed', err);
    }
})();

// ---- Role name cache (role ID -> name), refreshed every 60s ----
let roleCache = { at: 0, map: new Map() };
async function getGuildRoles() {
    if (roleCache.map.size && Date.now() - roleCache.at < 60000) return roleCache.map;
    const { data } = await discord.get(`/guilds/${GUILD_ID}/roles`);
    roleCache = { at: Date.now(), map: new Map(data.map(r => [r.id, r.name])) };
    return roleCache.map;
}

// ---- Helper: Get Discord ID from Roblox ID via Bloxlink ----
async function getDiscordId(robloxId) {
    try {
        const res = await axios.get(
            `https://api.blox.link/v4/public/guilds/${GUILD_ID}/roblox-to-discord/${encodeURIComponent(robloxId)}`,
            { headers: { Authorization: BLOXLINK_API_KEY }, timeout: 10000 }
        );
        return res.data.discordIDs?.[0] ?? null;
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
        const [memberRes, roleMap] = await Promise.all([
            discord.get(`/guilds/${GUILD_ID}/members/${discordId}`),
            getGuildRoles(),
        ]);
        const roleNames = memberRes.data.roles
            .map(id => roleMap.get(id))
            .filter(Boolean); // @everyone is never in a member's role list

        return res.json({ status: "SUCCESS", roles: roleNames });

    } catch (err) {
        logDiscordError('Member fetch failed', err);
        return res.json({ status: "FAILED", message: "Could not fetch member" });
    }
});

// ---- Start Server ----
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
