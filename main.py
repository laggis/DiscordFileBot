import discord
from discord import app_commands
from discord.ext import commands
import os
import datetime
from dotenv import load_dotenv
import storage
from database import db
import uuid

# Load environment variables
load_dotenv()

TOKEN = os.getenv('DISCORD_TOKEN')
GUILD_ID = os.getenv('GUILD_ID')

if not TOKEN:
    print("Error: DISCORD_TOKEN not found in .env")
    exit(1)

# Bot Setup
class MyBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # Register the persistent view so buttons work after restart
        self.add_view(DownloadView())
        # Sync commands (for this specific guild for faster updates during dev)
        if GUILD_ID:
            guild = discord.Object(id=GUILD_ID)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self):
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        await self.sync_resources()
        print('Bot is ready!')

    async def sync_resources(self):
        print("Starting resource synchronization...")
        resources = db.get_all_resources()
        print(f"Found {len(resources)} resources in database.")
        
        for res in resources:
            channel_id = res['channel_id']
            message_id = res['message_id']
            
            if not channel_id or not message_id:
                continue
                
            try:
                # Try to fetch channel
                channel = self.get_channel(channel_id)
                if not channel:
                    try:
                        channel = await self.fetch_channel(channel_id)
                    except (discord.NotFound, discord.Forbidden):
                        print(f"Could not access channel {channel_id} for resource {res['id']}")
                        continue

                # Try to fetch message
                try:
                    message = await channel.fetch_message(message_id)
                except discord.NotFound:
                    print(f"Message {message_id} not found for resource {res['id']}")
                    continue
                
                if not message.embeds:
                    continue

                embed = message.embeds[0]
                needs_update = False
                
                # Update Title
                if res['title'] and embed.title != res['title']:
                    embed.title = res['title']
                    needs_update = True
                
                # Update Description
                if res['description'] and embed.description != res['description']:
                    embed.description = res['description']
                    needs_update = True
                    
                # Update File Info Field (if filename is present)
                if res['filename']:
                    file_info_index = -1
                    for idx, field in enumerate(embed.fields):
                        if field.name == "📂 File Information":
                            file_info_index = idx
                            break
                    
                    if file_info_index != -1:
                        # Reconstruct value to check against
                        basename = os.path.basename(res['filename'])
                        size = storage.get_file_size(res['filename'])
                        new_value = f"**Name:** `{basename}`\n**Size:** `{size}`"
                        
                        if embed.fields[file_info_index].value != new_value:
                            embed.set_field_at(file_info_index, name="📂 File Information", value=new_value, inline=True)
                            needs_update = True
                
                if needs_update:
                    print(f"Syncing resource {res['id']} (Message {message_id})...")
                    await message.edit(embed=embed)
                    
            except Exception as e:
                print(f"Error syncing resource {res['id']}: {e}")
                
        print("Resource synchronization complete.")

bot = MyBot()

class DownloadButton(discord.ui.Button):
    def __init__(self, filename: str):
        # We store the filename in the custom_id so it persists
        # Format: download:filename
        super().__init__(
            style=discord.ButtonStyle.primary, 
            label="Download", 
            custom_id=f"download:{filename}",
            emoji="⬇️"
        )
        self.filename = filename

    async def callback(self, interaction: discord.Interaction):
        # Defer the interaction since S3 might take a split second
        await interaction.response.defer(ephemeral=True)

        # Extract filename from custom_id if needed (though self.filename is set)
        # In a persistent view, the object is recreated, so we rely on custom_id
        try:
            _, file_key = self.custom_id.split(":", 1)
        except ValueError:
            await interaction.followup.send("Error: Invalid button configuration.", ephemeral=True)
            return

        # Generate the link
        url = storage.generate_presigned_url(file_key)

        if url:
            await interaction.followup.send(
                f"**Here is your secure download link:**\n{url}\n\n*This link will expire in 1 hour.*", 
                ephemeral=True
            )
        else:
            await interaction.followup.send(
                "Error: Could not generate download link. Please contact an admin.", 
                ephemeral=True
            )

