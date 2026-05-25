const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = path.join(__dirname, '..', 'vault.db');
let db;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_records (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id    TEXT NOT NULL,
      label       TEXT NOT NULL,
      encrypted_content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hcs_topic_id TEXT,
      hcs_sequence TEXT,
      hcs_timestamp TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vault_agent ON vault_records(agent_id);

    CREATE TABLE IF NOT EXISTS agents (
      agent_id      TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      api_key_hash  TEXT NOT NULL UNIQUE,
      credits       REAL NOT NULL DEFAULT 10.0,
      hedera_account TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS billing_ledger (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id    TEXT NOT NULL,
      type        TEXT NOT NULL,
      amount      REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      ref_id      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_agent ON billing_ledger(agent_id);
  `);

  // Librarian subscription plans
  db.exec(`
    CREATE TABLE IF NOT EXISTS librarian_subscriptions (
      agent_id      TEXT PRIMARY KEY,
      plan          TEXT NOT NULL DEFAULT 'none',
      active        INTEGER NOT NULL DEFAULT 0,
      activated_at  TEXT,
      expires_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations — safe to run repeatedly
  const agentCols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (!agentCols.includes('credits'))
    db.exec("ALTER TABLE agents ADD COLUMN credits REAL NOT NULL DEFAULT 10.0");
  if (!agentCols.includes('hedera_account'))
    db.exec("ALTER TABLE agents ADD COLUMN hedera_account TEXT");
  if (!agentCols.includes('hcs_topic_id'))
    db.exec("ALTER TABLE agents ADD COLUMN hcs_topic_id TEXT");

  const recordCols = db.prepare("PRAGMA table_info(vault_records)").all().map(c => c.name);
  if (!recordCols.includes('record_type'))
    db.exec("ALTER TABLE vault_records ADD COLUMN record_type TEXT DEFAULT 'context'");
  if (!recordCols.includes('shared_with_operator'))
    db.exec("ALTER TABLE vault_records ADD COLUMN shared_with_operator TEXT");
  if (!recordCols.includes('operator_acknowledged_at'))
    db.exec("ALTER TABLE vault_records ADD COLUMN operator_acknowledged_at TEXT");
  if (!recordCols.includes('content_type'))
    db.exec("ALTER TABLE vault_records ADD COLUMN content_type TEXT");
  if (!recordCols.includes('security_level'))
    db.exec("ALTER TABLE vault_records ADD COLUMN security_level TEXT");
  if (!recordCols.includes('retention_days'))
    db.exec("ALTER TABLE vault_records ADD COLUMN retention_days INTEGER");
  if (!recordCols.includes('expires_at'))
    db.exec("ALTER TABLE vault_records ADD COLUMN expires_at TEXT");
  if (!recordCols.includes('librarian_tags'))
    db.exec("ALTER TABLE vault_records ADD COLUMN librarian_tags TEXT");
  if (!recordCols.includes('librarian_classified_at'))
    db.exec("ALTER TABLE vault_records ADD COLUMN librarian_classified_at TEXT");
  if (!recordCols.includes('storage_backend'))
    db.exec("ALTER TABLE vault_records ADD COLUMN storage_backend TEXT DEFAULT 'sqlite'");
  if (!recordCols.includes('storage_ref'))
    db.exec("ALTER TABLE vault_records ADD COLUMN storage_ref TEXT");

  // Arbitration tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS arbitrators (
      agent_id              TEXT PRIMARY KEY,
      type                  TEXT NOT NULL DEFAULT 'ai',
      tier                  INTEGER NOT NULL DEFAULT 1,
      arbitrator_score      REAL NOT NULL DEFAULT 50.0,
      specializations       TEXT NOT NULL DEFAULT '[]',
      fee_per_dispute       REAL NOT NULL DEFAULT 5.0,
      total_rulings         INTEGER NOT NULL DEFAULT 0,
      appeal_rate           REAL NOT NULL DEFAULT 0.0,
      avg_resolution_hours  REAL NOT NULL DEFAULT 0.0,
      stake_hbar            REAL NOT NULL DEFAULT 0.0,
      kyc_verified          INTEGER NOT NULL DEFAULT 0,
      active                INTEGER NOT NULL DEFAULT 1,
      hcs_topic_id          TEXT,
      certified_at          TEXT NOT NULL DEFAULT (datetime('now')),
      last_ruling_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      contract_id           TEXT NOT NULL,
      filing_agent          TEXT NOT NULL,
      responding_agent      TEXT NOT NULL,
      arbitrator_id         TEXT,
      status                TEXT NOT NULL DEFAULT 'filed',
      dispute_value_hbar    REAL NOT NULL DEFAULT 0.0,
      human_escalated       INTEGER NOT NULL DEFAULT 0,
      ai_confidence         REAL,
      ai_flags              TEXT NOT NULL DEFAULT '[]',
      ai_analysis           TEXT,
      grievance             TEXT NOT NULL,
      filed_at              TEXT NOT NULL DEFAULT (datetime('now')),
      response_deadline     TEXT,
      sla_deadline          TEXT,
      resolved_at           TEXT,
      hcs_topic_id          TEXT,
      hcs_sequence          TEXT,
      appeal_deadline       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_disputes_filing   ON disputes(filing_agent);
    CREATE INDEX IF NOT EXISTS idx_disputes_responding ON disputes(responding_agent);
    CREATE INDEX IF NOT EXISTS idx_disputes_arbitrator ON disputes(arbitrator_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_status    ON disputes(status);

    CREATE TABLE IF NOT EXISTS arbitration_evidence (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      dispute_id      TEXT NOT NULL,
      submitted_by    TEXT NOT NULL,
      vault_record_id TEXT,
      description     TEXT NOT NULL,
      submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (dispute_id) REFERENCES disputes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON arbitration_evidence(dispute_id);

    CREATE TABLE IF NOT EXISTS arbitration_rulings (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      dispute_id      TEXT NOT NULL UNIQUE,
      arbitrator_id   TEXT NOT NULL,
      liable_party    TEXT NOT NULL,
      remedy_type     TEXT NOT NULL,
      remedy_amount   REAL NOT NULL DEFAULT 0.0,
      rationale       TEXT NOT NULL,
      rationale_hash  TEXT NOT NULL,
      flags           TEXT NOT NULL DEFAULT '[]',
      hcs_topic_id    TEXT,
      hcs_sequence    TEXT,
      issued_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (dispute_id) REFERENCES disputes(id)
    );

    CREATE TABLE IF NOT EXISTS appeals (
      id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      dispute_id            TEXT NOT NULL,
      appellant_id          TEXT NOT NULL,
      senior_arbitrator_id  TEXT,
      grounds               TEXT NOT NULL,
      outcome               TEXT,
      fee_paid              REAL NOT NULL DEFAULT 0.0,
      filed_at              TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at           TEXT,
      FOREIGN KEY (dispute_id) REFERENCES disputes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_appeals_dispute ON appeals(dispute_id);
  `);

  // Operator accounts — humans who own/operate agents
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      operator_id   TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT,
      api_key_hash  TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS operator_agents (
      operator_id   TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      linked_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (operator_id, agent_id),
      FOREIGN KEY (operator_id) REFERENCES operators(operator_id),
      FOREIGN KEY (agent_id)    REFERENCES agents(agent_id)
    );
  `);

  // Operator column migrations (entity, type fields added for operator portal)
  const opCols = db.prepare("PRAGMA table_info(operators)").all().map(c => c.name);
  if (!opCols.includes('entity'))
    db.exec("ALTER TABLE operators ADD COLUMN entity TEXT");
  if (!opCols.includes('operator_type'))
    db.exec("ALTER TABLE operators ADD COLUMN operator_type TEXT DEFAULT 'founder'");

  // Flash state column on operator_agents (private/flash/public)
  const oaCols = db.prepare("PRAGMA table_info(operator_agents)").all().map(c => c.name);
  if (!oaCols.includes('flash_state'))
    db.exec("ALTER TABLE operator_agents ADD COLUMN flash_state TEXT NOT NULL DEFAULT 'flash'");

  // Flash rules — per-agent automated consent policy set by operator
  db.exec(`
    CREATE TABLE IF NOT EXISTS flash_rules (
      agent_id    TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      rules       TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, operator_id)
    );
  `);

  // Flash events — operator-initiated credential disclosure events
  db.exec(`
    CREATE TABLE IF NOT EXISTS flash_events (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      operator_id     TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      recipient       TEXT NOT NULL,
      scope           TEXT NOT NULL DEFAULT 'trust_score',
      flash_event_id  TEXT NOT NULL,
      hcs_sequence    TEXT,
      payload         TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (operator_id) REFERENCES operators(operator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_flash_operator ON flash_events(operator_id);
    CREATE INDEX IF NOT EXISTS idx_flash_agent    ON flash_events(agent_id);
  `);

  // Code attestation — agents register their model/code identity
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_attestations (
      id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id            TEXT NOT NULL,
      model_version       TEXT,
      system_prompt_hash  TEXT,
      code_hash           TEXT,
      operator_id         TEXT,
      hcs_topic_id        TEXT,
      hcs_sequence        TEXT,
      attested_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attestations_agent ON agent_attestations(agent_id);
  `);

  // Contract Audit tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_contracts (
      id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title                   TEXT NOT NULL,
      buyer_agent             TEXT NOT NULL,
      seller_agent            TEXT NOT NULL,
      arbitrator_id           TEXT,
      total_amount_hbar       REAL NOT NULL DEFAULT 0.0,
      terms                   TEXT NOT NULL,
      terms_hash              TEXT NOT NULL,
      audit_status            TEXT NOT NULL DEFAULT 'SUBMITTED',
      hook_address            TEXT,
      hook_type               TEXT,
      audit_certificate_hash  TEXT,
      hcs_sequence            TEXT,
      buyer_confirmed         INTEGER NOT NULL DEFAULT 0,
      seller_confirmed        INTEGER NOT NULL DEFAULT 0,
      cancel_requested_by     TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      hook_attached_at        TEXT,
      completed_at            TEXT,
      cancelled_at            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_buyer  ON audit_contracts(buyer_agent);
    CREATE INDEX IF NOT EXISTS idx_audit_seller ON audit_contracts(seller_agent);
    CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_contracts(audit_status);

    CREATE TABLE IF NOT EXISTS audit_findings (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      contract_id     TEXT NOT NULL,
      severity        TEXT NOT NULL,
      category        TEXT NOT NULL,
      finding         TEXT NOT NULL,
      suggestion      TEXT,
      resolved        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES audit_contracts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_findings_contract ON audit_findings(contract_id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      contract_id     TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      actor_agent_id  TEXT,
      note            TEXT,
      hcs_sequence    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contract_id) REFERENCES audit_contracts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_contract ON audit_events(contract_id);
  `);

  // KYC verifications — operator identity attestations
  db.exec(`
    CREATE TABLE IF NOT EXISTS kyc_verifications (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      operator_id       TEXT NOT NULL,
      provider          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      level             TEXT NOT NULL DEFAULT 'basic',
      applicant_id      TEXT,
      verification_hash TEXT,
      rejection_reason  TEXT,
      pep_flag          INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at       TEXT,
      expires_at        TEXT,
      FOREIGN KEY (operator_id) REFERENCES operators(operator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_operator ON kyc_verifications(operator_id);
  `);

  // SAR (Suspicious Activity Report) queue — AML monitoring
  db.exec(`
    CREATE TABLE IF NOT EXISTS sar_queue (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id         TEXT NOT NULL,
      reason           TEXT NOT NULL,
      details          TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'pending',
      resolution_notes TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sar_agent  ON sar_queue(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sar_status ON sar_queue(status);
  `);

  // Travel Rule logs — mandatory originator/beneficiary data for qualifying transfers
  db.exec(`
    CREATE TABLE IF NOT EXISTS travel_rule_logs (
      id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      originator_agent_id TEXT NOT NULL,
      beneficiary_agent_id TEXT NOT NULL,
      originator_vasp_id  TEXT NOT NULL DEFAULT 'brokeragent',
      beneficiary_vasp_id TEXT,
      amount_credits      REAL NOT NULL,
      hedera_transaction_id TEXT,
      contract_id         TEXT,
      originator_name     TEXT,
      beneficiary_name    TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_travel_rule_orig ON travel_rule_logs(originator_agent_id);
    CREATE INDEX IF NOT EXISTS idx_travel_rule_bene ON travel_rule_logs(beneficiary_agent_id);
  `);

  // Operator KYC status denorm — fast gate check without joining kyc_verifications
  const operatorCols = db.prepare("PRAGMA table_info(operators)").all().map(c => c.name);
  if (!operatorCols.includes('kyc_status'))
    db.exec("ALTER TABLE operators ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'unverified'");
  if (!operatorCols.includes('kyc_level'))
    db.exec("ALTER TABLE operators ADD COLUMN kyc_level TEXT");

  // KYC verifications — add richer provider fields
  const kycCols = db.prepare("PRAGMA table_info(kyc_verifications)").all().map(c => c.name);
  if (!kycCols.includes('risk_score'))
    db.exec("ALTER TABLE kyc_verifications ADD COLUMN risk_score REAL");
  if (!kycCols.includes('sanctions_check'))
    db.exec("ALTER TABLE kyc_verifications ADD COLUMN sanctions_check TEXT");
  if (!kycCols.includes('verification_type'))
    db.exec("ALTER TABLE kyc_verifications ADD COLUMN verification_type TEXT");

  // Agents — compliance fields
  const agentCols2 = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (!agentCols2.includes('risk_rating'))
    db.exec("ALTER TABLE agents ADD COLUMN risk_rating REAL");
  if (!agentCols2.includes('last_screened_at'))
    db.exec("ALTER TABLE agents ADD COLUMN last_screened_at TEXT");
  if (!agentCols2.includes('attestation_hcs_id'))
    db.exec("ALTER TABLE agents ADD COLUMN attestation_hcs_id TEXT");
  if (!agentCols2.includes('agent_type'))
    db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'general'");
  if (!agentCols2.includes('has_boost'))
    db.exec("ALTER TABLE agents ADD COLUMN has_boost INTEGER NOT NULL DEFAULT 0");
  if (!agentCols2.includes('capabilities'))
    db.exec("ALTER TABLE agents ADD COLUMN capabilities TEXT");

  // Top-up transaction log — prevents replay attacks
  db.exec(`
    CREATE TABLE IF NOT EXISTS topup_transactions (
      transaction_id  TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      hbar_amount     REAL NOT NULL,
      credits_added   REAL NOT NULL,
      verified_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Agent version registry — platform registers known model/skill versions with a status.
  // Agents with deprecated or flagged attested versions receive reduced IAQ scores.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_version_registry (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      model_version TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL DEFAULT 'current',
      flagged_reason TEXT,
      effective_date TEXT NOT NULL DEFAULT (date('now')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_version_registry_model ON agent_version_registry(model_version);
  `);

  // EigenTrust vouching table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_vouches (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      voucher_id  TEXT NOT NULL,
      vouchee_id  TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(voucher_id, vouchee_id),
      FOREIGN KEY (voucher_id) REFERENCES agents(agent_id),
      FOREIGN KEY (vouchee_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vouches_vouchee ON agent_vouches(vouchee_id);
  `);

  // Arbitration migrations — safe to run repeatedly
  const arbitratorCols = db.prepare("PRAGMA table_info(arbitrators)").all().map(c => c.name);
  if (!arbitratorCols.includes('type'))
    db.exec("ALTER TABLE arbitrators ADD COLUMN type TEXT NOT NULL DEFAULT 'ai'");
  if (!arbitratorCols.includes('stake_hbar'))
    db.exec("ALTER TABLE arbitrators ADD COLUMN stake_hbar REAL NOT NULL DEFAULT 0.0");
  if (!arbitratorCols.includes('kyc_verified'))
    db.exec("ALTER TABLE arbitrators ADD COLUMN kyc_verified INTEGER NOT NULL DEFAULT 0");
  if (!arbitratorCols.includes('sla_misses'))
    db.exec("ALTER TABLE arbitrators ADD COLUMN sla_misses INTEGER NOT NULL DEFAULT 0");

  const disputeCols = db.prepare("PRAGMA table_info(disputes)").all().map(c => c.name);
  if (!disputeCols.includes('human_escalated'))
    db.exec("ALTER TABLE disputes ADD COLUMN human_escalated INTEGER NOT NULL DEFAULT 0");
  if (!disputeCols.includes('ai_confidence'))
    db.exec("ALTER TABLE disputes ADD COLUMN ai_confidence REAL");
  if (!disputeCols.includes('ai_flags'))
    db.exec("ALTER TABLE disputes ADD COLUMN ai_flags TEXT NOT NULL DEFAULT '[]'");
  if (!disputeCols.includes('ai_analysis'))
    db.exec("ALTER TABLE disputes ADD COLUMN ai_analysis TEXT");
  if (!disputeCols.includes('reassignment_count'))
    db.exec("ALTER TABLE disputes ADD COLUMN reassignment_count INTEGER NOT NULL DEFAULT 0");
  if (!disputeCols.includes('original_arbitrator_id'))
    db.exec("ALTER TABLE disputes ADD COLUMN original_arbitrator_id TEXT");

  // ── Human Trust Console tables ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_orgs (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS console_users (
      id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      org_id              TEXT,
      email               TEXT NOT NULL UNIQUE,
      name                TEXT NOT NULL,
      password_hash       TEXT NOT NULL,
      session_token       TEXT,
      session_expires_at  TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_console_users_email ON console_users(email);
    CREATE INDEX IF NOT EXISTS idx_console_users_session ON console_users(session_token);

    CREATE TABLE IF NOT EXISTS console_agent_access (
      user_id     TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'viewer',
      granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_console_access_agent ON console_agent_access(agent_id);
    CREATE INDEX IF NOT EXISTS idx_console_access_user  ON console_agent_access(user_id);

    CREATE TABLE IF NOT EXISTS console_invites (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      email             TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'viewer',
      invited_by_user_id TEXT NOT NULL,
      expires_at        TEXT NOT NULL,
      used_at           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_console_invites_agent ON console_invites(agent_id);

    CREATE TABLE IF NOT EXISTS agent_limits (
      agent_id                    TEXT PRIMARY KEY,
      max_contract_value_hbar     REAL,
      min_counterparty_score      INTEGER,
      require_approval_above_hbar REAL,
      hold                        INTEGER NOT NULL DEFAULT 0,
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_notifications (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id    TEXT NOT NULL,
      type        TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'info',
      title       TEXT NOT NULL,
      message     TEXT NOT NULL,
      contract_id TEXT,
      read        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_agent  ON agent_notifications(agent_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON agent_notifications(agent_id, read);
  `);

  // Vault artifact columns on audit_contracts
  const auditContractCols = db.prepare("PRAGMA table_info(audit_contracts)").all().map(c => c.name);
  if (!auditContractCols.includes('pre_audit_vault_record_id'))
    db.exec("ALTER TABLE audit_contracts ADD COLUMN pre_audit_vault_record_id TEXT");
  if (!auditContractCols.includes('pre_audit_hcs_sequence'))
    db.exec("ALTER TABLE audit_contracts ADD COLUMN pre_audit_hcs_sequence TEXT");
  if (!auditContractCols.includes('post_settlement_vault_record_id'))
    db.exec("ALTER TABLE audit_contracts ADD COLUMN post_settlement_vault_record_id TEXT");
  if (!auditContractCols.includes('post_settlement_hcs_sequence'))
    db.exec("ALTER TABLE audit_contracts ADD COLUMN post_settlement_hcs_sequence TEXT");

  // Platform-level user roles (owner / employee / watcher)
  const consoleUserCols = db.prepare("PRAGMA table_info(console_users)").all().map(c => c.name);
  if (!consoleUserCols.includes('platform_role'))
    db.exec("ALTER TABLE console_users ADD COLUMN platform_role TEXT DEFAULT NULL");
  if (!consoleUserCols.includes('active'))
    db.exec("ALTER TABLE console_users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  if (!consoleUserCols.includes('deactivated_at'))
    db.exec("ALTER TABLE console_users ADD COLUMN deactivated_at TEXT DEFAULT NULL");

  // Platform invites — not scoped to a specific agent
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_platform_invites (
      id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      email               TEXT NOT NULL,
      platform_role       TEXT NOT NULL DEFAULT 'watcher',
      invited_by_user_id  TEXT NOT NULL,
      expires_at          TEXT NOT NULL,
      used_at             TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_invites_email ON console_platform_invites(email);
  `);

  // Waitlist — pre-launch signups
  db.exec(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      email         TEXT NOT NULL UNIQUE,
      name          TEXT,
      tier_interest TEXT NOT NULL DEFAULT 'free',
      use_case      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
  `);

  // Subscriptions — operator billing plan
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      operator_id          TEXT NOT NULL UNIQUE,
      plan                 TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id   TEXT,
      stripe_subscription_id TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      current_period_start TEXT,
      current_period_end   TEXT,
      annual               INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (operator_id) REFERENCES operators(operator_id)
    );
  `);

  // Usage events — per-protocol metering
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      operator_id TEXT,
      agent_id    TEXT,
      protocol    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      quantity    REAL NOT NULL DEFAULT 1,
      value_usd   REAL,
      period_key  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_operator ON usage_events(operator_id, protocol, period_key);
    CREATE INDEX IF NOT EXISTS idx_usage_agent    ON usage_events(agent_id, protocol, period_key);
  `);

  // Add stripe columns to operators if not present
  const opColsFull = db.prepare("PRAGMA table_info(operators)").all().map(c => c.name);
  if (!opColsFull.includes('stripe_customer_id'))
    db.exec("ALTER TABLE operators ADD COLUMN stripe_customer_id TEXT");
  if (!opColsFull.includes('plan'))
    db.exec("ALTER TABLE operators ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");

  // Arena — tutorial sessions, game sessions, score bonuses, badges
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_tutorial_sessions (
      session_id    TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      session_token TEXT NOT NULL,
      step          INTEGER NOT NULL DEFAULT 1,
      completed     INTEGER NOT NULL DEFAULT 0,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      hcs_sequence  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_arena_tut_agent ON arena_tutorial_sessions(agent_id);

    CREATE TABLE IF NOT EXISTS arena_game_sessions (
      session_id    TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      game          TEXT NOT NULL DEFAULT 'trust_hunt',
      session_token TEXT NOT NULL,
      step_payloads TEXT NOT NULL DEFAULT '[]',
      step_attempts TEXT NOT NULL DEFAULT '{}',
      current_step  INTEGER NOT NULL DEFAULT 1,
      steps_done    INTEGER NOT NULL DEFAULT 0,
      total_retries INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      completed_at  TEXT,
      hcs_sequence  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_arena_game_agent ON arena_game_sessions(agent_id, game);

    CREATE TABLE IF NOT EXISTS arena_score_bonuses (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id   TEXT NOT NULL,
      dimension  TEXT NOT NULL,
      bonus_pts  REAL NOT NULL,
      source     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arena_bonus_agent ON arena_score_bonuses(agent_id);

    CREATE TABLE IF NOT EXISTS arena_badges (
      agent_id   TEXT NOT NULL,
      badge      TEXT NOT NULL,
      earned_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, badge)
    );
    CREATE INDEX IF NOT EXISTS idx_arena_badges_agent ON arena_badges(agent_id);
  `);

  // IdleAgent.ai marketplace tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_listings (
      id                   TEXT PRIMARY KEY,
      agent_id             TEXT NOT NULL,
      operator_id          TEXT NOT NULL,
      skill_category       TEXT NOT NULL,
      skill_name           TEXT NOT NULL,
      skill_description    TEXT,
      price_per_call       REAL,
      price_per_hour       REAL,
      min_counterparty_score INTEGER NOT NULL DEFAULT 0,
      min_counterparty_tier TEXT NOT NULL DEFAULT 'Bronze',
      is_active            INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skill_listings_agent    ON skill_listings(agent_id);
    CREATE INDEX IF NOT EXISTS idx_skill_listings_category ON skill_listings(skill_category);
    CREATE INDEX IF NOT EXISTS idx_skill_listings_active   ON skill_listings(is_active);

    CREATE TABLE IF NOT EXISTS idle_policies (
      id                     TEXT PRIMARY KEY,
      agent_id               TEXT NOT NULL UNIQUE,
      operator_id            TEXT NOT NULL,
      auto_list_when_idle    INTEGER NOT NULL DEFAULT 0,
      idle_threshold_minutes INTEGER NOT NULL DEFAULT 15,
      max_concurrent_jobs    INTEGER NOT NULL DEFAULT 3,
      governance_constraints TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS marketplace_transactions (
      id              TEXT PRIMARY KEY,
      listing_id      TEXT NOT NULL,
      selling_agent_id TEXT NOT NULL,
      hiring_agent_id  TEXT NOT NULL,
      aicp_contract_id TEXT,
      acp_record_id    TEXT,
      skill_name       TEXT NOT NULL,
      price            REAL NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      started_at       TEXT,
      completed_at     TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mtx_selling ON marketplace_transactions(selling_agent_id);
    CREATE INDEX IF NOT EXISTS idx_mtx_hiring  ON marketplace_transactions(hiring_agent_id);
  `);

  // MCP server registry — tool providers that want AATS trust scores
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      description   TEXT,
      registered_by TEXT,
      capabilities  TEXT,
      tools_count   INTEGER NOT NULL DEFAULT 0,
      aats_score    REAL,
      verified      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_url  ON mcp_servers(url);

    CREATE TABLE IF NOT EXISTS aicp_evaluations (
      id              TEXT PRIMARY KEY,
      protocol        TEXT NOT NULL,
      delegating_agent TEXT,
      target_agent    TEXT,
      evaluation_result TEXT NOT NULL,
      trust_passed    INTEGER NOT NULL DEFAULT 0,
      score_at_eval   REAL,
      tier_at_eval    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_aicp_eval_protocol ON aicp_evaluations(protocol);
    CREATE INDEX IF NOT EXISTS idx_aicp_eval_agent    ON aicp_evaluations(delegating_agent);
  `);

  console.log('DB initialized:', DB_PATH);
}

module.exports = { getDb, initDb };
