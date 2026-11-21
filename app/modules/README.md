# Modules

Every folder under `app/modules/` is a **deep module**: a lot of behaviour behind a small interface. The interface is the module's **entry points**, the files at its root. Everything in a subfolder is private.

```
app/modules/
  <name>/
    index.server.ts   ← an entry point. Import this from outside.
    client.ts         ← another entry point. A module may expose several.
    lib/              ← implementation: hidden from outside, free to import each other.
    tests/            ← tests and fixtures (a subfolder, so private).
```

Copy `example/` to start a new module. Server-only modules use a `.server.ts` entry point, as `instructor-analytics/` does, so React Router keeps them out of the client bundle.

**Import only through a module's entry points.** `~/modules/instructor-analytics/index.server` is fine; `~/modules/instructor-analytics/lib/...` is not.

**No barrel files.** Don't make one `index.ts` that re-exports a whole subtree. Expose several small entry points instead, and list exports by name.

## Rules

Run `npm run lint:boundaries` (dependency-cruiser, config in `.dependency-cruiser.cjs`). All rules are errors.

1. **Entry-point boundary.** Code outside a module (routes, `app/lib`, other modules) may import only that module's root files, never anything in its subfolders.
2. **Intra-module freedom.** A module's own files import each other freely.
3. **Tests through the entry points.** Files under `<module>/tests/` may import any module's entry points and their own `tests/` fixtures, never any module's subfolder internals, not even their own. Nothing outside `tests/` may import from it.
4. **No cycles.** No dependency cycles anywhere in `app/`.

Modules are flat: one level under `app/modules/`. A module's internals may nest as deep as you like, but a module may not contain another module. Any subfolder is private, so adding a folder never needs a config change.
