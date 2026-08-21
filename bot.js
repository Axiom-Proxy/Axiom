const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const path = require("path");
const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    Events
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL = process.env.DISCORD_TARGET_CHANNEL;
const LINKS_FILE = path.join(__dirname, "freedns_links.json");
const MAX_DAILY = 3;

const ADMIN_PERMS = [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.Administrator
];

function isAdmin(member) {
    if (!member) return false;
    return ADMIN_PERMS.some(p => member.permissions.has(p));
}

const ADD_LINK_CMD = new SlashCommandBuilder()
    .setName("add-link")
    .setDescription("Add a link alongside the blockers that work with it")
    .addStringOption(o =>
        o.setName("url")
            .setDescription("The http(s):// URL to add")
            .setRequired(true))
    .addStringOption(o =>
        o.setName("blockers")
            .setDescription("Comma-separated list of blockers this link bypasses")
            .setRequired(true)
            .setAutocomplete(true));

const REMOVE_LINK_CMD = new SlashCommandBuilder()
    .setName("remove-link")
    .setDescription("Remove a link")
    .addStringOption(o =>
        o.setName("url")
            .setDescription("The exact URL to remove")
            .setRequired(true)
            .setAutocomplete(true));

const LIST_LINKS_CMD = new SlashCommandBuilder()
    .setName("list-links")
    .setDescription("List every stored link alongside the blockers it bypasses");

if (!TOKEN) {
    console.error("Missing DISCORD_TOKEN in .env");
    process.exit(1);
}
if (!TARGET_CHANNEL) {
    console.error("Missing DISCORD_TARGET_CHANNEL in .env");
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let entries = [];
let blockers = [];

function importLinks() {
    entries = [];
    try {
        const data = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
        if (Array.isArray(data)) entries = data;
    } catch (err) {
        if (err.code !== "ENOENT") console.error("Failed to read links file:", err.message);
    }
    blockers = [...new Set(entries.flatMap(e => e.unblockedBy || []))].sort();
    console.log(`Imported ${entries.length} link(s) covering ${blockers.length} blocker(s).`);
}

function writeLinksFile() {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

function addLink(url, blockerList) {
    url = url.trim();
    blockerList = blockerList.map(b => b.trim()).filter(Boolean);
    const existing = entries.find(e => e.url === url);
    if (existing) {
        existing.unblockedBy = [...new Set([...(existing.unblockedBy || []), ...blockerList])];
    } else {
        entries.push({
            url,
            unblockedBy: [...new Set(blockerList)],
            blockedBy: [],
            filters: {},
            verdict: "unknown"
        });
    }
    writeLinksFile();
    importLinks();
}

function removeLink(url) {
    url = url.trim();
    const before = entries.length;
    entries = entries.filter(e => e.url !== url);
    writeLinksFile();
    importLinks();
    return before - entries.length;
}

const today = () => new Date().toISOString().slice(0, 10);
const daily = new Map();

function remainingFor(userId) {
    const t = daily.get(userId);
    if (!t || t.date !== today()) return MAX_DAILY;
    return Math.max(0, MAX_DAILY - t.count);
}

function recordDispense(userId, link) {
    const t = daily.get(userId);
    if (!t || t.date !== today()) {
        daily.set(userId, { date: today(), count: 1, links: [link] });
    } else {
        t.count += 1;
        t.links.push(link);
    }
}

function usedLinks(userId) {
    const t = daily.get(userId);
    if (!t || t.date !== today()) return [];
    return t.links;
}

function buildDispenserMessage() {
    const embed = new EmbedBuilder()
        .setTitle("Link Dispenser")
        .setDescription(
            "Press the button matching the blocker you use and you'll get DM'd the" +
            "links that still work on it.\n\n" +
            `**${MAX_DAILY} links per day** per user.`
        )
        .setColor(0x5865f2);

    const rows = [];
    for (let i = 0; i < blockers.length; i += 5) {
        const row = new ActionRowBuilder();
        for (const blocker of blockers.slice(i, i + 5)) {
            const count = entries.filter(e => (e.unblockedBy || []).includes(blocker)).length;
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`dispense:${blocker}`)
                    .setLabel(`${blocker} (${count})`)
                    .setStyle(ButtonStyle.Primary)
            );
        }
        rows.push(row);
    }
    return { embeds: [embed], components: rows };
}

async function publishDispenser(channel) {
    const old = await channel.messages.fetch({ limit: 50 }).catch(() => []);
    for (const msg of old.values()) {
        if (msg.author.id === client.user.id && msg.components.length > 0) {
            await msg.delete().catch(() => {});
        }
    }
    await channel.send(buildDispenserMessage());
}

