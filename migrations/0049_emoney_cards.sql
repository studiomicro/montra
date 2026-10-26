-- FN-58 pass 1 e-money cards: `wallets.emoney_issuer`, the issuer of a contactless e-money card the user keeps as a
-- wallet ("Kartu e-money"). The card stays `type = 'e_wallet'`, so its balance, top-ups (transfers), balance
-- adjustments and net worth work as for any e-wallet; nullable, with a column CHECK (null unless the wallet is an
-- `e_wallet`, and then one of the seven issuer keys of EMONEY_ISSUERS). Added with `ALTER TABLE … ADD` (no rebuild:
-- 21 tables reference `wallets` and D1 always enforces foreign keys; the Drizzle schema states the same check at
-- table level, 0047's pattern). No backfill: every existing wallet keeps null. No full card number is ever stored
-- (only `last_four`, its own CHECK). A re-run stops at the ALTER with "duplicate column", harmlessly. Deploy the app
-- after this apply; old code ignores the column. Remote apply only through `wrangler d1 migrations apply` after a
-- Time Travel bookmark (docs/RUNBOOK.md).
ALTER TABLE `wallets` ADD `emoney_issuer` text CONSTRAINT "wallets_emoney_issuer_check" CHECK("emoney_issuer" is null or ("type" = 'e_wallet' and "emoney_issuer" in ('mandiri_emoney', 'bca_flazz', 'bri_brizzi', 'bni_tapcash', 'kmt', 'jakcard', 'megacash')));
