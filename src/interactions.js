/**
 * interactions.js
 *
 * Routes every Discord interaction to the correct handler:
 *  - /post_resource  → shows the post modal
 *  - Post modal submit → posts embed to channel, saves to DB
 *  - download:<uuid> button → generates and sends a private download link
 *  - "Edit Resource" context menu → shows the edit modal
 *  - Edit modal submit → updates DB + Discord message
 */

const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonStyle,
} = require("discord.js");

const { db } = require("./database");
const { generateUrl, resolveFilePath, checkFileExists } = require("./storage");
const { buildEmbed, buildComponents } = require("./embedBuilder");
const { syncResources } = require("./sync");
const { applyResourceUpdate } = require("./resourceManager");
const config = require("./config");

// ─── Main Router ─────────────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "post") {
        return await handlePostResourceCommand(interaction);
      }
      if (interaction.commandName === "sync") {
        return await handleSyncCommand(interaction);
      }
    }

    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === "Edit Resource") {
        return await handleEditResourceMenu(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "post_resource_modal") {
        return await handlePostResourceModal(interaction);
      }
      if (interaction.customId.startsWith("edit_resource_modal:")) {
        return await handleEditResourceModal(interaction);
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("download:")) {
        return await handleDownloadButton(interaction);
      }
    }
  } catch (err) {
    console.error("[interactions] Unhandled error:", err);
    const msg = {
      content: "❌ An unexpected error occurred.",
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
}

// ─── /post_resource ───────────────────────────────────────────────────────────

async function handlePostResourceCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("post_resource_modal")
    .setTitle("Post New Resource")
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Name of the resource")
          .setRequired(true),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Detailed description of the file/resource...")
          .setRequired(true),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("filename")
          .setLabel("Filename (relative path on server)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Dragonfire/[Dragonfire].zip")
          .setRequired(false),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("direct_url")
          .setLabel("Direct Download Link (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. https://drive.google.com/...")
          .setRequired(false),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("expiration")
          .setLabel("Link Expiration (hours, 0 = unlimited)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Default: 1")
          .setValue("1")
          .setMaxLength(5)
          .setRequired(false),
      ),
    );

  await interaction.showModal(modal);
}

// ─── Post modal submit ────────────────────────────────────────────────────────

