# Changelog

## 0.4.1

- The billion-context (bili) index cleanup is now a **setting, off by default**. When it is off, deleting a session leaves `index.db` untouched and the response reports `bili: { skipped: true }`.
- New settings section **设置 → 删除对话** with that switch (the value lives in `$DSH_HOME/dsh-delete.json`).
- The plugin now says *why* it refused: `not-desktop` / `not-archived` / `running` / `missing` are surfaced in the toast instead of a generic failure.

## 0.4.0

- The confirm dialog is a DSH-styled `Modal` + `Button` (was `window.confirm`).
- The menu item moved below 「取消归档」, uses red text and a trash icon (`contextMenu.icon`), and no longer carries a separator above it.
- Deleting still: removes the session folder, its projection cache, detaches it from the workspace registry and broadcasts `api-session/removed` so the row disappears immediately.

## 0.3.0

- Optional bili index cleanup (see above), with a `VACUUM INTO` snapshot taken before any write.
- Fixed: the delete route stayed registered but the shell was silently ignoring it after a hot reload.

## 0.2.x

- Only offers 「删除对话」 for archived sessions.
- Added the `archived` gate, the `running` gate and idempotent repeat-delete.

## 0.1.0

- First working version: menu item, archive-then-delete, filesystem removal.
