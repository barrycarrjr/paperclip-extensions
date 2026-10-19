# Hand-off HTTP regression screenshots

Captured on 2026-10-18 using the T3 collaborative browser at a 1280 by 800 viewport. These are intentional regression evidence, not release artifacts.

- `before-no-uuid.png`: the original bundled `HandOffPage` after clicking Jobs, with `crypto.randomUUID` unavailable. React cannot render the job. The fixture's error reporter prints the actual exception below its banner.
- `after-no-uuid.png`: the rebuilt bundled `HandOffPage` after the same action and browser capability override. The synthetic job, skill references and qualification state render.

Both images use the same invented company, job, skill and historical example. The fixture imports the actual plugin UI bundle, real React and React DOM. It supplies a synthetic host context and in-memory HTTP responses. Its banner and exception reporter belong to the fixture, not Paperclip. Browser screenshots contain no accounts, real company records, credentials, machine paths or browser chrome.

The original bundle came from base commit `11aca6b1b95b578b394107ed58a5c8cad794adb4`. The fixed bundle includes the request ID helper and lazy component initialization in this change. Both were served over loopback HTTP on isolated port 43129. UUID support was explicitly removed to reproduce the API availability of a remote HTTP install; loopback itself is normally a secure browser context.

Bundle SHA-256 values:

```text
before: 253270c5b232ac480451e8439affca5b3c622dfad5d676f9e7ea13507baa7a28
after:  3280473321c5ca84b6a1be51fd5cdd8b9c2300d14cc9e3d2c21038095579c659
```

This verifies browser rendering with a simulated host. It does not establish installation, host authentication, approval handling or acceptance by a complete Paperclip deployment. No plugin was installed, no real company was changed, and the normal application port was not used.