async function handlePostResourceModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.fields.getTextInputValue("title").trim();
  const description = interaction.fields
    .getTextInputValue("description")
    .trim();
  const rawFilename = interaction.fields
    .getTextInputValue("filename")
    .trim()
    .replace(/^["']|["']$/g, "");
  const directUrl = interaction.fields.getTextInputValue("direct_url").trim();
  const expirationRaw = interaction.fields
    .getTextInputValue("expiration")
    .trim();

  // Parse expiration
  let expirationHours = 1;
  const parsed = parseFloat(expirationRaw);
  if (!isNaN(parsed)) expirationHours = parsed <= 0 ? 0 : parsed;

  // Resolve the filename to its actual path on disk
  const filename = rawFilename ? resolveFilePath(rawFilename) : "";

  if (!filename && !directUrl) {
    return interaction.followUp({
      content:
        "⚠️ You must provide either a **Filename** or a **Direct Link**.",
      ephemeral: true,
    });
  }

  const resourceId = uuidv4();

  // Build resource object so buildEmbed/buildComponents can use it
  const resource = {
    id: resourceId,
    title,
    description,
    filename,
    direct_url: directUrl,
    created_at: Date.now() / 1000,
    expires_at:
      expirationHours > 0 ? Date.now() / 1000 + expirationHours * 3600 : null,
    owner_id: interaction.user.id,
  };

  const embed = buildEmbed(resource, {
    name: interaction.user.displayName,
    iconURL: interaction.user.displayAvatarURL(),
  });
  const actionRow = buildComponents(resource);

  const message = await interaction.channel.send({
    embeds: [embed],
    components: actionRow ? [actionRow] : [],
  });

  // Save to DB
  await db.addResource({
    id: resourceId,
    title,
    description,
    filename,
    ownerId: interaction.user.id,
    messageId: message.id,
    channelId: message.channel.id,
    expirationHours,
    directUrl,
  });

  let replyMsg = "✅ **Resource posted successfully!**";
  if (filename && !checkFileExists(filename)) {
    replyMsg += `\n⚠️ Warning: \`${filename}\` was not found on the server — the download button may not work.`;
  }

  await interaction.followUp({ content: replyMsg, ephemeral: true });
}

// ─── Download button ──────────────────────────────────────────────────────────

async function handleDownloadButton(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const resourceId = interaction.customId.slice("download:".length);
  const resource = await db.getResource(resourceId);

  if (!resource) {
    return interaction.followUp({
      content: "❌ This resource no longer exists (it may have been deleted).",
      ephemeral: true,
    });
  }

  // Check expiry
  if (resource.expires_at && Date.now() / 1000 > resource.expires_at) {
    return interaction.followUp({
      content: "❌ This download link has **expired**.",
      ephemeral: true,
    });
  }

  const remaining = resource.expires_at
    ? Math.max(0, Math.floor(resource.expires_at - Date.now() / 1000))
    : config.linkExpirationSeconds;

  const url = generateUrl(resource.filename, remaining);
  if (!url) {
    return interaction.followUp({
      content:
        "❌ Could not generate a download link. Please contact an admin.",
      ephemeral: true,
    });
  }

  await db.incrementDownloads(resourceId);

  const linkEmbed = new EmbedBuilder()
    .setTitle("🚀 Download Ready")
    .setDescription(
      `Your link for **${path.basename(resource.filename)}** is ready.`,
    )
    .setColor(0x2ecc71)
    .addFields({
      name: "🔗 Download Link",
      value: `[**Click here to Download**](${url})`,
      inline: false,
    })
    .setFooter({ text: "⚠️ This is a direct download link." });

  await interaction.followUp({ embeds: [linkEmbed], ephemeral: true });
}

// ─── /sync ───────────────────────────────────────────────────────────────────

async function handleSyncCommand(interaction) {
  if (!interaction.memberPermissions?.has("Administrator")) {
    return interaction.reply({
      content: "❌ Only administrators can run `/sync`.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const stats = await syncResources(interaction.client);

  await interaction.followUp({
    content:
      `✅ **Sync complete!**\n` +
      `📝 Updated: **${stats.updated}**\n` +
      `✔️ Unchanged: **${stats.unchanged}**\n` +
      `🗑️ Removed: **${stats.removed}**\n` +
      `❌ Errors: **${stats.errors}**`,
    ephemeral: true,
  });
}

// ─── "Edit Resource" context menu ────────────────────────────────────────────

async function handleEditResourceMenu(interaction) {
  const resource = await db.getResourceByMessage(interaction.targetMessage.id);

  if (!resource) {
    return interaction.reply({
      content: "❌ This message is not a managed resource.",
      ephemeral: true,
    });
  }

  const isOwner = interaction.user.id === resource.owner_id;
  const isAdmin = interaction.memberPermissions?.has("Administrator");
  if (!isOwner && !isAdmin) {
    return interaction.reply({
      content: "❌ You do not have permission to edit this resource.",
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`edit_resource_modal:${resource.id}`)
    .setTitle("Edit Resource")
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setValue(resource.title || "")
          .setRequired(true),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setValue(resource.description || "")
          .setRequired(true),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("filename")
          .setLabel("Filename (relative path)")
          .setStyle(TextInputStyle.Short)
          .setValue(resource.filename || "")
          .setRequired(false),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("direct_url")
          .setLabel("Direct Download Link")
          .setStyle(TextInputStyle.Short)
          .setValue(resource.direct_url || "")
          .setRequired(false),
      ),
      row(
        new TextInputBuilder()
          .setCustomId("category")
          .setLabel("Category (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Mods, Tools, Maps, Plugins...")
          .setValue(resource.category || "")
          .setRequired(false),
      ),
    );

  await interaction.showModal(modal);
}

// ─── Edit modal submit ────────────────────────────────────────────────────────

async function handleEditResourceModal(interaction) {
  const resourceId = interaction.customId.slice("edit_resource_modal:".length);

  const newTitle = interaction.fields.getTextInputValue("title").trim();
  const newDesc = interaction.fields.getTextInputValue("description").trim();
  const rawFilename = interaction.fields
    .getTextInputValue("filename")
    .trim()
    .replace(/^["']|["']$/g, "");
  const newDirectUrl = interaction.fields
    .getTextInputValue("direct_url")
    .trim();
  const newCategory = interaction.fields.getTextInputValue("category").trim();

  // Resolve the new filename (smart search)
  const newFilename = rawFilename ? resolveFilePath(rawFilename) : "";

  if (!newFilename && !newDirectUrl) {
    return interaction.reply({
      content: "⚠️ You must keep either a **Filename** or a **Direct Link**.",
      ephemeral: true,
    });
  }

  try {
    await applyResourceUpdate(interaction.client, resourceId, {
      title: newTitle,
      description: newDesc,
      filename: newFilename,
      direct_url: newDirectUrl,
      category: newCategory || null,
    });
  } catch (err) {
    return interaction.reply({
      content: `❌ Update failed: ${err.message}`,
      ephemeral: true,
    });
  }

  await interaction.reply({
    content: "✅ **Resource updated successfully!**",
    ephemeral: true,
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Wrap a single TextInputBuilder in an ActionRowBuilder (required by Discord). */
function row(input) {
  return new ActionRowBuilder().addComponents(input);
}

module.exports = { handleInteraction };
