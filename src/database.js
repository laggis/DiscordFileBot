const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const config = require("./config");

class Database {
  constructor() {
    this.pool = null;
  }

  async init() {
    await this._ensureDatabase();

    this.pool = mysql.createPool({
      host: config.mysql.host,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      port: config.mysql.port,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await this._initSchema();
    console.log("Database ready.");
  }

  async _ensureDatabase() {
    const conn = await mysql.createConnection({
      host: config.mysql.host,
      user: config.mysql.user,
      password: config.mysql.password,
      port: config.mysql.port,
    });
    await conn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\``,
    );
    await conn.end();
  }

  async _initSchema() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS resources (
        id          VARCHAR(36)  PRIMARY KEY,
        title       TEXT,
        description TEXT,
        filename    TEXT,
        owner_id    VARCHAR(20),
        created_at  DOUBLE,
        expires_at  DOUBLE NULL,
        message_id  VARCHAR(20),
        channel_id  VARCHAR(20),
        downloads   INT DEFAULT 0,
        direct_url  TEXT,
        category    VARCHAR(100) DEFAULT NULL
      )
    `);

    // Non-destructive migrations
    const [cols] = await this.pool.execute(
      `SHOW COLUMNS FROM resources LIKE 'direct_url'`,
    );
    if (cols.length === 0) {
      console.log("Migrating DB: adding direct_url column...");
      await this.pool.execute(
        `ALTER TABLE resources ADD COLUMN direct_url TEXT`,
      );
    }

    const [catCols] = await this.pool.execute(
      `SHOW COLUMNS FROM resources LIKE 'category'`,
    );
    if (catCols.length === 0) {
      console.log("Migrating DB: adding category column...");
      await this.pool.execute(
        `ALTER TABLE resources ADD COLUMN category VARCHAR(100) DEFAULT NULL`,
      );
    }
  }

  /**
   * Add a new resource. Returns the generated (or provided) UUID.
   */
  async addResource({
    id,
    title,
    description,
    filename,
    ownerId,
    messageId,
    channelId,
    expirationHours,
    directUrl,
    category,
  }) {
    const resourceId = id || uuidv4();
    let expiresAt = null;
    if (expirationHours && expirationHours > 0) {
      expiresAt = Date.now() / 1000 + expirationHours * 3600;
    }

    await this.pool.execute(
      `INSERT INTO resources
         (id, title, description, filename, owner_id, created_at, expires_at,
          message_id, channel_id, downloads, direct_url, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        resourceId,
        title,
        description,
        filename || "",
        String(ownerId),
        Date.now() / 1000,
        expiresAt,
        String(messageId),
        String(channelId),
        directUrl || "",
        category || null,
      ],
    );

    return resourceId;
  }

  async getResource(id) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM resources WHERE id = ?`,
      [id],
    );
    return rows[0] || null;
  }

  async getResourceByMessage(messageId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM resources WHERE message_id = ?`,
      [String(messageId)],
    );
    return rows[0] || null;
  }

  /**
   * Update arbitrary columns. Pass an object like { title: 'New', filename: 'x.zip' }.
   */
  async updateResource(id, updates) {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    const setClause = keys.map((k) => `\`${k}\` = ?`).join(", ");
    const values = [...Object.values(updates), id];

    await this.pool.execute(
      `UPDATE resources SET ${setClause} WHERE id = ?`,
      values,
    );
  }

  async deleteResource(id) {
    await this.pool.execute(`DELETE FROM resources WHERE id = ?`, [id]);
  }

  async getAllResources() {
    const [rows] = await this.pool.execute(`SELECT * FROM resources`);
    return rows;
  }

  async incrementDownloads(id) {
    await this.pool.execute(
      `UPDATE resources SET downloads = downloads + 1 WHERE id = ?`,
      [id],
    );
  }
}

const db = new Database();
module.exports = { db };
