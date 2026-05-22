# Contributing

Thanks for helping make video in Chrome look better.

## Development

```sh
corepack enable pnpm
pnpm install
pnpm verify
```

Keep changes scoped to the current milestone. Shader ports must preserve upstream headers and include matching entries in `NOTICE`.

## License Hygiene

- Original project code should be MIT.
- LGPL shader sources must stay under their mode folder with clear attribution.
- Add full third-party license texts under `LICENSES/`.
- Update `NOTICE` with upstream project, commit hash or release, license, and touched files.
