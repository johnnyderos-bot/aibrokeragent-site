/**
 * Storage Backend — BrokerAGEnt Vault
 *
 * Abstracts where encrypted vault blobs are stored.
 * Controlled by VAULT_STORAGE_BACKEND env var.
 *
 *   sqlite  (default) — blob stored inline in vault_records.encrypted_content
 *                       No extra dependencies. Used for alpha.
 *
 *   storj             — blob uploaded to Storj S3-compatible gateway.
 *                       DB stores a storage_ref pointer instead of the blob.
 *                       Used for closed beta+.
 *                       Requires: @aws-sdk/client-s3
 *                       Env vars:  STORJ_ENDPOINT, STORJ_ACCESS_KEY, STORJ_SECRET_KEY, STORJ_BUCKET
 *
 * Both backends are fully transparent to vault.js — same put/get/del interface.
 * SQLite records and Storj records can coexist in the same DB (migration-safe).
 */

// ── SQLite backend ────────────────────────────────────────────────────────────
// Blob is stored inline — vault.js handles the actual DB column directly.
// put() and get() are no-ops; vault.js reads encrypted_content from the row.
class SQLiteBackend {
  get name() { return 'sqlite'; }

  // Returns null ref — vault.js will write blob to encrypted_content column
  async put(_key, _data) {
    return { ref: null };
  }

  // Returns null — vault.js reads from encrypted_content column directly
  async get(_ref) {
    return null;
  }

  async del(_ref) {}
}

// ── Storj backend ─────────────────────────────────────────────────────────────
// Blob is uploaded to Storj via S3-compatible gateway.
// DB stores a `storj://<bucket>/<key>` reference string.
// Requires @aws-sdk/client-s3 — add to package.json when activating for beta.
class StorjBackend {
  constructor() {
    const { S3Client } = require('@aws-sdk/client-s3');
    this._S3Client = S3Client;
    this.client = new S3Client({
      endpoint:    process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io',
      region:      'us-east-1', // Storj ignores region but SDK requires it
      credentials: {
        accessKeyId:     process.env.STORJ_ACCESS_KEY,
        secretAccessKey: process.env.STORJ_SECRET_KEY,
      },
      forcePathStyle: true,
    });
    this.bucket = process.env.STORJ_BUCKET || 'brokeragent-vault';
  }

  get name() { return 'storj'; }

  /**
   * Upload encrypted blob to Storj.
   * @param {string} key  — object key, e.g. "{agent_id}/{record_id}"
   * @param {string} data — encrypted content string (hex-encoded ciphertext)
   * @returns {{ ref: string }} — storage reference stored in DB
   */
  async put(key, data) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      Body:        Buffer.from(data, 'utf8'),
      ContentType: 'application/octet-stream',
    }));
    return { ref: `storj://${this.bucket}/${key}` };
  }

  /**
   * Download encrypted blob from Storj.
   * @param {string} ref — storage_ref from DB (e.g. "storj://brokeragent-vault/agent_id/record_id")
   * @returns {string} — encrypted content string
   */
  async get(ref) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = ref.replace(`storj://${this.bucket}/`, '');
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key:    key,
    }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Delete blob from Storj (e.g. on record expiry or agent deletion).
   * @param {string} ref — storage_ref from DB
   */
  async del(ref) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const key = ref.replace(`storj://${this.bucket}/`, '');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _backend = null;

function getBackend() {
  if (_backend) return _backend;
  const name = (process.env.VAULT_STORAGE_BACKEND || 'sqlite').toLowerCase();
  if (name === 'storj') {
    _backend = new StorjBackend();
    console.log('[storage-backend] Using Storj S3 backend');
  } else {
    _backend = new SQLiteBackend();
    if (name !== 'sqlite') {
      console.warn(`[storage-backend] Unknown backend "${name}", falling back to sqlite`);
    }
  }
  return _backend;
}

module.exports = { getBackend };