class DownloadView(discord.ui.View):
    def __init__(self, filename=None):
        super().__init__(timeout=None) # Persistent view
        if filename:
            self.add_item(DownloadButton(filename))
    
    # This is required for dynamic persistent views to work when re-loaded
    # We need to handle the custom_id parsing manually if we didn't add items in __init__
    # But since we use a dynamic custom_id, we can genericize it.
    # Actually, for persistent views with dynamic custom_ids, we usually register the view class
    # and the library handles dispatching based on the custom_id.
    # However, since the button content depends on the filename which is IN the custom_id,
    # we need to be careful.
    
    # A simpler approach for Dynamic Items in Persistent Views:
    # We just need a View that accepts any custom_id starting with "download:"
    # But discord.py's View system works by adding Items. 
    # To handle arbitrary custom_ids, we can override `dispatch`.
    # OR simpler: When the bot starts, we add the view. 
    # But wait, if I have 100 different files, I can't add 100 different Views.
    # I need ONE View class that handles the interaction.
    # But Button objects are distinct.
    
    # Better approach for this simple use case:
    # Use the `discord.ui.DynamicItem` (New in discord.py 2.0)
    # OR just rely on the fact that we can recreate the view if we know the filename.
    # BUT, to make it truly persistent without a DB, we use the `custom_id`.
    # When `bot.add_view(DownloadView())` is called, it registers the view.
    # But DownloadView needs to know which buttons to listen to.
    
    # Let's use the `custom_id` pattern matching.
    # Actually, discord.py 2.0 handles this if you add the item with the SAME custom_id.
    # But we don't know the custom_ids ahead of time (filenames vary).
    
    # CORRECTION: For fully dynamic custom_ids without a DB, we can use `bot.add_dynamic_items`.
    # Let's define a Dynamic Item.
    pass

# Removed DynamicItem for compatibility with older discord.py versions
# We now handle interactions via the global on_interaction event below

@bot.event
async def on_raw_message_delete(payload: discord.RawMessageDeleteEvent):
    """
    Triggered when a message is deleted.
    We check if the deleted message was a resource post and remove it from the DB.
    """
    message_id = payload.message_id
    
    # Check if this message corresponds to a resource
    resource = db.get_resource_by_message(message_id)
    
    if resource:
        print(f"Message {message_id} was deleted. Removing resource {resource['id']} from database...")
        success = db.delete_resource(resource['id'])
        if success:
            print(f"✅ Resource {resource['id']} ({resource.get('title', 'Unknown')}) deleted from DB.")
        else:
            print(f"❌ Failed to delete resource {resource['id']} from DB.")

