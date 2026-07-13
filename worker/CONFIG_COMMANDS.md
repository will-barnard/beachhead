# Worker Config Commands

Use these commands from the `worker` directory to manage `worker/.env` and optionally rebuild the `beachhead-worker` container.

## List configured servers

```bash
npm run config -- list
```

## Disable a server and rebuild

```bash
npm run config -- disable 2 --rebuild
```

## Enable a server and rebuild

```bash
npm run config -- enable 2 --rebuild
```

## Toggle a server by URL and rebuild

```bash
npm run config -- toggle https://beachhead.brew.rip --rebuild
```

## Add a server in disabled state

```bash
npm run config -- add https://example.com <token> --disabled
```

## Remove a server and rebuild

```bash
npm run config -- remove 3 --rebuild
```

## Rebuild only

```bash
npm run config -- rebuild
```

## Notes

- `list` shows the configured server URLs and whether each one is enabled.
- `enable`, `disable`, `toggle`, and `remove` accept either a numeric index from `list` or an exact URL.
- The CLI keeps `BEACHHEAD_URLS` and `BEACHHEAD_TOKENS` in sync with managed per-server entries in `worker/.env`.
- `--rebuild` runs the worker container rebuild immediately after saving changes.
