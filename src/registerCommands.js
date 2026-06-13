const {
  REST,
  Routes,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
} = require("discord.js");
const config = require("./config");

const commands = [
  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Open a form to post a new file resource")
    .toJSON(),

  new ContextMenuCommandBuilder()
    .setName("Edit Resource")
    .setType(ApplicationCommandType.Message)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("sync")
    .setDescription(
      "Force-sync all resource embeds with the database (Admin only)",
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body: commands });

  const scope = config.guildId ? `guild ${config.guildId}` : "global";
  console.log(
    `[commands] Registered ${commands.length} command(s) (${scope}).`,
  );
}

module.exports = { registerCommands };
