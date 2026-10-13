---
title: Why we never store the file you upload
slug: file-unggahan-tidak-disimpan
date: 2026-10-08
excerpt: Statements, screenshots and receipt photos are processed in memory and then forgotten. What "sealed with your account key" means, and what happens if the key is lost.
---

A bank statement is one of the most personal documents you have. It shows more than a balance; it shows habits: where you eat, whom you send money to every month, when your salary arrives. So we made one simple promise: **a file you upload to be read is never stored by us.**

## Processed in memory, then forgotten

When you upload a statement, a screenshot or a receipt photo, the file lives only in the server's memory while it is being read. There is no copy on disk, in the database, in file storage or in the logs. Once reading is done, the memory is released and the file is gone.

What we keep is **the result of the reading**, and that result is locked too.

## What "sealed with your account key" means

Picture a letterbox with a slot in the front. Anyone can drop a letter in, but only the person with the key can open it.

- When you sign up, your device creates a pair of keys. The "slot" (the public key) is sent to the server; the "key" (the private key) is wrapped with a key derived from your password.
- The server drops the reading result into that letterbox. Once sealed, the server itself can no longer open it.
- To open it, your device unwraps the private key with your password. The password is processed on your device, and the key it produces never leaves your device.

The sealing uses well-tested, widely used cryptographic methods, not a home-made scheme.

One honest note: your password still reaches the server when you sign in, as with almost every service. Sealing protects the stored reading results; it does not replace a strong password.

## If your password is lost

Your private key can only be unwrapped with your password. If it can no longer be unwrapped, results that are still sealed cannot be opened by anyone, including us. That is the price of the promise above.

The good news is that little is lost:

- Transactions you already checked and saved are ordinary records in your account and are not locked.
- The original file is still with you. You can always upload it again to have it read once more.

So what is lost is only a draft you had not saved yet, not your financial history.

> In short: we read your upload once, lock the result for you, and forget the file.
