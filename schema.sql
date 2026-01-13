-- Database Creation
CREATE DATABASE IF NOT EXISTS discord_file_bot;
USE discord_file_bot;

-- Table Structure for table `resources`
CREATE TABLE IF NOT EXISTS resources (
    id VARCHAR(36) PRIMARY KEY,
    title TEXT,
    description TEXT,
    filename TEXT,
    owner_id BIGINT,
    created_at DOUBLE,
    expires_at DOUBLE NULL,
    message_id BIGINT,
    channel_id BIGINT,
    downloads INT DEFAULT 0,
    direct_url TEXT
);
