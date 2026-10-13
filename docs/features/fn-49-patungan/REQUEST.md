# FN-49 Patungan (split bill) — owner request 2026-10-11

Owner: "add feature to patungan per user like LINE and GoPay" (behaviour reference only; never their names, copy or
branding). Montra never holds or moves money (CLAUDE.md): this records a split and tracks who still owes what.

Owner decisions taken before the PRD:
- People: anyone by name (friends without Montra); members of a shared space can be picked and see their part.
- Split modes: equal (remainder rupiah to the payer), exact amounts (must sum to the total), per item (receipt
  items, e.g. from FN-15 Scan struk; tax and service shared proportionally), percentage.
- Settling: a read-only share link (and WhatsApp-ready text) shows each person's amount and the payer's payment
  details; the payer ticks "Lunas" when money arrives. Montra never moves money.
- Books: the payer's expense counts only their own share; the others' shares are Piutang (FN-25c, money owed to
  you) until marked paid.