client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
    importLinks();
    const channel = await client.channels.fetch(TARGET_CHANNEL).catch(() => null);
    if (!channel) {
        console.error(`Could not find channel ${TARGET_CHANNEL}`);
        return;
    }
    await publishDispenser(channel);
    console.log(`Posted dispenser in #${channel.name}`);

    try {
        const cmds = [ADD_LINK_CMD, REMOVE_LINK_CMD, LIST_LINKS_CMD];
        if (process.env.DISCORD_GUILD_ID) {
            await client.application.commands.set(cmds, process.env.DISCORD_GUILD_ID);
            console.log(`Registered ${cmds.length} slash command(s) to guild ${process.env.DISCORD_GUILD_ID}`);
        } else {
            await client.application.commands.set(cmds);
            console.log(`Registered ${cmds.length} slash command(s) globally`);
        }
    } catch (err) {
        console.error("Slash command registration failed:", err);
    }
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: "Commands must be used in a server.", flags: MessageFlags.Ephemeral });
        }
        if (!isAdmin(interaction.member)) {
            return interaction.reply({ content: "You need Manage Server permissions to do that.", flags: MessageFlags.Ephemeral });
        }

        if (interaction.commandName === "add-link") {
            const url = interaction.options.getString("url", true).trim();
            const rawBlockers = interaction.options.getString("blockers", true);
            const blockerList = rawBlockers.split(/[,\s]+/).map(b => b.trim()).filter(Boolean);
            if (!/^https?:\/\//i.test(url)) {
                return interaction.reply({ content: "URL must start with `http://` or `https://`.", flags: MessageFlags.Ephemeral });
            }
            if (blockerList.length === 0) {
                return interaction.reply({ content: "Provide at least one blocker.", flags: MessageFlags.Ephemeral });
            }
            addLink(url, blockerList);
            const channel = await client.channels.fetch(TARGET_CHANNEL).catch(() => null);
            if (channel) await publishDispenser(channel);
            return interaction.reply({
                content: `Added **${url}** for blockers: ${blockerList.map(b => `\`${b}\``).join(", ")}`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === "remove-link") {
            const url = interaction.options.getString("url", true).trim();
            const removed = removeLink(url);
            if (removed === 0) {
                return interaction.reply({ content: `No entry matched **${url}**.`, flags: MessageFlags.Ephemeral });
            }
            const channel = await client.channels.fetch(TARGET_CHANNEL).catch(() => null);
            if (channel) await publishDispenser(channel);
            return interaction.reply({
                content: `Removed **${url}** (${removed} entr${removed === 1 ? "y" : "ies"} deleted).`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.commandName === "list-links") {
            if (entries.length === 0) {
                return interaction.reply({ content: "No links are currently stored.", flags: MessageFlags.Ephemeral });
            }
            const embeds = [];
            const perPage = 25;
            for (let i = 0; i < entries.length; i += perPage) {
                const slice = entries.slice(i, i + perPage);
                const embed = new EmbedBuilder()
                    .setTitle(`Stored links (${i + 1}-${i + slice.length} of ${entries.length})`)
                    .setColor(0x5865f2);
                for (const e of slice) {
                    embed.addFields({
                        name: e.url.length > 100 ? e.url.slice(0, 97) + "..." : e.url,
                        value: (e.unblockedBy || []).length ? (e.unblockedBy || []).map(b => `\`${b}\``).join(", ") : "*none*"
                    });
                }
                embeds.push(embed);
            }
            const messages = [];
            for (let i = 0; i < embeds.length; i += 10) {
                const chunk = embeds.slice(i, i + 10);
                if (messages.length === 0) {
                    messages.push(interaction.reply({ embeds: chunk, flags: MessageFlags.Ephemeral }));
                } else {
                    messages.push(interaction.followUp({ embeds: chunk, flags: MessageFlags.Ephemeral }));
                }
            }
            await Promise.all(messages);
            return;
        }
        return;
    }

    if (interaction.isAutocomplete()) {
        if (interaction.commandName === "add-link" && interaction.options.getFocused(true).name === "blockers") {
            const focused = interaction.options.getFocused().toLowerCase();
            const choices = blockers
                .filter(b => b.toLowerCase().includes(focused))
                .slice(0, 25)
                .map(b => ({ name: b, value: b }));
            return interaction.respond(choices).catch(() => {});
        }
        if (interaction.commandName === "remove-link" && interaction.options.getFocused(true).name === "url") {
            const focused = interaction.options.getFocused().toLowerCase();
            const choices = [...new Set(entries.map(e => e.url))]
                .filter(u => u.toLowerCase().includes(focused))
                .slice(0, 25)
                .map(u => ({ name: u.length > 100 ? u.slice(0, 97) + "..." : u, value: u }));
            return interaction.respond(choices).catch(() => {});
        }
        return;
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("dispense:")) return;

    const blocker = interaction.customId.slice("dispense:".length);
    const user = interaction.user;

    try {
        if (remainingFor(user.id) <= 0) {
            return await interaction.reply({
                content: `You've used all **${MAX_DAILY}** link drops for today. Try again tomorrow!`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }

        const links = [...new Set(
            entries.filter(e => (e.unblockedBy || []).includes(blocker)).map(e => e.url)
        )];

        if (links.length === 0) {
            return await interaction.reply({
                content: `No working links found for **${blocker}** right now.`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }

        const used = usedLinks(user.id);
        const available = links.filter(u => !used.includes(u));

        if (available.length === 0) {
            return await interaction.reply({
                content: `You've already received all available links for **${blocker}** today. Try again tomorrow!`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {
            // Unknown interaction or expired, ignore
            return;
        });

        const link = available[Math.floor(Math.random() * available.length)];
        recordDispense(user.id, link);
        const left = remainingFor(user.id);

        const dm = new EmbedBuilder()
            .setTitle(`Link for ${blocker}`)
            .setDescription(link)
            .setFooter({ text: `${left} of ${MAX_DAILY} drops remaining today` })
            .setColor(0x57f287);

        await user.send({ embeds: [dm] });

        await interaction.editReply({
            content: `Check your DMs! **1** link sent. (${left} left today)`
        }).catch(() => {});
    } catch (err) {
        if (err.code === 10062) { // Unknown Interaction
            console.warn(`Unknown interaction for ${user.tag} on ${blocker}`);
            return;
        }
        console.error("Button interaction error for", user.tag, err.message);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: "Something went wrong." }).catch(() => {});
            } else {
                await interaction.reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        } catch {}
    }
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(TOKEN);
