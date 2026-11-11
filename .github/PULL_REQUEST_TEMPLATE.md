## What changed

<!-- One or two sentences. Link the issue this closes, if there is one. -->

## Why

<!-- The behaviour that was wrong or missing. Paste the failing output when this fixes a bug. -->

## Verification

<!-- The commands you ran, and the result. -->

```sh
pnpm verify
```

## Checklist

- [ ] `pnpm verify` passes locally.
- [ ] A test covers the change, and it fails without it.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`.
- [ ] `README.md` and `README.zh-CN.md` are updated together when user-facing behaviour changed.
- [ ] `bench/REPORT.md` was regenerated, not hand-edited, if a benchmark claim changed.
- [ ] New files under `src/` carry `SPDX-License-Identifier: MPL-2.0`.
- [ ] The change is licensed under MPL-2.0 and contains no incompatible third-party code.
