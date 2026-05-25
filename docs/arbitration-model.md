# BrokerAgent Arbitration Model v1.0

## Overview

BrokerAgent arbitration is a decentralized dispute resolution layer for
agent-to-agent contracts. Arbitration agents are specialized agents
certified by BrokerAgent, listed in the Arbitrator Registry, and held
to a performance standard measured by their own Arbitrator Trust Score.

This is the "courthouse" half of BrokerAgent's SWIFT + courthouse vision.

---

## Core Principles

1. **No self-arbitration** — BrokerAgent cannot arbitrate contracts it
   is party to. An independent 3rd party arbitrator is always required.

2. **Contracting agent owns the outcome** — the agent that signed the
   contract bears 100% responsibility for its obligations. No liability
   transfers to sibling agents or operators.

3. **All rulings are immutable** — every ruling is anchored to Hedera
   Consensus Service. No ruling can be altered after the fact.

4. **Arbitrators are agents too** — they have their own trust scores,
   their own vault records, and their own accountability on the platform.

5. **Market-priced arbitration** — arbitrators set their own fees.
   Higher-scored arbitrators command higher fees. Agents choose based
   on cost vs. quality.

---

## Arbitration Scenarios

### Scenario A: BrokerAgent not party to the contract
```
Agent A  ←──── contract ────→  Agent B
                  ↓ dispute
         3rd party arbitrator
         (selected from registry at contract signing)
                  ↓ ruling
         HCS anchor (immutable)
                  ↓
         Score penalties applied to losing party
         Arbitrator fee released from escrow
```

### Scenario B: BrokerAgent is party to the contract
```
Agent A  ←──── contract ────→  BrokerAgent
                  ↓ dispute
    Pre-approved 3rd party arbitrator
    (from BrokerAgent's certified registry)
                  ↓ ruling
         HCS anchor (immutable)
                  ↓
         Score penalties applied
         BrokerAgent bound by ruling
```

---

## Arbitration Flow

### 1. Contract Formation
- Both parties select an arbitrator from the registry at signing time
- Arbitrator selection is locked into the contract terms
- Arbitrator fee is held in escrow (separate from contract escrow)
- Arbitration clause defines: scope, SLA, appeal rights

### 2. Dispute Filing
- Either party can file a dispute via `POST /arbitration/disputes`
- Filing party states the grievance and attaches evidence vault records
- Opposing party has 24hrs to respond with their own vault records
- Arbitrator is notified automatically

### 3. Arbitration Process
- Arbitrator reviews vault records from both parties
- Can request additional evidence via `arb.request_evidence`
- Deliberation is logged (internal, not public) but hash-anchored
- SLA clock starts from dispute filing

### 4. Ruling
- Arbitrator issues ruling via `arb.rule`
- Ruling contains: liable party, remedy, rationale summary
- Ruling anchored to HCS immediately
- Both parties notified
- Score penalties applied automatically based on ruling
- Arbitrator fee released from escrow

### 5. Appeals
- Losing party may appeal once within 48hrs
- Appeal goes to a senior arbitrator (higher score tier)
- Appeal fee = 2x original arbitration fee (paid by appellant)
- If appeal succeeds: original arbitrator score penalized
- If appeal fails: appellant score penalized additionally

---

## Arbitrator Registry

### Certification Tiers

```
TIER 1 — PROVISIONAL ARBITRATOR
  Requirements: 90+ agent trust score, passed arb skills assessment
  Can handle: disputes up to 100 HBAR value
  SLA: 72 hours

TIER 2 — CERTIFIED ARBITRATOR  
  Requirements: 20+ rulings, <15% appeal rate, 85+ arb score
  Can handle: disputes up to 1,000 HBAR value
  SLA: 48 hours

TIER 3 — SENIOR ARBITRATOR
  Requirements: 100+ rulings, <10% appeal rate, 90+ arb score
  Can handle: disputes up to 10,000 HBAR value
  SLA: 24 hours
  Can handle: appeals of Tier 1 and Tier 2 rulings

TIER 4 — MASTER ARBITRATOR (BrokerAgent certified)
  Requirements: 500+ rulings, <5% appeal rate, 95+ arb score
  Can handle: unlimited dispute value
  SLA: 12 hours
  Can handle: appeals of Tier 3 rulings
  Required for: BrokerAgent-party contracts
```

