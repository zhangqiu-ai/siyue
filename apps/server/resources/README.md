# Local common-password denylist

Source: [SecLists 10k common passwords](https://raw.githubusercontent.com/danielmiessler/SecLists/913b327317496d062bcc7cace524aaad8a693be2/Passwords/Common-Credentials/10k-most-common.txt), commit `913b327317496d062bcc7cace524aaad8a693be2`.
Source SHA-256: `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce`.

The derived file contains SHA-256 values of lowercased common strings, plus the well-known example phrase “correct horse battery staple”. Actual password hashing preserves the exact input and uses Argon2id. No user password is sent to any service. This is a bounded known-common-password list, not a claim to cover all breached passwords. Update review requires pinned source and local regression.

SecLists license: [MIT](https://github.com/danielmiessler/SecLists/blob/913b327317496d062bcc7cace524aaad8a693be2/LICENSE).
