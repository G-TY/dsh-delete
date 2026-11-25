/**
 * Client half of DSH-delete.
 *
 * Adds "删除对话" to the session row menu through the `contextMenus` service.
 * It only appears for sessions that are already archived: deleting is
 * irreversible, so the archive step is the deliberate "I really mean it" gate.
 * The Host route re-checks the archive list on disk.
 *
 * The entry sits in the menu footer (`afterContent`, same slot the built-in
 * archive/unarchive action uses) so it renders *below* 归档/取消归档, and it is
 * marked `danger` so DSH paints it red without us hard-coding a colour.
 *
 * Confirmation uses the DSH primitives `Modal` + `Button`, i.e. the exact same
 * dialog the app shows for "删除工作区", instead of a native `window.confirm`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-delete',
  factory(require) {
    const NS = 'dshDelete'
    const ROUTE_PATH = '/dsh-delete/delete'
    /** Keyed icon slot id; DSH paints it in the menu's icon column. */
    const ICON_KEY = 'dsh-delete.trash'

    const zh = {
      action: '删除对话',
      confirmTitle: '删除这个对话？',
      confirmDesc: '删除后无法恢复：它的内容会从磁盘移除。',
      cancel: '取消',
      busy: '正在删除…',
      done: '已删除这个对话',
      failed: '删除失败',
      settingsNav: '删除对话',
      biliLabel: '同时清理 billion-context（bili）的会话索引',
      biliHint:
        '默认关闭。bili 压缩代理自己存了一份会话索引，不清理的话，删掉的对话仍会出现在它的会话列表里。打开后本插件会在删除时修改它的 SQLite 文件。',
      saveFailed: '保存设置失败',
      saveDone: '已保存',
    }

    const en = {
      action: 'Delete session',
      confirmTitle: 'Delete this session?',
      confirmDesc: 'This cannot be undone: its content is removed from disk.',
      cancel: 'Cancel',
      busy: 'Deleting…',
      done: 'Session deleted',
      failed: 'Delete failed',
      settingsNav: 'Delete session',
      biliLabel: 'Also purge the billion-context (bili) session index',
      biliHint:
        'Off by default. The bili compression proxy keeps its own copy of every session index; without this, a deleted session keeps showing up in its list. Turning it on makes this plugin edit that SQLite file.',
      saveFailed: 'Could not save the setting',
      saveDone: 'Saved',
    }

    const CSS = `
      .dsh-delete-danger, .dsh-delete-danger:disabled {
        background: #d92d20;
        border-color: #d92d20;
        color: #ffffff;
      }
      .dsh-delete-danger:hover:not(:disabled) {
        background: #b42318;
        border-color: #b42318;
        color: #ffffff;
      }
    `

    // --- tiny confirm store, rendered through the `shell.overlay` slot ---------
    const listeners = new Set()
    let pending = null

    function subscribeConfirm(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function snapshotConfirm() {
      return pending
    }

    function emitConfirm() {
      for (const listener of listeners) listener()
    }

    /** Resolves true when the user confirms, false/undefined when they dismiss. */
    function askConfirm() {
      return new Promise((resolve) => {
        pending = { resolve }
        emitConfirm()
      })
    }

    function settleConfirm(value) {
      const current = pending
      pending = null
      emitConfirm()
      if (current) current.resolve(value)
    }

    /** The menu hands over the captured target value: an id, or a row record. */
    function sessionIdOf(target) {
      if (typeof target === 'string') return target
      if (!target || typeof target !== 'object') return null
      const candidates = [target.sessionId, target.id, target.session && target.session.id]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
      return null
    }

    /** Archived ids as the sidebar currently sees them. */
    function archivedIds(ctx) {
      try {
        const list = ctx.workspaces && ctx.workspaces.list
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
        const ids = snapshot && snapshot.archivedSessionIds
        return Array.isArray(ids) ? ids : []
      } catch (error) {
        return []
      }
    }

    async function removeSession(sessionId) {
      const response = await fetch(ROUTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const detail = payload && typeof payload.message === 'string' ? payload.message : ''
        throw new Error(detail || `HTTP ${response.status}`)
      }
      return payload
    }

    function notify(ctx, text, ok) {
      try {
        ctx.contextMenus.notify(text, ok)
      } catch (error) {
        // A missing toast must not turn a finished operation into a failure.
      }
    }

    function actionFor(ctx, sessionId, withIcon) {
      const t = ctx.locale.bind(NS)
      return {
        id: 'delete',
        label: t('action'),
        // DSH renders `danger` actions in its destructive colour.
        danger: true,
        // Same footer as 归档/取消归档 ⇒ we render below it (order 900 > 600).
        afterContent: true,
        ...(withIcon ? { icon: { key: ICON_KEY } } : {}),
        run: async () => {
          const confirmed = await askConfirm()
          if (confirmed !== true) return
          try {
            await removeSession(sessionId)
            notify(ctx, t('done'), true)
          } catch (error) {
            // Show the Host's own reason instead of a generic failure label.
            const reason = String((error && error.message) || error)
            notify(ctx, `${t('failed')}：${reason}`, false)
          }
        },
      }
    }

    /** Builds the overlay component once the primitives are known to exist. */
    function createConfirmOverlay(primitives, ctx) {
      const { Modal, Button } = primitives
      const h = require('react').createElement

      function ConfirmOverlay() {
        const t = ctx.locale.bind(NS)
        const [state, setState] = require('react').useState(snapshotConfirm)

        require('react').useEffect(() => {
          setState(snapshotConfirm())
          return subscribeConfirm(() => setState(snapshotConfirm()))
        }, [])

        if (!state) return null

        return h(
          Modal,
          {
            open: true,
            onClose: () => settleConfirm(false),
            closeLabel: t('cancel'),
            title: t('confirmTitle'),
            description: t('confirmDesc'),
            footer: h(
              require('react').Fragment,
              null,
              h(Button, { variant: 'outline', onClick: () => settleConfirm(false) }, t('cancel')),
              h(
                Button,
                { variant: 'outline', className: 'dsh-delete-danger', onClick: () => settleConfirm(true) },
                t('action'),
              ),
            ),
          },
        )
      }

      return ConfirmOverlay
    }

    /** Settings live on the Host: `$DSH_HOME/dsh-delete.json`. */
    const SETTINGS_PATH = '/dsh-delete/settings'

    async function readSettings() {
      const response = await fetch(SETTINGS_PATH, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true || !payload.settings) throw new Error(`HTTP ${response.status}`)
      return payload.settings
    }

    async function writeSettings(patch) {
      const response = await fetch(SETTINGS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true || !payload.settings) {
        const detail = payload && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return payload.settings
    }

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '12px 0',
      borderBottom: '1px solid rgba(127,127,127,.18)',
    }

    /** One checkbox row, styled like the rest of DSH's settings sections. */
    function createSettingsPanel(ctx) {
      const react = require('react')
      const h = react.createElement

      function SettingsPanel() {
        const t = ctx.locale.bind(NS)
        const [settings, setSettings] = react.useState(null)
        const [note, setNote] = react.useState('')

        react.useEffect(() => {
          let alive = true
          readSettings()
            .then((value) => {
              if (alive) setSettings(value)
            })
            .catch(() => {
              if (alive) setSettings({ purgeBiliIndex: false })
            })
          return () => {
            alive = false
          }
        }, [])

        if (settings === null) return null

        const toggle = async (checked) => {
          const previous = settings
          setSettings({ ...settings, purgeBiliIndex: checked })
          setNote('')
          try {
            const saved = await writeSettings({ purgeBiliIndex: checked })
            setSettings(saved)
            setNote(t('saveDone'))
          } catch (error) {
            setSettings(previous)
            setNote(`${t('saveFailed')}：${String((error && error.message) || error)}`)
          }
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h(
            'label',
            { style: ROW_STYLE },
            h('input', {
              type: 'checkbox',
              checked: settings.purgeBiliIndex === true,
              onChange: (event) => void toggle(event.target.checked),
              style: { marginTop: '2px' },
            }),
            h(
              'span',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              h('span', { style: { fontSize: '13px' } }, t('biliLabel')),
              h('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('biliHint')),
            ),
          ),
          note === '' ? null : h('p', { style: { fontSize: '12px', opacity: 0.7 } }, note),
        )
      }

      return SettingsPanel
    }

    return {
      inject: ['contextMenus', 'locale', 'workspaces', 'slots'],
      apply(ctx) {
        let primitives = null
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        } catch (error) {
          primitives = null
        }

        const styled = Boolean(primitives && primitives.Modal && primitives.Button)

        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-delete: dictionaries',
        )

        if (styled) {
          ctx.effect(() => {
            const style = document.createElement('style')
            style.setAttribute('data-dsh-delete', '')
            style.textContent = CSS
            document.head.appendChild(style)
            return () => style.remove()
          }, 'dsh-delete: dialog styles')

          // `contextMenu.icon` is a keyed root slot: one registration per icon key.
          // Using the app's own trash glyph keeps the label aligned with the
          // built-in archive entry (which also has an icon column).
          if (primitives.IconTrashOutlineRegular) {
            const TrashIcon = primitives.IconTrashOutlineRegular
            ctx.effect(
              () => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
                { name: 'contextMenu.icon', key: ICON_KEY },
                TrashIcon,
              )),
              'dsh-delete: menu icon',
            )
          }

          ctx.effect(
            () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-delete-confirm' },
              createConfirmOverlay(primitives, ctx),
            )),
            'dsh-delete: confirm overlay',
          )
        }

        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-delete',
              order: 120,
              label: ctx.locale.bind(NS)('settingsNav'),
              locale: NS,
            },
            createSettingsPanel(ctx),
          )),
          'dsh-delete: settings section',
        )

        ctx.effect(
          () => ctx.contextMenus.register({
            id: 'dsh-delete',
            target: 'session',
            order: 900,
            // Re-resolve when the archive list or the language changes.
            observe: () => [ctx.workspaces.list, ctx.locale],
            resolve: (target) => {
              const sessionId = sessionIdOf(target)
              if (sessionId === null) return []
              if (!archivedIds(ctx).includes(sessionId)) return []
              if (styled) return [actionFor(ctx, sessionId, Boolean(primitives.IconTrashOutlineRegular))]
              // No primitives: keep the old native prompt rather than nothing.
              return [{
                id: 'delete',
                label: ctx.locale.bind(NS)('action'),
                danger: true,
                afterContent: true,
                run: async () => {
                  const t = ctx.locale.bind(NS)
                  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                    if (!window.confirm(`${t('confirmTitle')}\n\n${t('confirmDesc')}`)) return
                  }
                  try {
                    await removeSession(sessionId)
                    notify(ctx, t('done'), true)
                  } catch (error) {
                    const reason = String((error && error.message) || error)
                    notify(ctx, `${t('failed')}：${reason}`, false)
                  }
                },
              }]
            },
          }),
          'dsh-delete: menu contribution',
        )
      },
    }
  },
})