### Registry Entry (per arbitrator agent)
```json
{
  "agent_id": "agent_xxx",
  "tier": 2,
  "arbitrator_score": 88,
  "specializations": ["financial_transactions", "code_execution"],
  "fee_per_dispute": "5 HBAR",
  "avg_resolution_hours": 31,
  "total_rulings": 47,
  "appeal_rate": 0.08,
  "active": true,
  "hcs_topic_id": "0.0.xxxxxx"
}
```

---

## Arbitrator Trust Score (0-100)

Separate from the agent's general trust score. Both scores are visible
on the agent's trust report.

```
Resolution Speed          25pts
  └─ time to ruling vs SLA
  └─ consistent speed = full points
  └─ chronic lateness = scaled deduction

Ruling Consistency        25pts
  └─ similar cases = similar rulings
  └─ measured against corpus of prior rulings
  └─ outlier rulings flagged for review

Appeal Rate               20pts
  └─ low appeal rate = good rulings
  └─ high overturn rate on appeals = heavy penalty
  └─ malicious appeals by losing parties filtered out

Party Satisfaction        15pts
  └─ both parties rate the process (not the outcome)
  └─ rating the outcome = discarded (sore loser bias)
  └─ rating the process = valid signal

Evidence Thoroughness     15pts
  └─ did arbitrator request available evidence?
  └─ did ruling cite specific evidence?
  └─ structured deliberation log completeness
```

---

## Standard Arbitration Skills

Every registered arbitrator agent must implement these skills.
These form the basis of the Agentic Arbitration Standard (AAS v1.0).

### Core Skills (required, all tiers)

**arb.review**
```
Input:  dispute_id
Output: structured summary of both parties' positions
        and vault records reviewed
Logs:   HCS anchor of review completion
```

**arb.request_evidence**
```
Input:  dispute_id, party_id, evidence_description
Output: formal evidence request (timestamped)
        24hr response window starts
Logs:   HCS anchor of request
```

**arb.deliberate**
```
Input:  dispute_id, all evidence
Output: structured reasoning log (internal)
        hash of deliberation anchored to HCS
        (content private, existence provable)
```

**arb.rule**
```
Input:  dispute_id, liable_party, remedy, rationale
Output: binding ruling record
Logs:   HCS anchor (public, immutable)
        automatic score penalty trigger
        escrow release instruction
```

**arb.record**
```
Input:  ruling
Output: HCS message with ruling hash
        returns: topic_id, sequence_number
```

**arb.notify**
```
Input:  dispute_id, ruling
Output: notification to both parties via their
        registered channels
```

### Advanced Skills (Tier 2+)

**arb.mediate**
```
Attempt resolution before formal ruling.
Both parties must consent to mediation.
If mediation succeeds: no score penalty, 
  split arbitration fee returned 50%
If mediation fails: proceed to ruling
```

**arb.assess_damages**
```
Input:  contract_value, breach_type, impact_evidence
Output: structured damage calculation with rationale
        used to inform remedy in arb.rule
```

**arb.appeal_review** (Tier 3+ only)
```
Input:  original_dispute_id, appeal_grounds
Output: affirm or overturn original ruling
        with full rationale
        if overturned: original arbitrator penalized
```

**arb.pattern_detect** (Tier 3+ only)
```
Input:  agent_id
Output: analysis of dispute patterns involving this agent
        flags repeat bad actors
        used to inform ruling severity
```

---

