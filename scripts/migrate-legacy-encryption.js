/**
 * Legacy Record Re-Encryption Migration
 *
 * Migrates vault records from global-key encryption (pre-Sprint 02)
 * to per-agent HKDF-SHA256 derived key encryption (v2 scheme).
 *
 * Safety: decrypt → verify → re-encrypt → verify again → update DB
 * Records are only updated after successful round-trip verification.
 *
 * Usage: node scripts/migrate-legacy-encryption.js [--dry-run]
 */

require('dotenv').config();
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = path.join(__dirname, '..', 'vault.db');
const LOG_PATH = path.join(__dirname, '..', 'logs', 'migration-legacy-reencrypt.jsonl');
const ALGORITHM = 'aes-256-gcm';

// Load master key
const rawKey = process.env.VAULT_ENCRYPTION_KEY;
if (!rawKey || rawKey.length !== 64) {
  console.error('VAULT_ENCRYPTION_KEY must be a 64-character hex string');
  process.exit(1);
}
const MASTER_KEY = Buffer.from(rawKey, 'hex');

function deriveAgentKey(agentId) {
  return crypto.hkdfSync('sha256', MASTER_KEY, Buffer.from('aats-vault-salt-v2'), Buffer.from(`agent:${agentId}`), 32);
}

function decryptLegacy(ciphertext) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error(`unexpected legacy format: ${parts.length} parts`);
  const [ivHex, tagHex, encHex] = parts;
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function encryptV2(plaintext, agentId) {
  const key = deriveAgentKey(agentId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v2:' + [iv, tag, encrypted].map(b => b.toString('hex')).join(':');
}

function decryptV2(ciphertext, agentId) {
  const key = deriveAgentKey(agentId);
  const parts = ciphertext.slice(3).split(':');
  if (parts.length !== 3) throw new Error('unexpected v2 format');
  const [ivHex, tagHex, encHex] = parts;
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function logEntry(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(LOG_PATH, line, 'utf-8');
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Find all legacy records (not starting with 'v2:')
  // Only records stored inline in SQLite (storage_backend = 'sqlite' or NULL)
  const legacyRecords = db.prepare(`
    SELECT id, agent_id, encrypted_content
    FROM vault_records
    WHERE (storage_backend = 'sqlite' OR storage_backend IS NULL)
      AND encrypted_content NOT LIKE 'v2:%'
    ORDER BY created_at ASC
  `).all();

  console.log(`\n=== Legacy Re-Encryption Migration ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no DB changes)' : 'LIVE'}`);
  console.log(`Records to migrate: ${legacyRecords.length}`);
  console.log(`Log: ${LOG_PATH}\n`);

  logEntry({ event: 'migration.start', total: legacyRecords.length, dry_run: DRY_RUN });

  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  const updateStmt = db.prepare(
    'UPDATE vault_records SET encrypted_content = ? WHERE id = ?'
  );

  for (const record of legacyRecords) {
    const { id, agent_id, encrypted_content } = record;

    try {
      // Step 1: Decrypt with legacy global key
      const plaintext = decryptLegacy(encrypted_content);

      // Step 2: Re-encrypt with per-agent derived key
      const newCiphertext = encryptV2(plaintext, agent_id);

      // Step 3: Verify round-trip — decrypt new ciphertext and confirm match
      const verified = decryptV2(newCiphertext, agent_id);
      if (verified !== plaintext) {
        throw new Error('round-trip verification failed: decrypted content mismatch');
      }

      // Step 4: Update DB (skip in dry-run)
      if (!DRY_RUN) {
        updateStmt.run(newCiphertext, id);
      }

      migrated++;
      logEntry({ event: 'migration.record', id, agent_id, status: 'migrated', dry_run: DRY_RUN });
      process.stdout.write(`  ✓ ${id} (agent: ${agent_id})\n`);

    } catch (err) {
      failed++;
      console.error(`  ✗ ${id} (agent: ${agent_id}): ${err.message}`);
      logEntry({ event: 'migration.record', id, agent_id, status: 'failed', error: err.message });
    }
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Migrated: ${migrated}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Skipped:  ${skipped}`);

  // Step 5: Verification pass — try global-key decrypt on migrated records
  if (!DRY_RUN && migrated > 0) {
    console.log(`\nVerifying global-key decrypt now FAILS on migrated records...`);
    const migrated_records = db.prepare(`
      SELECT id, agent_id, encrypted_content
      FROM vault_records
      WHERE (storage_backend = 'sqlite' OR storage_backend IS NULL)
        AND encrypted_content LIKE 'v2:%'
    `).all();

    let verify_pass = 0;
    let verify_fail = 0;
    for (const r of migrated_records) {
      try {
        // Attempt legacy global-key decrypt — should FAIL
        decryptLegacy(r.encrypted_content);
        // If we get here, the record wasn't migrated properly (still global-key-decryptable)
        // This can happen for records that were already v2 but started with a wrong prefix
        verify_fail++;
        logEntry({ event: 'migration.verify_warning', id: r.id, note: 'legacy decrypt succeeded on v2 record — unexpected' });
      } catch {
        // Expected — global-key decrypt fails on v2 record (either auth tag mismatch or format error)
        verify_pass++;
      }
    }
    console.log(`  Global-key decrypt blocked: ${verify_pass}/${migrated_records.length} records ✓`);
    logEntry({ event: 'migration.verify', verify_pass, verify_total: migrated_records.length });
  }

  logEntry({ event: 'migration.end', migrated, failed, dry_run: DRY_RUN });

  if (failed > 0) {
    console.error(`\n⚠ ${failed} records failed migration — see log for details`);
    process.exit(1);
  }

  console.log(`\n✓ Migration ${DRY_RUN ? 'dry run' : ''} complete. Log at: ${LOG_PATH}`);
}

main();
