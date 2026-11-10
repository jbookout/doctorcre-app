# PRODUCTION PROOF

The runnable read-only proof is `node scripts/prove-share-intake.ts`. It uses the shared release-aware browser proof runner, shared release reader and ancestry check. It reads `/app-release` before and after observation, requires a release containing the expected merge commit, and compares the canonical attachment receipt and deal document list exactly. It does not create a production attachment.

After an attended phone share, supply the actual attachment UUID, the merged app commit and a JSON file containing the receipt's `deal_id`, `sha256`, `filename`, `mime` and numeric `bytes`. The CLI arguments are `--origin`, `--expected-commit`, `--cdp-url`, `--expected-json` and `--attachment-id`. The CDP URL must refer to an existing signed-in loopback browser. No credentials or auth state are written to disk.

Exit 0 means a containing, stable release passed attachment and list assertions. Exit 1 means an assertion failed on a containing release. Exit 78 means evidence is insufficient, including absent session, receipt arguments, unknown release, non-containing release, unavailable browser or deadline expiry.

Fixture commands are directly runnable from the repository root.

```sh
node scripts/prove-share-intake.ts --expected-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --fixture-case pass
node scripts/prove-share-intake.ts --expected-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --fixture-case fail
node scripts/prove-share-intake.ts --expected-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --fixture-case insufficient
```

The expected exits are 0, 1 and 78. They consume the recorded producer fixture copied from CARR commit `926602dead49619842aa4e617dae08d96fed40c2`. They do not prove a deployed app or actual phone.

Joe's phone and an attended partner are required to prove registration in its OS share sheet. Share both a PDF and a photo from Mail/Photos into the installed PWA, select authorized deal targets, and record the exact returned attachment receipts. The supported-device and OS compatibility observation remains separate from the read-only receipt proof. Desktop multipart automation is not physical-device evidence. No phone OS compatibility, production filing or completed AC-SHARE claim is made by the builder.
