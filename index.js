require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Discord Bot Setup ----
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
});

client.once('clientReady', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);

// ---- Helper: Get Discord ID from Roblox ID via Bloxlink ----
async function getDiscordId(robloxId) {
    try {
        const res = await axios.get(
            `https://api.blox.link/v4/public/guilds/${process.env.GUILD_ID}/roblox-to-discord/${robloxId}`,
            { headers: { 'Authorization': process.env.BLOXLINK_API_KEY } }
        );
        return res.data.discordIDs?.[0] ?? null;
    } catch {
        return null;
    }
}

// ---- Main Route ----
app.get('/roles', async (req, res) => {

    // 1. Check API key
    if (req.headers['apikey'] !== process.env.API_KEY) {
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
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const member = await guild.members.fetch(discordId);
        const roleNames = member.roles.cache
            .map(r => r.name)
            .filter(name => name !== '@everyone'); // exclude default role

        return res.json({ status: "SUCCESS", roles: roleNames });

    } catch (err) {
        console.error(err);
        return res.json({ status: "FAILED", message: "Could not fetch member" });
    }
});

// ---- Start Server ----
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 
