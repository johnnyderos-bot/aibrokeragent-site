/**
 * Bootstrap script — create the first platform owner account.
 *
 * Usage:
 *   node scripts/create-platform-owner.js <email> <name> <password>
 *
 * Example:
 *   node scripts/create-platform-owner.js admin@example.com "Your Name" mypassword123
 */

require('dotenv').config();
const { initDb } = require('../src/db');
const { createUser, setPlatformRole } = require('../src/console-auth');

const [,, email, name, password] = process.argv;

if (!email || !name || !password) {
  console.error('Usage: node scripts/create-platform-owner.js <email> <name> <password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

try {
  initDb();
  const { getDb } = require('../src/db');
  const db = getDb();

  // Check if user already exists
  const existing = db.prepare('SELECT id, platform_role FROM console_users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    if (existing.platform_role === 'owner') {
      console.log(`User ${email} already exists as owner.`);
    } else {
      setPlatformRole(existing.id, 'owner');
      console.log(`Updated existing user ${email} to platform owner.`);
    }
    process.exit(0);
  }

  const { user_id } = createUser(email, name, password);
  setPlatformRole(user_id, 'owner');

  console.log(`\nPlatform owner created successfully!`);
  console.log(`  Email:    ${email}`);
  console.log(`  Name:     ${name}`);
  console.log(`  Role:     owner`);
  console.log(`  User ID:  ${user_id}`);
  console.log(`\nYou can now log in at /console-login.html`);
  console.log(`and invite others via POST /console/platform-invites\n`);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
