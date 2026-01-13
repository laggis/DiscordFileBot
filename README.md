# Discord File Bot (MySQL Edition)

This bot allows you to share large files (1GB+) on Discord by generating secure download links from your Windows IIS server. It now uses **MySQL** for robust data persistence and supports **External Mirrors**.

## Features
-   **MySQL Database**: Persistent storage for all resources. No data loss on restart.
-   **Edit Capabilities**: Edit titles, descriptions, filenames, and links of posted resources directly from Discord (Right-click -> Apps -> Edit Resource).
-   **Auto-Sync**: Changes made directly in the MySQL database (Title, Description, Filename) are automatically synced to Discord messages when the bot restarts.
-   **Auto-Delete**: Automatically removes resources from the database when the Discord message is deleted.
-   **Smart File Search**: Auto-detects archive files (`.zip`, `.rar`, `.7z`, `.tar`, `.gz`) inside folders if the exact filename isn't known.
-   **External Mirrors**: Support for direct links to external sites (e.g., Google Drive, Mega) alongside or instead of local files.
-   **Smart Expiration**: Set links to expire after a certain time or make them unlimited.
-   **Bypass Discord Limits**: Serve files of any size.

## Prerequisites
-   **Python 3.10 or higher**.
-   **MySQL Server** (local or remote).
-   **Windows IIS Web Server** (for hosting local files).
-   A Discord Bot Token.

## Setup

1.  **Install Dependencies**
    ```bash
    pip install -r requirements.txt
    ```

2.  **Database Setup**
    -   Ensure your MySQL server is running.
    -   Create a database (default: `discord_file_bot`) or let the bot create it automatically.
    -   (Optional) Use `schema.sql` to manually create the table structure.

3.  **Configuration**
    -   Rename `.env.example` to `.env`.
    -   Edit `.env` with your settings:
        ```env
        DISCORD_TOKEN=your_token_here
        GUILD_ID=your_guild_id (optional, for instant command sync)
        
        # IIS Configuration
        IIS_BASE_URL=https://your-site.com/files
        LOCAL_FILE_PATH=C:\inetpub\wwwroot\files\
        
        # Database Configuration
        MYSQL_HOST=localhost
        MYSQL_USER=root
        MYSQL_PASSWORD=your_password
        MYSQL_DATABASE=discord_file_bot
        MYSQL_PORT=3306
        ```

4.  **Run the Bot**
    ```bash
    python main.py
    ```

## Usage

### Posting a Resource
Use the `/post_resource` command to open the submission form:
-   **Title**: The name of the resource.
-   **Description**: Details about the file.
-   **Filename**: (Optional) The relative path to the file on your IIS server (e.g., `Dragonfire/[Dragonfire].zip`).
-   **Direct Link**: (Optional) An external link (e.g., Google Drive). *You must provide either a Filename or a Direct Link.*
-   **Link Expiration**: Set how long the download link lasts (e.g., `1` hour, or `0` for unlimited).

### Editing a Resource
1.  Right-click on the bot's message.
2.  Go to **Apps** -> **Edit Resource**.
3.  Update the Title, Description, Filename, or Direct Link.
4.  The message and database will update instantly.

## IIS Configuration
-   Point `IIS_BASE_URL` to the **root directory** where your files are hosted.
-   The bot appends the `Filename` you provide to this base URL.
-   **Example**:
    -   `IIS_BASE_URL`: `https://dl.mysite.com`
    -   `Filename`: `Mods/Pack.zip`
    -   Result: `https://dl.mysite.com/Mods/Pack.zip`

## Troubleshooting
-   **Database Errors**: Check your `MYSQL_` settings in `.env`. Ensure the user has permission to create tables.
-   **File Not Found**: Ensure `LOCAL_FILE_PATH` is correct and the bot has read permissions to that folder.
