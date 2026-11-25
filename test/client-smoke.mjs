/**
 * Offline smoke test for the DSH-delete client half.
 *
 * Fakes `window.__ModuleLoader__` plus the two modules the client requires
 * (`react` and the DSH primitives), then walks what the menu framework and the
 * overlay slot would see: archived-only gate, danger/footer placement, and the
 * Modal confirm → POST → toast flow.
 */
import assert from 'node:assert/strict'

const loaded = []
globalThis.window = {
  __ModuleLoader__: { load(entry) { loaded.push(entry) } },
}

const appended = []

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  Fragment: 'Fragment',
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
}

const Modal = function Modal() { return null }
const Button = function Button() { return null }
const IconTrashOutlineRegular = function IconTrashOutlineRegular() { return null }

const primitives = { Modal, Button, IconTrashOutlineRegular }

const required = []
const fakeRequire = (name) => {
  required.push(name)
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${name}`)
}

await import('../client.js')

assert.equal(loaded.length, 1)
assert.equal(loaded[0].id, 'dsh-delete')

const exports = loaded[0].factory(fakeRequire)
assert.deepEqual(exports.inject, ['contextMenus', 'locale', 'workspaces', 'slots'])

const ARCHIVED = 'session-11111111-2222-3333-4444-555555555555'
const LIVE = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const dictionaries = []
const registrations = []
const injectedSlots = []
const slotRegistrations = []
const notifications = []
const requests = []

globalThis.fetch = async (url, init) => {
  requests.push({ url, init })
  return {
    ok: true,
    status: 200,
    async json() { return { ok: true, sessionId: ARCHIVED, removed: 1 } },
  }
}

globalThis.document = {
  head: { appendChild(node) { appended.push(node) }, removeChild() {} },
  createElement(tag) {
    return { tag, textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value }, remove() {} }
  },
}

const archivedIds = [ARCHIVED]

const ctx = {
  locale: {
    register(namespace, dictionariesByName) { dictionaries.push({ namespace, dictionariesByName }) },
    bind(namespace) { return (key) => `${namespace}.${key}` },
  },
  workspaces: {
    list: {
      getSnapshot() { return { archivedSessionIds: archivedIds } },
    },
  },
  contextMenus: {
    register(input) { registrations.push(input); return () => {} },
    notify(text, success) { notifications.push({ text, success }) },
  },
  slots: {
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
    inject(name, register) {
      injectedSlots.push({ name, register })
      return () => {}
    },
  },
  effect(register) { register() },
}

exports.apply(ctx)

assert.equal(dictionaries[0].namespace, 'dshDelete')
assert.equal(dictionaries[0].dictionariesByName.zh.action, '删除对话')
assert.equal(dictionaries[0].dictionariesByName.zh.confirmTitle, '删除这个对话？')

// A style tag carrying the destructive colours is installed once.
assert.equal(appended.length, 1)
assert.match(appended[0].textContent, /dsh-delete-danger/)

// Three slot injections: the keyed menu icon, the shell overlay, the settings page.
assert.equal(injectedSlots.length, 3)
assert.equal(injectedSlots[0].name, 'contextMenu.icon')
assert.equal(injectedSlots[1].name, 'shell.overlay')
assert.equal(injectedSlots[2].name, 'settings.section')

injectedSlots[0].register()
assert.equal(slotRegistrations.length, 1)
assert.equal(slotRegistrations[0].options.name, 'contextMenu.icon')
assert.equal(slotRegistrations[0].options.key, 'dsh-delete.trash')
assert.equal(slotRegistrations[0].component, primitives.IconTrashOutlineRegular)

injectedSlots[1].register()
assert.equal(slotRegistrations.length, 2)
assert.equal(slotRegistrations[1].options.name, 'shell.overlay')
assert.equal(slotRegistrations[1].options.id, 'dsh-delete-confirm')

injectedSlots[2].register()
assert.equal(slotRegistrations.length, 3)
assert.equal(slotRegistrations[2].options.name, 'settings.section')
assert.equal(slotRegistrations[2].options.id, 'dsh-delete')
assert.equal(slotRegistrations[2].options.order, 120)
assert.equal(slotRegistrations[2].options.locale, 'dshDelete')

assert.equal(registrations.length, 1)
const registration = registrations[0]
assert.equal(registration.target, 'session')
assert.equal(registration.order, 900)

// Only archived rows offer the entry.
assert.equal(registration.resolve(ARCHIVED).length, 1)
assert.equal(registration.resolve({ id: ARCHIVED }).length, 1)
assert.equal(registration.resolve({ session: { id: ARCHIVED } }).length, 1)
assert.equal(registration.resolve(LIVE).length, 0)
assert.equal(registration.resolve({ id: LIVE }).length, 0)
assert.equal(registration.resolve(null).length, 0)
assert.equal(registration.resolve({ title: 'no id' }).length, 0)

const Overlay = slotRegistrations.find((entry) => entry.options.name === 'shell.overlay').component
assert.equal(typeof Overlay, 'function')

/** Renders the overlay once and returns the Modal element it produced. */
function renderOverlay() {
  const tree = Overlay()
  assert.ok(tree, 'the overlay must render while a confirm is pending')
  assert.equal(tree.type, Modal)
  return tree
}

/** Flattens the footer into [cancel, confirm] button elements. */
function footerButtons(modal) {
  const footer = modal.props.footer
  assert.equal(footer.type, 'Fragment')
  return footer.children
}

const action = registration.resolve(ARCHIVED)[0]
assert.equal(action.id, 'delete')
assert.equal(action.label, 'dshDelete.action')
// Placement + colour are declared, not guessed.
assert.equal(action.danger, true)
assert.equal(action.afterContent, true)
// No separator above: the archive entry already ends the block.
assert.equal(action.separatorBefore, undefined)
// Icon uses DSH's own trash glyph so the label lines up with 取消归档.
assert.deepEqual(action.icon, { key: 'dsh-delete.trash' })
assert.equal(action.failureLabel, undefined)

const iconRegistrations = slotRegistrations.filter((entry) => entry.options.name === 'contextMenu.icon')
assert.equal(iconRegistrations.length, 1)
assert.equal(iconRegistrations[0].options.key, 'dsh-delete.trash')
assert.equal(iconRegistrations[0].component, primitives.IconTrashOutlineRegular)

// --- confirm → POST → toast ------------------------------------------------
const pendingRun = action.run()

const modal = renderOverlay()
assert.equal(modal.props.title, 'dshDelete.confirmTitle')
assert.equal(modal.props.description, 'dshDelete.confirmDesc')
assert.equal(modal.props.open, true)
// No session-title line inside the dialog.
assert.equal(modal.children.length, 0)

const [cancelButton, confirmButton] = footerButtons(modal)
assert.equal(cancelButton.props.variant, 'outline')
assert.equal(cancelButton.props.className, undefined)
assert.equal(confirmButton.props.variant, 'outline')
assert.equal(confirmButton.props.className, 'dsh-delete-danger')

confirmButton.props.onClick()
await pendingRun

assert.equal(requests.length, 1)
assert.equal(requests[0].url, '/dsh-delete/delete')
assert.equal(requests[0].init.method, 'POST')
assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: ARCHIVED })
assert.deepEqual(notifications, [{ text: 'dshDelete.done', success: true }])

// A dismissed dialog must not reach the Host.
const dismissedRun = action.run()
const dismissedModal = renderOverlay()
const [dismissButton] = footerButtons(dismissedModal)
dismissButton.props.onClick()
await dismissedRun
assert.equal(requests.length, 1)

// A refused deletion surfaces the Host's own reason.
globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  async json() { return { ok: false, message: '只有已归档的对话才能删除，请先归档' } },
})
const refusedRun = action.run()
footerButtons(renderOverlay())[1].props.onClick()
await refusedRun
assert.equal(notifications.length, 2)
assert.equal(notifications[1].success, false)
assert.match(notifications[1].text, /只有已归档的对话才能删除/)

// Network failure is reported, not swallowed.
globalThis.fetch = async () => { throw new Error('Failed to fetch') }
const failedRun = action.run()
footerButtons(renderOverlay())[1].props.onClick()
await failedRun
assert.equal(notifications.length, 3)
assert.match(notifications[2].text, /Failed to fetch/)

console.log('all client-half checks passed')
