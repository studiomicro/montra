---
title: From receipt to transaction in seconds
slug: struk-jadi-transaksi
date: 2026-10-06
excerpt: What happens to a receipt photo from the moment you take it until it becomes a transaction, and why we never keep the photo.
---

A shopping receipt is small, crumples easily and usually ends up in the bin before anyone writes it down. Taking a photo is far quicker than retyping every line. This article walks through what happens to that photo in Montra, step by step.

## Four steps from photo to record

1. **You take or choose a photo of the receipt.** It travels over an encrypted connection to our server.
2. **The AI reads the receipt in memory.** The photo is never written to disk, a database or file storage. It looks only for what a record needs: the shop, the date, the total and, when present, the items.
3. **The result is sealed with your account key.** As soon as it has been read, the result is locked so that only a device where you signed in with your password can open it.
4. **You check it before saving.** The result appears as a draft. Nothing is recorded until you press save.

## Why the photo is not kept

A receipt photo can hold more than you expect: a truncated card number, the cashier's name, the address of a shop you visit often, sometimes a membership number. We do not need any of that to record a purchase, so we chose not to keep the photo at all. A file that was never stored cannot leak, cannot be requested by anyone else and never needs deleting later.

What remains is only the transaction you approved, tagged with its source, the receipt, so you always know where a record came from.

## When the AI misreads the total

AI can get things wrong, especially on faded, folded or lightly printed receipts. That is why:

- A draft the AI is unsure about is marked **Needs review** and is never saved silently.
- You can change the total, date, category and wallet before saving.
- If the result is too far off, discard the draft and record the purchase by hand or by voice. Nothing stays behind on the server.

One small habit helps: compare the total in the draft with the last figure on the receipt. That alone catches almost every misread.

> Status at the time of writing: AI receipt reading is being prepared and is not yet active for every account. In the app, a feature that is not ready yet is marked "Not configured".