@bot.event
async def on_interaction(interaction: discord.Interaction):
    # Check if it's a button click and the custom_id starts with 'download:'
    if interaction.type == discord.InteractionType.component and \
       interaction.data.get('component_type') == 2 and \
       'custom_id' in interaction.data and \
       interaction.data['custom_id'].startswith('download:'):
        
        # Manually handle it
        custom_id = interaction.data['custom_id']
        
        # Format can be:
        # 1. download:filename (Legacy)
        # 2. download:expiration:filename (Legacy V2)
        # 3. download:UUID (New DB-backed)
        
        parts = custom_id.split(':', 2)
        
        # Default values
        filename = ""
        expiration_val = storage.LINK_EXPIRATION_SECONDS
        
        # Check if it is a UUID (New System)
        is_uuid = False
        potential_uuid = parts[1]
        
        try:
            uuid_obj = uuid.UUID(potential_uuid)
            is_uuid = True
        except ValueError:
            is_uuid = False
            
        if is_uuid:
            # --- NEW SYSTEM ---
            resource_id = potential_uuid
            resource = db.get_resource(resource_id)
            
            if not resource:
                 await interaction.response.send_message("❌ **Error:** This resource no longer exists (it may have been deleted).", ephemeral=True)
                 return
            
            filename = resource['filename']
            expires_at = resource.get('expires_at') # Timestamp or None
            
            # Check Expiration
            if expires_at:
                current_time = datetime.datetime.now().timestamp()
                if current_time > expires_at:
                    await interaction.response.send_message("❌ **This download link has expired.**", ephemeral=True)
                    return
                remaining_duration = int(expires_at - current_time)
            else:
                remaining_duration = storage.LINK_EXPIRATION_SECONDS # Default for unlimited links for the signed URL part
                
            # Update download count (optional)
            db.update_resource(resource_id, {'downloads': resource.get('downloads', 0) + 1})
            
        else:
            # --- LEGACY SYSTEMS ---
            if len(parts) == 3:
                # Format: download:expiration:filename
                try:
                    expiration_val = int(parts[1])
                except ValueError:
                    expiration_val = storage.LINK_EXPIRATION_SECONDS
                filename = parts[2]
            else:
                # Legacy format: download:filename
                filename = parts[1]
                expiration_val = storage.LINK_EXPIRATION_SECONDS
                
            # Logic to handle Timestamp vs Duration
            current_time = datetime.datetime.now().timestamp()
            
            if expiration_val > 1000000000:
                # It's a timestamp
                if current_time > expiration_val:
                    await interaction.response.send_message("❌ **This download link has expired.**", ephemeral=True)
                    return
                remaining_duration = int(expiration_val - current_time)
            else:
                # It's a duration
                remaining_duration = expiration_val

        await interaction.response.defer(ephemeral=True)
        
        # Generate URL
        # We pass remaining_duration. If using direct links (no secret), this is ignored.
        url = storage.generate_presigned_url(filename, expiration=remaining_duration)
        
        if url:
            # Create a private embed for the download link
            link_embed = discord.Embed(
                title="🚀 Download Ready",
                description=f"Your direct link for **{os.path.basename(filename)}** is ready.",
                color=0x2ECC71 # Emerald Green
            )
            link_embed.add_field(name="🔗 Download Link", value=f"[**Click here to Download**]({url})", inline=False)
            
            # Only show expiration if it's relevant (i.e., not a permanent direct link or unlimited)
            # With direct links, the link itself doesn't expire, but the button might.
            # We'll just omit the "Expires In" field to avoid confusion, 
            # since the user specifically asked for direct links which are permanent.
            
            link_embed.set_footer(text="⚠️ This is a direct download link.")

            await interaction.followup.send(embed=link_embed, ephemeral=True)
        else:
            await interaction.followup.send(
                "Error: Could not generate download link. Please check configuration.", 
                ephemeral=True
            )
        return

    # Process other interactions (commands) normally
    pass


