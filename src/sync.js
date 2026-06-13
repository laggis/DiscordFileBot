/**
 * sync.js
 *
 * On bot startup, compare every resource in the DB against its live Discord
 * message and push any updates. This catches:
 *  - Manual DB edits (title, description, filename, direct_url)
 *  - File size changes on disk
 *  - Expiry recalculations
 *  - Messages that were deleted while the bot was offline
 */

const { db } = require("./database");
const { buildEmbed, buildComponents, needsUpdate } = require("./embedBuilder");

async function syncResources(client) {
  console.log("[sync] Starting resource synchronization...");

  const resources = await db.getAllResources();
  console.log(`[sync] ${resources.length} resource(s) in database.`);

  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let errors = 0;

  for (const resource of resources) {
    if (!resource.channel_id || !resource.message_id) {
      unchanged++;
      continue;
    }

    try {
      // ── Fetch the channel ──
      let channel = client.channels.cache.get(resource.channel_id);
      if (!channel) {
        channel = await client.channels
          .fetch(resource.channel_id)
          .catch(() => null);
      }
      if (!channel) {
        console.warn(
          `[sync] Channel ${resource.channel_id} not accessible for resource ${resource.id}`,
        );
        unchanged++;
        continue;
      }

      // ── Fetch the message ──
      const message = await channel.messages
        .fetch(resource.message_id)
        .catch(() => null);
      if (!message) {
        // Message was deleted while bot was offline — clean up DB
        console.log(
          `[sync] Message ${resource.message_id} gone; removing resource ${resource.id}`,
        );
        await db.deleteResource(resource.id);
        removed++;
        continue;
      }

      if (!message.embeds.length) {
        unchanged++;
        continue;
      }

      // ── Compare and update ──
      if (needsUpdate(resource, message.embeds[0], message.components)) {
        console.log(
          `[sync] Updating resource ${resource.id} ("${resource.title}")`,
        );

        const embed = buildEmbed(resource);
        const row = buildComponents(resource);

        await message.edit({
          embeds: [embed],
          components: row ? [row] : [],
        });

        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error(
        `[sync] Error processing resource ${resource.id}:`,
        err.message,
      );
      errors++;
    }
  }

  console.log(
    `[sync] Done — ${updated} updated, ${unchanged} unchanged, ${removed} removed, ${errors} error(s).`,
  );

  return { updated, unchanged, removed, errors };
}

module.exports = { syncResources };
