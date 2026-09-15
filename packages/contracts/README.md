# @tessera/contracts

The shared surface between `tessera-api` and `tessera-web`: wire types, and the pure
domain logic that both sides must agree on exactly.

ADR-004 chose separate repositories. This package is the mitigation — without it the two
sides re-type each other's shapes by hand and nothing detects a drift until runtime.

## Consuming it

`tessera-api` links it through a pnpm workspace. `tessera-web` installs it straight from
git, so there is no registry and no publish step:

```bash
pnpm add "github:Favalcodes/tessera-api#path:/packages/contracts"
```

Pin to a tag or commit for anything deployed; a bare branch reference silently moves.

## Rules for this package

**No dependencies, ever.** It is installed from git, which means its `prepare` script runs
on the consumer's machine. Anything it needs to build, the consumer pays for.

**No framework imports.** No NestJS, no React, no Node built-ins. It must compile and run
unchanged in a browser and on a server, because it does both.

**Pure functions only.** Everything here is deterministic and side-effect free. That is
what makes it safe for the client to compute a multiplier locally and get the same answer
the server settles on.
