# QQ Bridge · Amiya maintenance branch

Personal derivative of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), retaining upstream attribution and history. The maintained production-source branch is `codex/amiya-production`.

This branch contains the current Node/Pi bridge, a sanitized Amiya role card, a separately deployed LivingMemory 2.8.2 service, pinned dependency files, deployment examples and offline regression suites. Production credentials, QQ login data, conversations, databases, indexes and backups are excluded.

Use Node 22.19+ (22.x), run `npm ci`, `npm run setup:pi` and `npm run init:amiya`, then configure the generated private `config.json`, allow lists, your external OneBot gateway and provider credentials. Run `npm start`. Memory service setup is optional and requires separate tokens and configuration.

See the [Chinese guide](README.md), [deployment guide](docs/AMIYA_DEPLOYMENT.md), [test scope](docs/AMIYA_TESTING.md) and [component provenance](docs/AMIYA_UPSTREAM.md). The bridge retains MIT; the LivingMemory service carries its own AGPL notices and upstream license.
