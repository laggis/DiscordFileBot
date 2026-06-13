/**
 * resourceManager.js
 *
 * Shared logic for editing and deleting resources.
 * Used by both the Discord interaction handlers and the web admin panel
 * so that both paths always behave identically.
 */

const { db } = require("./database");
const { buildEmbed, buildComponents } = require("./embedBuilder");
const { resolveFilePath } = require("./storage");

/**
 * Update a resource in the database and immediately push the changes
 * to the live Discord embed.
 *
 * @param {import('discord.js').Client} client
 * @param {string} resourceId
 * @param {object} updates  - Any subset of { title, description, filename, direct_url, category }
 * @returns {object} The updated resource row
 */
async function applyResourceUpdate(client, resourceId, updates) {
  const cleaned = { ...updates };

  // Smart-resolve the filename so edits from the panel behave the same as the modal
  if (cleaned.filename) {
    cleaned.filename = resolveFilePath(
      cleaned.filename.replace(/^["']|["']$/g, "").trim(),
    );
  }

  // Convert expirationHours → expires_at timestamp (not a real DB column)
  if ("expirationHours" in cleaned) {
    const hours = parseFloat(cleaned.expirationHours);
    cleaned.expires_at =
      !isNaN(hours) && hours > 0 ? Date.now() / 1000 + hours * 3600 : null;
    delete cleaned.expirationHours;
  }

  // Coerce blank optional fields to null so the embed builder hides them correctly
  if (!cleaned.category) cleaned.category = null;

  await db.updateResource(resourceId, cleaned);

  const resource = await db.getResource(resourceId);
  if (!resource) throw new Error("Resource not found after update");

  // Push to the Discord message — best-effort (don't crash if message was deleted)
  try {
    const channel = await client.channels
      .fetch(resource.channel_id)
      .catch(() => null);

    if (channel) {
      const message = await channel.messages
        .fetch(resource.message_id)
        .catch(() => null);

      if (message) {
        // Preserve the original embed author (the user who posted it)
        const author = message.embeds[0]?.author ?? null;
        const embed = buildEmbed(resource, author ?? undefined);
        const row = buildComponents(resource);

        await message.edit({
          embeds: [embed],
          components: row ? [row] : [],
        });
      }
    }
  } catch (err) {
    console.error("[resourceManager] Discord update failed:", err.message);
  }

  return resource;
}

/**
 * Delete a resource from the database and remove its Discord message.
 *
 * @param {import('discord.js').Client} client
 * @param {string} resourceId
 */
async function removeResource(client, resourceId) {
  const resource = await db.getResource(resourceId);
  if (!resource) throw new Error("Resource not found");

  // Delete the Discord message — best-effort
  try {
    const channel = await client.channels
      .fetch(resource.channel_id)
      .catch(() => null);

    if (channel) {
      const message = await channel.messages
        .fetch(resource.message_id)
        .catch(() => null);

      if (message) await message.delete();
    }
  } catch (err) {
    console.error("[resourceManager] Discord delete failed:", err.message);
  }

  await db.deleteResource(resourceId);
}

module.exports = { applyResourceUpdate, removeResource };
