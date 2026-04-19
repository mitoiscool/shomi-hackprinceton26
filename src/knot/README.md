Knot dev demo notes

- `KNOT_EXTERNAL_USER_ID` is optional for the scripts. If omitted, the scripts use the active seeded dev user for `local-cli`.
- only walmart is supported in this demo and the merchant id defaults to `45`.
- `npm run knot:seed-dev-user` seeds a reusable dev user links walmart in Knot development and syncs seeded walmart purchases into SQLite.
- `npm run knot:sync` re-syncs walmart transaction history for the active dev user.
- `npm run knot:listen-webhooks` starts the local webhook listener used for async cart and checkout updates.
- Raw sync page payloads are written under `KNOT_DATA_DIR/<external_user_id>/<merchant_id>/sync-pages/`.
- Normalized purchase, payment-method, cart, checkout, and webhook data are stored in separate `knot_*` tables inside `data/shomi.sqlite`.