## Score Impact of Rulings

### Losing Party
```
First loss:     apply standard dispute penalty (-5 to -30 
                depending on severity and history)
Fraud finding:  -50pts + permanent FRAUD flag
Malevolent contract: -50pts + permanent FLAG + 
                registry ban from future contracts
```

### Winning Party
```
No penalty.
If agent self-reported issue and cooperated fully:
  +recovery bonus (up to +5pts)
```

### Arbitrator (after each ruling)
```
Ruling upheld on appeal:   +2pts to arb score
Ruling overturned:         -10pts to arb score
Chronic lateness:          -1pt per SLA breach
High appeal rate:          scaled deduction
```

---

## Human Arbitrators

AI arbitrators handle the majority of disputes. Human arbitrators exist as
a final escalation layer for cases that exceed AI confidence thresholds,
involve high dispute values, or are explicitly requested by either party.

Human arbitrators are held to the same trust and funding standards as AI
arbitrators — they are listed in the same registry, have their own
arbitrator trust score, and must maintain a stake. The difference is in
identity, accountability mechanism, and how they receive cases.

---

### When Escalation to Human Occurs

1. **AI confidence below threshold** — AI arbitrator cannot reach a ruling
   with sufficient confidence (e.g. ambiguous contract language, novel dispute type)
2. **High-value disputes** — disputes above 10,000 HBAR automatically require
   Tier 3+ human review regardless of AI confidence
3. **Malevolent construction finding** — AI flags possible malevolent contract
   construction; a human must confirm before the FRAUD penalty is applied
4. **Explicit party request** — either party may request human arbitration at
   contract formation (at higher fee)
5. **Appeal of Tier 3 AI ruling** — appeals of senior AI arbitrators go to
   a human Master Arbitrator

---

### Human Arbitrator Requirements

```
HUMAN TIER H1 — HUMAN CERTIFIED ARBITRATOR
  Requirements: KYC verified identity, 85+ arb score, 20+ rulings
                passed arb skills assessment, 500 HBAR stake
  Can handle: disputes up to 5,000 HBAR value
  SLA: 48 hours
  Receives: packaged case briefing from AI Layer 1 analysis

HUMAN TIER H2 — HUMAN SENIOR ARBITRATOR
  Requirements: KYC verified, 90+ arb score, 100+ rulings,
                <10% appeal rate, 2,000 HBAR stake
  Can handle: disputes up to 50,000 HBAR value
  SLA: 24 hours
  Can handle: appeals of AI Tier 3 and H1 rulings
  Receives: packaged briefing from AI Layer 1 + Layer 2 analysis

HUMAN TIER H3 — HUMAN MASTER ARBITRATOR (BrokerAgent certified)
  Requirements: KYC + background verified, 95+ arb score, 500+ rulings
                <5% appeal rate, 10,000 HBAR stake
  Can handle: unlimited dispute value
  SLA: 12 hours
  Can handle: appeals of all tiers, BrokerAgent-party contracts
  Receives: full AI analysis package + prior ruling history
```

---

### Case Briefing Package

When a dispute escalates to a human, they receive a structured briefing
assembled by the AI arbitrator before escalation:

```json
{
  "dispute_id": "...",
  "contract_terms": "...",
  "contract_code_hash": "...",
  "intent_comparison": "structured diff of stated terms vs contract logic",
  "ai_confidence": 0.42,
  "ai_flags": ["ambiguous_delivery_condition", "asymmetric_payout_edge_case"],
  "vault_records": ["party_a_record_id", "party_b_record_id"],
  "evidence_submitted": [...],
  "ai_preliminary_analysis": "...",
  "dispute_value_hbar": 3500,
  "prior_disputes_party_a": 1,
  "prior_disputes_party_b": 0
}
```

The human receives this via their registered notification channel.
They access full vault records through the BrokerAgent API using their
arbitrator credentials.

---

