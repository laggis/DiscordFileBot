# Discord File Bot (Node.js)

Node.js rewrite of the Python Discord File Bot. Shares large files via Discord using Discord embeds and download buttons backed by a Windows IIS server and MySQL.

## Features

- `/post_resource` — modal form to post a new file resource embed
- **Download button** — generates a direct (or HMAC-signed) IIS download URL, sent privately
- **Edit Resource** — right-click a bot message → Apps → Edit Resource to update any field
- **Auto-sync on startup** — compares every DB record against the live Discord message and pushes any differences (title, description, file size, expiry, direct URL button)
- **Auto-delete** — removes the DB record when its Discord message is deleted
- **Smart file resolution** — bracket-strip heuristic + recursive search to find files automatically
- **HMAC-signed URLs** — optionally protect downloads with a time-limited signed link

## Setup

### 1. Install dependencies

```
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```
DISCORD_TOKEN=        # Bot token from Discord Developer Portal
CLIENT_ID=            # Application (client) ID from Discord Developer Portal
GUILD_ID=             # (optional) Server ID for instant command registration during dev

IIS_BASE_URL=         # Base URL of your IIS file server, e.g. https://dl.mysite.com
IIS_SECURE_SECRET=    # (optional) Shared secret for HMAC-signed URLs
LOCAL_FILE_PATH=      # Absolute path to the root files directory on this machine

MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=discord_file_bot
MYSQL_PORT=3306

LINK_EXPIRATION_SECONDS=3600
```

### 3. Run

```
node index.js
# or with auto-restart:
npm run dev
```

The bot will:
1. Create the MySQL database and `resources` table if they don't exist
2. Register slash commands (`/post_resource`) and the "Edit Resource" context menu
3. Sync all existing resources against their Discord messages
4. Start listening for interactions

## IIS URL behaviour

| `IIS_SECURE_SECRET` set? | Result |
|---|---|
| No  | Plain direct link: `https://base-url/Filename.zip` |
| Yes | HMAC-signed link: `https://base-url?file=...&expires=...&signature=...` |

## File resolution order

When a filename is submitted, the bot tries to find it in this order:

1. **Exact match** — `LOCAL_FILE_PATH\filename`
2. **Bracket-strip + folder scan** — strips `[` `]` from the name, looks for a matching folder, then searches common filename variants inside it
3. **Recursive search** — walks all subdirectories for a file with that base name

## Permissions

- Resource owner **or** server administrator can use "Edit Resource"
- Download link is sent **privately** (ephemeral) to the requesting user
