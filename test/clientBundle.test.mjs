/**
 * Client bundle smoke test.
 *
 * 为什么需要：`lib/client.js` 是宿主用 `window.__ModuleLoader__.load({id, factory})` 装载的
 * 浏览器半区，项目里此前**没有任何测试覆盖它**——而历史上真出过事故（1.13.0：apply 里直接读
 * cordis 服务导致整个前端加载失败）。宿主升级（0.1.x → 0.2.x）时最先坏的也总是这一层：
 * bundle 形状、导出名、inject 列表、官方槽位注册。
 *
 * 本测试用最小 DOM/React 替身把 bundle 跑起来，断言：
 *   1) bundle 以正确的包 id 注册自己，factory 返回 {name, inject, apply}；
 *   2) inject 列表与 0.2.0 客户端服务名一致（少一个服务会让整个插件 pending）；
 *   3) apply 会在官方槽位 conversation.session.header.actions 上注册入口；
 *   4) apply 返回 disposer 且调用它不抛错。
 *
 * 它**不**验证渲染结果（那需要真实浏览器），只验证「能装、能注册、能卸载」这条底线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 极简 DOM 替身：只实现 bundle 在 apply 路径上用到的成员。 */
function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    isConnected: true,
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    type: '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) },
    removeEventListener() {},
    appendChild(child) { child.parentElement = this; this.children.push(child); return child },
    insertBefore(child) { child.parentElement = this; this.children.unshift(child); return child },
    remove() { this.isConnected = false; return this },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    contains(child) { return this.children.includes(child) },
    get firstElementChild() { return this.children[0] ?? null },
    get nextElementSibling() { return null },
  }
  return el
}

function installFakeGlobals() {
  const head = makeElement('head')
  const documentElement = makeElement('html')
  const body = makeElement('body')
  const document = {
    head,
    body,
    documentElement,
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail }
  }
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    CustomEvent: globalThis.CustomEvent,
  }
  globalThis.window = {}
  globalThis.document = document
  globalThis.MutationObserver = FakeMutationObserver
  globalThis.CustomEvent = FakeCustomEvent
  return {
    document,
    restore() {
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.MutationObserver = previous.MutationObserver
      globalThis.CustomEvent = previous.CustomEvent
    },
  }
}

/** 把 bundle 当作宿主脚本执行，捕获 __ModuleLoader__.load 的注册。 */
function loadBundle() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const win = globalThis.window
  win.__ModuleLoader__ = { load: (value) => { registration = value } }
  // 宿主脚本没有 import/export，只有一条顶层表达式；用 Function 在全局作用域里求值。
  new Function('window', code)(win)
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load({id, factory})')
  return registration
}

/** factory 的 require：react 家族走真实模块（bundle 内联的 react-dom 会读 React 内部字段），
 *  只有 react-dom/client 用替身，避免在没有真实 DOM 的情况下挂载。 */
function fakeRequire(specifier) {
  if (specifier === 'react-dom/client') {
    return { createRoot: () => ({ render() {}, unmount() {} }) }
  }
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
  throw new Error(`unexpected external require: ${specifier}`)
}

test('client bundle registers itself and wires the official header slot', () => {
  const env = installFakeGlobals()
  try {
    const registration = loadBundle()
    assert.equal(registration.id, '@guojing6/dsh-workbench', 'bundle id 必须是包名（宿主按包名解析模块行）')

    const mod = registration.factory(fakeRequire)
    assert.equal(mod.name, 'dsh-workbench-client')
    assert.equal(typeof mod.apply, 'function', 'client 半区必须导出 apply(ctx)')

    // 0.2.0 客户端服务名：缺任何一个都会让整个插件 pending（不是降级，是不加载）。
    assert.deepEqual(mod.inject, ['sessions', 'workspaces', 'connection', 'modelDirectories', 'remote.session'])

    const calls = { inject: [], register: [] }
    const slots = {
      inject: (name, callback) => { calls.inject.push(name); callback() },
      register: (options, component) => {
        calls.register.push({ options, component })
        return () => {}
      },
    }
    const ctx = {
      get: (name) => (name === 'slots' ? slots : undefined),
      logger: { info() {}, warn() {} },
    }

    const dispose = mod.apply(ctx)
    assert.equal(typeof dispose, 'function', 'apply 必须返回 disposer（宿主卸载插件时调用）')

    assert.deepEqual(calls.inject, ['conversation.session.header.actions'])
    assert.equal(calls.register.length, 1)
    const { options, component } = calls.register[0]
    assert.equal(options.name, 'conversation.session.header.actions')
    assert.equal(options.id, 'dsh-workbench')
    assert.equal(typeof options.order, 'number')
    assert.equal(typeof options.inject, 'function')
    assert.equal(typeof component, 'function')
    // 槽位组件通过 inject() 拿到工作台句柄（open/close/toggle/isOpen）。
    const api = options.inject()
    assert.deepEqual(Object.keys(api), ['workbench'])
    for (const method of ['open', 'close', 'toggle', 'isOpen']) {
      assert.equal(typeof api.workbench[method], 'function', `槽位句柄缺少 ${method}()`)
    }

    dispose()
    assert.equal(env.document.documentElement.getAttribute('data-dsh-workbench-active'), null)
  } finally {
    env.restore()
  }
})
