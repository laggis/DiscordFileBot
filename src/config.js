require("dotenv").config();

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,

  mysql: {
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "discord_file_bot",
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
  },

  iis: {
    baseUrl: (process.env.IIS_BASE_URL || "").replace(/\/+$/, ""),
    secureSecret: process.env.IIS_SECURE_SECRET || "",
    localFilePath: (process.env.LOCAL_FILE_PATH || "")
      .replace(/^["']|["']$/g, "")
      .trim(),
  },

  linkExpirationSeconds: parseInt(
    process.env.LINK_EXPIRATION_SECONDS || "3600",
    10,
  ),

  panel: {
    port: parseInt(process.env.PANEL_PORT || "3000", 10),
    secret: process.env.PANEL_SECRET || "",
  },
};

if (!config.token) {
  console.error("ERROR: DISCORD_TOKEN is not set in .env");
  process.exit(1);
}
if (!config.clientId) {
  console.error("ERROR: CLIENT_ID is not set in .env");
  process.exit(1);
}

module.exports = config;
