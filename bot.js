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
    MessageFlags
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL = process.env.DISCORD_TARGET_CHANNEL;
const LINKS_FILE = path.join(__dirname, "links.txt");
const MAX_DAILY = 3;

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
    let pending = null;
    const lines = fs.readFileSync(LINKS_FILE, "utf8").split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith(":")) {
            const tokens = line.split(":").map(t => t.trim()).filter(Boolean);
            pending = tokens.filter(t => !/^[\d/.]+$/.test(t));
        } else if (pending && /^https?:\/\//i.test(line)) {
            entries.push({ blockers: [...pending], url: line });
            pending = null;
        }
    }
    blockers = [...new Set(entries.flatMap(e => e.blockers))].sort();
    console.log(`Imported ${entries.length} link(s) covering ${blockers.length} blocker(s).`);
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
            const count = entries.filter(e => e.blockers.includes(blocker)).length;
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
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("dispense:")) return;

    const blocker = interaction.customId.slice("dispense:".length);
    const user = interaction.user;

    if (remainingFor(user.id) <= 0) {
        return interaction.reply({
            content: `You've used all **${MAX_DAILY}** link drops for today. Try again tomorrow!`,
            flags: MessageFlags.Ephemeral
        });
    }

    const links = [...new Set(
        entries.filter(e => e.blockers.includes(blocker)).map(e => e.url)
    )];

    if (links.length === 0) {
        return interaction.reply({
            content: `No working links found for **${blocker}** right now.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const used = usedLinks(user.id);
    const available = links.filter(u => !used.includes(u));

    if (available.length === 0) {
        return interaction.reply({
            content: `You've already received all available links for **${blocker}** today. Try again tomorrow!`,
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const link = available[Math.floor(Math.random() * available.length)];
        recordDispense(user.id, link);
        const left = remainingFor(user.id);

        const dm = new EmbedBuilder()
            .setTitle(`Link for ${blocker}`)
            .setDescription(link)
            .setFooter({ text: `${left} of ${MAX_DAILY} drops remaining today` })
            .setColor(0x57f287);

        await user.send({ embeds: [dm] });

        return interaction.editReply({
            content: `Check your DMs! **1** link sent. (${left} left today)`
        });
    } catch (err) {
        console.error("DM failed for", user.tag, err.message);
        return interaction.editReply({
            content: "I couldn't DM you, make sure your DMs are open."
        });
    }
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(TOKEN);
