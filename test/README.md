# Tests

Plain Node scripts — no dependencies, no test framework. They load the real
source out of `lib/`, `content/` and `dashboard/` (via `vm`) rather than
reimplementing it, and stub `chrome.*` and `igFetch`.

```sh
node test/storage.test.mjs
node test/fetch-and-escaping.test.mjs
```

Note: `fetch-and-escaping.test.mjs` rewrites `RATE_LIMIT_BACKOFF` to
millisecond waits in its in-memory copy so the retry cases finish instantly.
The control flow under test is unchanged.