# Commands
class ResourceModal(discord.ui.Modal, title="Post New Resource"):
    resource_title = discord.ui.TextInput(
        label="Title",
        placeholder="Enter the title of the resource",
        required=True
    )
    
    resource_description = discord.ui.TextInput(
        label="Description",
        placeholder="Enter a detailed description...",
        style=discord.TextStyle.paragraph,
        required=True
    )
    
    filename = discord.ui.TextInput(
        label="Filename (Relative Path)",
        placeholder="e.g. Dragonfire/[Dragonfire].zip",
        required=False
    )

    direct_link = discord.ui.TextInput(
        label="Direct Download Link (Optional)",
        placeholder="e.g. https://mysite.com/file.zip",
        required=False
    )
    
    expiration = discord.ui.TextInput(
        label="Link Expiration (Hours)",
        placeholder="Default: 1. Enter 0 for Unlimited.",
        default="1",
        required=False,
        max_length=5
    )

    async def on_submit(self, interaction: discord.Interaction):
        try:
            # Defer immediately to avoid timeout
            await interaction.response.defer(ephemeral=True)

            # Sanitize filename
            input_filename = self.filename.value.strip('"').strip("'")
            direct_url = self.direct_link.value.strip()
            
            # Parse Expiration
            hours = 1.0
            try:
                exp_val = self.expiration.value.strip()
                if not exp_val:
                    hours = 1.0
                    expiry_display = "1 hour"
                else:
                    hours = float(exp_val)
                    if hours <= 0:
                        hours = 0
                        expiry_display = "Unlimited"
                    else:
                        expiry_display = f"{hours} hour(s)"
            except ValueError:
                hours = 1.0
                expiry_display = "1 hour"

            # Auto-resolve path (e.g. [Dragonfire].zip -> Dragonfire/[Dragonfire].zip)
            resolved_filename = storage.resolve_file_path(input_filename) if input_filename else ""

            if not resolved_filename and not direct_url:
                await interaction.followup.send(
                    "⚠️ Error: You must provide either a **Filename** OR a **Direct Link**.", 
                    ephemeral=True
                )
                return

            # Create a rich embed
            embed = discord.Embed(
                title=self.resource_title.value, 
                description=self.resource_description.value, 
                color=0x5865F2, # Discord Blurple
                timestamp=datetime.datetime.now()
            )
            
            view = discord.ui.View(timeout=None)
            
            # Logic: If Direct Link is provided, use that. 
            # If Filename is provided, use the secure button.
            
            # Generate ID early
            resource_id = str(uuid.uuid4())
            
            if resolved_filename:
                # Check if file exists (only if using secure filename)
                file_exists = storage.check_file_exists(resolved_filename)
                file_size = storage.get_file_size(resolved_filename)
                
                embed.add_field(
                    name="📂 File Information", 
                    value=f"**Name:** `{os.path.basename(resolved_filename)}`\n**Size:** `{file_size}`",
                    inline=True
                )
                
                embed.add_field(
                    name="⏳ Availability",
                    value=f"**Expires:** `{expiry_display}`\n**Status:** `Online ✅`",
                    inline=True
                )
                
                secure_button = discord.ui.Button(
                    style=discord.ButtonStyle.success, # Green for action
                    label="Download Now", 
                    custom_id=f"download:{resource_id}", # New Format: download:UUID
                    emoji="📥" 
                )
                view.add_item(secure_button)

            if direct_url:
                # Add a Link Button
                link_button = discord.ui.Button(
                    style=discord.ButtonStyle.link,
                    label="External Mirror",
                    url=direct_url,
                    emoji="🌐"
                )
                view.add_item(link_button)

            # Footer and Author
            embed.set_footer(text="Secure File Delivery • Penguin Hosting", icon_url="https://cdn.penguinhosting.host/download.png") # Optional nice icon
            embed.set_author(name=interaction.user.display_name, icon_url=interaction.user.display_avatar.url)
            
            # Send to channel
            message = await interaction.channel.send(embed=embed, view=view)
            
            # --- SAVE TO DB ---
            if resolved_filename or direct_url:
                db.add_resource(
                    title=self.resource_title.value,
                    description=self.resource_description.value,
                    filename=resolved_filename,
                    owner_id=interaction.user.id,
                    message_id=message.id,
                    channel_id=message.channel.id,
                    expiration_hours=hours,
                    resource_id=resource_id,
                    direct_url=direct_url
                )
            
            # Reply to the user (ephemeral)
            msg = "✅ **Resource posted successfully!**"
            
            if resolved_filename and not storage.check_file_exists(resolved_filename):
                 msg += f"\n⚠️ **Warning:** Could not find `{resolved_filename}` on the server. The button might not work."
            
            await interaction.followup.send(msg, ephemeral=True)
            
        except Exception as e:
            print(f"CRITICAL ERROR in on_submit: {e}")
            try:
                await interaction.followup.send(f"❌ Critical Error: {str(e)}", ephemeral=True)
            except:
                pass

@bot.tree.command(name="post_resource", description="Open a form to post a new resource")
async def post_resource(interaction: discord.Interaction):
    # Show the modal
    await interaction.response.send_modal(ResourceModal())

# --- CONTEXT MENUS FOR EDITING ---

