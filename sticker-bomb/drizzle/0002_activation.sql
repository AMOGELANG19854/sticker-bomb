ALTER TABLE campaigns ADD COLUMN owner_wallet TEXT;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN pickup_hash TEXT;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN picked_up INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN pin_retry_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE wallet_challenges (
  nonce TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  expires INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE scan_totals (
  campaign TEXT NOT NULL REFERENCES campaigns(id),
  stop INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (campaign, stop)
);
