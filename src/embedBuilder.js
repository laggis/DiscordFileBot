/**
 * embedBuilder.js
 *
 * Single source of truth for how resource embeds look.
 * Both the initial post and every subsequent sync/edit use these same
 * functions, so the embed is ALWAYS consistent with the database.
 */

const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { getFileSize } = require("./storage");

// ─── Embed Construction ───────────────────────────────────────────────────────

/**
 * Build a complete EmbedBuilder from a resource row.
 *
 * @param {object} resource  - Row from the `resources` table
 * @param {object} [author]  - Optional { name, iconURL } for the embed author
 * @returns {EmbedBuilder}
 */
function buildEmbed(resource, author = null) {
  const embed = new EmbedBuilder()
    .setTitle(resource.title || "Untitled")
    .setDescription(resource.description || "")
    .setColor(0x5865f2)
    .setTimestamp(new Date(resource.created_at * 1000))
    .setFooter({ text: "Secure File Delivery • Penguin Hosting" });

  if (author?.name) {
    embed.setAuthor({ name: author.name, iconURL: author.iconURL });
  }

  if (resource.category) {
    embed.addFields({
      name: "🏷️ Category",
      value: resource.category,
      inline: true,
    });
  }

  if (resource.filename) {
    // Always pull a fresh size directly from disk
    const size = getFileSize(resource.filename);
    const basename = path.basename(resource.filename);

    embed.addFields(
      {
        name: "📂 File Information",
        value: `**Name:** \`${basename}\`\n**Size:** \`${size}\``,
        inline: true,
      },
      {
        name: "⏳ Availability",
        value: `**Expires:** \`${formatExpiry(resource.expires_at)}\`\n**Status:** \`Online ✅\``,
        inline: true,
      },
    );
  }

  embed.addFields({
    name: "📥 Downloads",
    value: String(resource.downloads || 0),
    inline: true,
  });

  return embed;
}

/**
 * Build the ActionRow of buttons for a resource.
 * Returns null when there are no buttons to show.
 *
 * @param {object} resource
 * @returns {ActionRowBuilder|null}
 */
function buildComponents(resource) {
  const buttons = [];

  if (resource.filename) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`download:${resource.id}`)
        .setLabel("Download Now")
        .setEmoji("📥")
        .setStyle(ButtonStyle.Success),
    );
  }

  if (resource.direct_url) {
    buttons.push(
      new ButtonBuilder()
        .setURL(resource.direct_url)
        .setLabel("External Mirror")
        .setEmoji("🌐")
        .setStyle(ButtonStyle.Link),
    );
  }

  if (buttons.length === 0) return null;
  return new ActionRowBuilder().addComponents(buttons);
}

// ─── Diff Detection ───────────────────────────────────────────────────────────

/**
 * Determine whether a Discord message's embed/components are out of sync
 * with the database record.
 *
 * This is intentionally comprehensive — it catches every field the bot manages
 * so that a manual DB edit is always reflected on the next restart.
 *
 * @param {object}   resource      - DB row
 * @param {Embed}    discordEmbed  - message.embeds[0]
 * @param {ActionRow[]} discordComponents - message.components
 * @returns {boolean}
 */
function needsUpdate(resource, discordEmbed, discordComponents) {
  // ── Embed text fields ──
  if (discordEmbed.title !== (resource.title || "Untitled")) return true;
  if (discordEmbed.description !== (resource.description || "")) return true;

  // ── Category field ──
  const categoryField = (discordEmbed.fields || []).find(
    (f) => f.name === "🏷️ Category",
  );
  if (resource.category) {
    if (!categoryField || categoryField.value !== resource.category)
      return true;
  } else {
    if (categoryField) return true;
  }

  // ── Downloads field ──
  const downloadsField = (discordEmbed.fields || []).find(
    (f) => f.name === "📥 Downloads",
  );
  if (
    !downloadsField ||
    downloadsField.value !== String(resource.downloads || 0)
  )
    return true;

  // ── File info fields ──
  if (resource.filename) {
    const freshSize = getFileSize(resource.filename);
    const basename = path.basename(resource.filename);

    const fileField = (discordEmbed.fields || []).find(
      (f) => f.name === "📂 File Information",
    );
    const expectedFileValue = `**Name:** \`${basename}\`\n**Size:** \`${freshSize}\``;
    if (!fileField || fileField.value !== expectedFileValue) return true;

    const availField = (discordEmbed.fields || []).find(
      (f) => f.name === "⏳ Availability",
    );
    const expectedAvailValue = `**Expires:** \`${formatExpiry(resource.expires_at)}\`\n**Status:** \`Online ✅\``;
    if (!availField || availField.value !== expectedAvailValue) return true;
  } else {
    // If filename was removed, ensure no file info field remains
    const hasFileField = (discordEmbed.fields || []).some(
      (f) => f.name === "📂 File Information",
    );
    if (hasFileField) return true;
  }

  // ── Direct URL button ──
  const existingLinkBtn = discordComponents
    ?.flatMap((row) => row.components)
    .find((c) => c.style === ButtonStyle.Link);

  if (resource.direct_url) {
    if (!existingLinkBtn || existingLinkBtn.url !== resource.direct_url)
      return true;
  } else {
    if (existingLinkBtn) return true; // button should be gone
  }

  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatExpiry(expiresAt) {
  if (!expiresAt) return "Unlimited";
  const remaining = expiresAt - Date.now() / 1000;
  if (remaining <= 0) return "Expired";
  const hours = (remaining / 3600).toFixed(1);
  return `${hours} hour(s)`;
}

module.exports = { buildEmbed, buildComponents, needsUpdate };