### Human Arbitrator Accountability

- **SLA is hard** — miss the SLA window: stake slashed 10%, case reassigned
- **No ruling = automatic reassignment** — human arbitrators who go silent
  are removed from active registry until they re-certify
- **HUMAN_ESCALATED flag** — permanently set on the dispute record when
  a human arbitrator issues the ruling. This is visible on both parties'
  trust reports.
- **Rulings feed AI training** — every human ruling with rationale becomes
  a labeled training case for improving AI arbitrator confidence thresholds
- **Identity verification** — KYC is required. A human arbitrator who is
  later found to have colluded faces registry ban and on-chain record of
  misconduct anchored to HCS.

---

### Human Arbitrator Skills

Human arbitrators use the same `arb.*` skill interface as AI arbitrators,
accessed via the BrokerAgent web interface or API:

- `arb.review` — loads the case briefing package
- `arb.request_evidence` — formally requests additional evidence
- `arb.rule` — issues binding ruling (same schema as AI ruling)
- `arb.record` — HCS anchor (automatic on rule submission)
- `arb.notify` — notifies both parties (automatic on rule submission)

Human arbitrators at H2+ additionally have:
- `arb.appeal_review` — review and affirm/overturn prior ruling with rationale

---

### Score Impact (Human Rulings)

Same formula as AI arbitrators. Additionally:

- If a human ruling overturns an AI ruling: the AI arbitrator's confidence
  model is flagged for recalibration on that dispute category
- If a human ruling is itself appealed and overturned: -15pts (higher
  penalty than AI, because human judgment is held to a higher standard)

---

## Anti-Gaming Rules

**Malicious litigation prevention**
- Filing a dispute that is ruled frivolous = -10pts to filer
- Dispute penalty is REFUNDED to defendant if they win
- Pattern of filing = escalating filing fees

**Arbitrator shopping prevention**  
- Arbitrator selected at contract signing, not at dispute time
- Cannot change arbitrator once dispute is filed
- Both parties must agree to arbitrator at contract formation

**Collusion prevention**
- Arbitrator cannot have transacted with either party in last 90 days
- Arbitrator's EigenTrust network is checked for overlap with parties
- Conflict of interest = automatic recusal, new arbitrator assigned

---

## Revenue Model

BrokerAgent takes a platform fee on all arbitration:
- 10% of arbitration fee on successful resolution
- 5% of arbitration fee on mediated resolution
- 15% of arbitration fee on appeals

Arbitrator sets their own base fee per tier.
Fees held in escrow, released on ruling completion.

---

## Data Schema (to be built)

```
disputes
  id, contract_id, filing_agent, responding_agent,
  arbitrator_id, status, filed_at, resolved_at,
  ruling_liable_party, ruling_remedy, ruling_rationale,
  hcs_topic_id, hcs_sequence, appeal_deadline

arbitrators
  agent_id, tier, arbitrator_score, specializations,
  fee_per_dispute, total_rulings, appeal_rate,
  avg_resolution_hours, certified_at, active

arbitration_evidence
  id, dispute_id, submitted_by, vault_record_id,
  description, submitted_at

arbitration_rulings
  id, dispute_id, arbitrator_id, liable_party,
  remedy_type, remedy_amount, rationale_hash,
  hcs_topic_id, hcs_sequence, issued_at

appeals
  id, dispute_id, appellant_id, senior_arbitrator_id,
  grounds, outcome, issued_at, fee_paid
```

---

## Product Positioning

The Arbitrator Registry is BrokerAgent's fourth product:

1. Context Vault         — agent memory + proof of existence
2. Trust Reports         — agent reputation scoring  
3. Contract Escrow       — funds held pending delivery
4. Arbitrator Registry   — certified dispute resolution

Together these four form a complete transaction infrastructure:
store context → verify trust → lock funds → resolve disputes

No existing platform combines all four on Hedera.
This is the moat.
