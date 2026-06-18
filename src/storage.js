const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ARCHIVE_EXTS = ['.zip', '.rar', '.7z', '.tar', '.gz'];

// ─── URL Generation ───────────────────────────────────────────────────────────

/**
 * Generate a download URL for a file.
 * If IIS_SECURE_SECRET is set, produces an HMAC-signed URL.
 * Otherwise returns a plain direct link.
 */
function generateUrl(filename, expiration = config.linkExpirationSeconds) {
  if (!filename) {
    console.error('[storage] generateUrl called with empty filename');
    return null;
  }

  if (!config.iis.baseUrl) {
    console.error('IIS_BASE_URL is not configured.');
    return null;
  }

  const safeFilename = encodeURIComponent(filename)
    .replace(/%2F/g, '/')
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']');

  if (!config.iis.secureSecret) {
    return `${config.iis.baseUrl}/${safeFilename}`;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + expiration;
  const dataToSign = `${filename}${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', config.iis.secureSecret)
    .update(dataToSign)
    .digest('hex');

  return `${config.iis.baseUrl}/${safeFilename}?expires=${expiresAt}&signature=${signature}`;
}

// ─── Local File Helpers ───────────────────────────────────────────────────────

function _basePath() {
  const p = config.iis.localFilePath;
  return p ? path.normalize(p.endsWith(path.sep) ? p : p + path.sep) : null;
}

/**
 * Check whether a file exists locally (preferred) or via a HEAD request.
 */
function checkFileExists(filename) {
  const base = _basePath();
  if (base) {
    const full = path.join(base, filename);
    console.debug(`[storage] checking: ${full}`);
    return fs.existsSync(full);
  }
  return false;
}

/**
 * Return human-readable file size, or "Unknown" if not found.
 */
function getFileSize(filename) {
  if (!filename) return 'Unknown';
  const base = _basePath();
  if (!base) return 'Unknown';

  const full = path.normalize(path.join(base, filename));
  try {
    if (!fs.existsSync(full)) return 'Unknown';
    const bytes = fs.statSync(full).size;
    return _formatSize(bytes);
  } catch {
    return 'Unknown';
  }
}

function _formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// ─── Smart Path Resolution ────────────────────────────────────────────────────

/**
 * Try to resolve a filename/relative path to its actual location.
 *
 * Resolution order:
 *  1. Exact path directly under LOCAL_FILE_PATH
 *  2. Strip brackets → look for a folder by that clean name
 *     a. Exact filename inside folder
 *     b. Clean name + original extension inside folder
 *     c. Only archive file inside folder
 *  3. Recursive search across all subdirectories
 *
 * Returns the resolved relative path (forward slashes) or the original input.
 */
function resolveFilePath(filename) {
  if (!filename) return filename;

  const base = _basePath();
  if (!base) return filename;

  console.debug(`[storage] resolving '${filename}' in '${base}'`);

  // 1. Direct hit
  if (fs.existsSync(path.join(base, filename))) {
    console.debug('[storage] resolved: direct match');
    return filename;
  }

  // 2. Bracket-strip heuristic
  const ext = path.extname(filename).toLowerCase();
  const nameNoExt = path.basename(filename, ext);
  const cleanName = nameNoExt.replace(/^\[|\]$/g, '');

  for (const folderName of [cleanName, nameNoExt]) {
    const folderPath = path.join(base, folderName);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;

    console.debug(`[storage] found folder: ${folderName}`);

    // a/b – try common filename variations inside the folder
    for (const candidate of [
      filename,
      `${cleanName}${ext}`,
      `[${cleanName}]${ext}`,
    ]) {
      const full = path.join(folderPath, candidate);
      if (fs.existsSync(full)) {
        const rel = path.join(folderName, candidate).replace(/\\/g, '/');
        console.debug(`[storage] resolved: ${rel}`);
        return rel;
      }
    }

    // c – any single archive file in the folder
    try {
      const files = fs.readdirSync(folderPath);
      const archives = files.filter((f) =>
        ARCHIVE_EXTS.includes(path.extname(f).toLowerCase())
      );
      const filtered = ext ? archives.filter((f) => f.toLowerCase().endsWith(ext)) : archives;

      if (filtered.length === 1) {
        const rel = path.join(folderName, filtered[0]).replace(/\\/g, '/');
        console.debug(`[storage] resolved (smart archive match): ${rel}`);
        return rel;
      }
      if (filtered.length > 1) {
        console.debug('[storage] multiple archives found; cannot auto-select');
      }
    } catch {
      // ignore readdir errors
    }
  }

  // 3. Recursive search
  console.debug(`[storage] starting recursive search for '${filename}'`);
  const found = _walkFind(base, path.basename(filename));
  if (found) {
    const rel = path.relative(base, found).replace(/\\/g, '/');
    console.debug(`[storage] resolved (recursive): ${rel}`);
    return rel;
  }

  console.debug('[storage] could not resolve path');
  return filename;
}

function _walkFind(dir, target) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = _walkFind(full, target);
      if (result) return result;
    } else if (entry.name === target) {
      return full;
    }
  }
  return null;
}

module.exports = { generateUrl, checkFileExists, getFileSize, resolveFilePath };