class EditResourceModal(discord.ui.Modal, title="Edit Resource"):
    def __init__(self, resource_id: str, current_title: str, current_desc: str, current_filename: str, current_direct_url: str):
        super().__init__()
        self.resource_id = resource_id
        
        self.new_title = discord.ui.TextInput(
            label="Title",
            default=current_title,
            required=True
        )
        self.add_item(self.new_title)
        
        self.new_desc = discord.ui.TextInput(
            label="Description",
            default=current_desc,
            style=discord.TextStyle.paragraph,
            required=True
        )
        self.add_item(self.new_desc)
        
        self.new_filename = discord.ui.TextInput(
            label="Filename (Relative Path)",
            default=current_filename or "",
            required=False
        )
        self.add_item(self.new_filename)

        self.new_direct_url = discord.ui.TextInput(
            label="Direct Download Link (External)",
            default=current_direct_url or "",
            required=False
        )
        self.add_item(self.new_direct_url)

    async def on_submit(self, interaction: discord.Interaction):
        # 1. Update DB
        updates = {
            "title": self.new_title.value,
            "description": self.new_desc.value,
            "filename": self.new_filename.value.strip('"').strip("'"),
            "direct_url": self.new_direct_url.value.strip()
        }
        
        success = db.update_resource(self.resource_id, updates)
        if not success:
            await interaction.response.send_message("❌ Error: Could not update resource in DB.", ephemeral=True)
            return

        # 2. Update the Message Embed
        resource = db.get_resource(self.resource_id)
        
        # We need to fetch the message. 
        # Since we are in an interaction, we might have access to it if we triggered from a button,
        # but here we triggered from a Context Menu on the message.
        
        # Actually, the modal is submitted AFTER the context menu. 
        # We need to find the message.
        # Ideally, we pass the message object or ID to the modal, but Modals don't store state easily unless passed in __init__.
        # We have resource['message_id'] and resource['channel_id'].
        
        channel = bot.get_channel(resource['channel_id'])
        if channel:
            try:
                message = await channel.fetch_message(resource['message_id'])
                
                # Reconstruct Embed
                # We want to keep the original author and timestamp if possible, or update them.
                # Let's keep original timestamp but update content.
                
                # Get existing embed to preserve footer/author
                if message.embeds:
                    old_embed = message.embeds[0]
                    embed = old_embed.copy()
                    embed.title = updates['title']
                    embed.description = updates['description']
                    
                    # Update File Info Field
                    # We need to find the field index. Usually it's the first one.
                    # Or we just clear fields and re-add.
                    embed.clear_fields()
                    
                    # Re-check file size
                    new_filename = updates['filename']
                    # Resolve path again just in case?
                    resolved = storage.resolve_file_path(new_filename)
                    file_size = storage.get_file_size(resolved)
                    
                    embed.add_field(
                        name="📂 File Information", 
                        value=f"**Name:** `{os.path.basename(resolved)}`\n**Size:** `{file_size}`",
                        inline=True
                    )
                    
                    # Restore Availability Field (we don't have the original expiry text easily unless we recalculate)
                    # We can use the expiry from DB
                    expires_at = resource.get('expires_at')
                    if not expires_at:
                        expiry_display = "Unlimited"
                    else:
                        # Calculate hours remaining or just show date?
                        # Let's show "Valid until..." or just "X hours"
                        # For consistency with original post style:
                        remaining = expires_at - datetime.datetime.now().timestamp()
                        if remaining > 0:
                            hours = round(remaining / 3600, 1)
                            expiry_display = f"{hours} hour(s)"
                        else:
                            expiry_display = "Expired"

                    embed.add_field(
                        name="⏳ Availability",
                        value=f"**Expires:** `{expiry_display}`\n**Status:** `Online ✅`",
                        inline=True
                    )
                    
                    await message.edit(embed=embed)
                    await interaction.response.send_message("✅ **Resource updated successfully!**", ephemeral=True)
                else:
                    await interaction.response.send_message("⚠️ Updated DB, but could not find original embed to edit.", ephemeral=True)

            except discord.NotFound:
                await interaction.response.send_message("⚠️ Updated DB, but the message seems to have been deleted.", ephemeral=True)
            except Exception as e:
                await interaction.response.send_message(f"⚠️ Error updating message: {e}", ephemeral=True)
        else:
             await interaction.response.send_message("⚠️ Updated DB, but could not find the channel.", ephemeral=True)


@bot.tree.context_menu(name="Edit Resource")
async def edit_resource_context(interaction: discord.Interaction, message: discord.Message):
    # Check if this message is a resource post
    # We look up by message ID
    resource = db.get_resource_by_message(message.id)
    
    if not resource:
        await interaction.response.send_message("❌ This message does not appear to be a managed resource.", ephemeral=True)
        return
        
    # Check permission (Owner or Admin)
    # For now, let's assume if you can see the command you can use it, or check ID
    if interaction.user.id != resource['owner_id'] and not interaction.user.guild_permissions.administrator:
        await interaction.response.send_message("❌ You do not have permission to edit this resource.", ephemeral=True)
        return

    # Open Modal
    await interaction.response.send_modal(
        EditResourceModal(
            resource_id=resource['id'],
            current_title=resource['title'],
            current_desc=resource['description'],
            current_filename=resource['filename'],
            current_direct_url=resource.get('direct_url', '')
        )
    )

if __name__ == '__main__':
    bot.run(TOKEN)
