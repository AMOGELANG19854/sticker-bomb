CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wallet TEXT
);
--> statement-breakpoint
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  caption TEXT NOT NULL,
  created INTEGER NOT NULL,
  worker TEXT REFERENCES workers(id),
  next_stop INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE proofs (
  campaign TEXT NOT NULL REFERENCES campaigns(id),
  stop INTEGER NOT NULL,
  photo TEXT NOT NULL,
  hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (campaign, stop),
  UNIQUE (campaign, hash)
);

--> statement-breakpoint
CREATE TRIGGER advance_campaign AFTER INSERT ON proofs
BEGIN
  UPDATE campaigns SET next_stop = next_stop + 1 WHERE id = NEW.campaign;
END;
