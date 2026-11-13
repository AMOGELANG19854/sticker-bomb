CREATE TABLE placement_payouts (
  campaign TEXT NOT NULL,
  stop INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  proof TEXT NOT NULL,
  escrow TEXT NOT NULL,
  token TEXT NOT NULL,
  tx TEXT,
  submitted_at INTEGER,
  paid_at INTEGER,
  PRIMARY KEY (campaign, stop),
  FOREIGN KEY (campaign, stop) REFERENCES proofs(campaign, stop)
);
