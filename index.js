const { Client, GatewayIntentBits, Partials } = require("discord.js");
const config = require("./src/config");
const { db } = require("./src/database");
const { registerCommands } = require("./src/registerCommands");
const { syncResources } = require("./src/sync");
const { handleInteraction } = require("./src/interactions");
const { startWebPanel } = require("./src/webPanel");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  // Partials let messageDelete fire for messages that aren't in the cache
  partials: [Partials.Message, Partials.Channel],
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);

  await registerCommands();
  await syncResources(client);
  startWebPanel(client);

  console.log("Bot is ready!");
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on("interactionCreate", handleInteraction);

// ─── Auto-delete on message removal ──────────────────────────────────────────

client.on("messageDelete", async (message) => {
  try {
    const resource = await db.getResourceByMessage(message.id);
    if (resource) {
      await db.deleteResource(resource.id);
      console.log(`[bot] Resource ${resource.id} removed (message deleted).`);
    }
  } catch (err) {
    console.error("[bot] messageDelete handler error:", err.message);
  }
});

// Some messages are not cached when deleted; catch them via the raw gateway event
client.on("raw", async (packet) => {
  if (packet.t !== "MESSAGE_DELETE") return;
  try {
    const resource = await db.getResourceByMessage(packet.d.id);
    if (resource) {
      await db.deleteResource(resource.id);
      console.log(
        `[bot] Resource ${resource.id} removed (raw message delete).`,
      );
    }
  } catch (err) {
    console.error("[bot] raw MESSAGE_DELETE handler error:", err.message);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await db.init();
  await client.login(config.token);
})();
