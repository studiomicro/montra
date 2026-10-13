---
title: One QRIS e-mail, one transaction — no typing
slug: email-qris-jadi-transaksi
date: 2026-10-07
excerpt: How Montra turns payment e-mails from banks and e-wallets into transactions, what it reads, what it deletes straight away and how duplicates are caught.
---

Every time you pay with QRIS, make a transfer or settle a bill, your bank or e-wallet usually sends a payment e-mail. That e-mail already holds everything a record needs: who was paid, how much and when. Montra can read it for you so you do not have to type anything.

## An hourly check

Once you connect Gmail with **read-only** access, Montra checks your inbox once an hour between 06:00 and 23:00 WIB. The night is left alone. Read-only means we cannot send, delete or change any e-mail in your account.

## Which e-mails are read

Montra looks only for payment notifications: QRIS receipts, transfers, top-ups and bills from banks and e-wallets. Personal, work, promotional and newsletter e-mails are not turned into transactions.

- A payment e-mail is read for the payee, the amount, the date and the payment method.
- For an e-mail that is not a payment, we keep only its identifier and date, so the same e-mail is not checked twice.
- Account and card numbers are cut down to their last four digits before anything is stored.

## The e-mail text is deleted after reading

We do not keep the content of your e-mails. As soon as the transaction has been taken from it, the text is discarded. What stays in Montra is the transaction, tagged with Gmail as its source. Data from your inbox is never used for advertising, credit scoring or lending.

If the sender fails the authenticity check, or the AI is unsure of its reading, the transaction arrives as **Needs review** and waits for your decision.

## Duplicates are caught before they are saved

One payment can leave traces in several places: an e-mail from the bank, a notification from the e-wallet, then a line in the month-end statement. Montra prevents double records in two ways:

1. Every e-mail has a unique identifier. The same e-mail never becomes two transactions, even when it is checked again.
2. Similar transactions, with a matching amount close in time, are flagged **Possible duplicate** so you can choose which one to keep.

And if you delete a transaction that came from an e-mail, it will not come back from that same e-mail.

> Status at the time of writing: the Gmail connection is still waiting for its access approval and is not active yet. Until then, the Connected apps page shows "Not configured".
