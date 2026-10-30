// ==UserScript==
// @name         洛谷 PC 支持
// @namespace    local.luogu.partial-credit
// @version      1.0.0
// @description  所有测试点右上角显示得分；WA 且得分大于 0 时显示为 PC。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';

  const marker = 'lg-partial-credit';
  const scoreAttribute = 'data-lg-pc-score';
  const casesByRecord = new Map();
  const caseVersions = new Map();
  let revision = 0;
  let displayedRecordId;
  let lastContext = '';
  let scheduled = false;
  let activeBlock = null;
  const changedTooltipNodes = new WeakSet();
  // Intercept the page's existing dispatcher, including already-created hubs.
  // Never call the hub getter/constructor, registerHandler, heartbeat, or connect.
  let dispatcherAttached = false;
  function attachDispatcher(exports) {
    const prototype = exports?.DW?.prototype;
    const original = prototype?.dispatchEvent;
    if (typeof original !== 'function' || dispatcherAttached) return;
    prototype.dispatchEvent = function (...args) {
      const [channel, event, payload] = args;
      try {
        if (/^Record:\d+$/.test(channel) && ['welcome', 'message'].includes(event)) {
          receiveStatus(payload);
        }
      } catch {
      }
      // Preserve this, arguments, return value and exceptions of the page handler.
      return Reflect.apply(original, this, args);
    };
    dispatcherAttached = true;
  }

  const chunks = window.webpackChunk_luogu_columba = window.webpackChunk_luogu_columba || [];
  // Webpack processes queued runtime callbacks before starting the app.
  chunks.push([[`lg-pc-observer-${Date.now()}`], {}, require => {
    const factory = require.m?.[39539];
    if (typeof factory !== 'function') {
      return;
    }
    require.m[39539] = function (module, exports, runtime) {
      const result = Reflect.apply(factory, this, arguments);
      try { attachDispatcher(module.exports); }
      catch { /* Keep the original page runtime working if its internals change. */ }
      return result;
    };
    // If injected after module initialization, obtain its existing class exports
    // once the page has loaded. This does not instantiate a connection or load chunks.
    const attachAfterLoad = () => {
      if (dispatcherAttached) return;
      try { attachDispatcher(require(39539)); }
      catch { /* Keep the original page runtime working if its internals change. */ }
    };
    if (document.readyState === 'complete') attachAfterLoad();
    else window.addEventListener('load', attachAfterLoad, { once: true });
  }]);

  function updateTooltips() {
    for (const tooltip of document.querySelectorAll('.record-test-case-tooltip')) {
      const owner = tooltip.id
        ? [...document.querySelectorAll('.test-case[aria-describedby]')].find(block =>
          block.getAttribute('aria-describedby').split(/\s+/).includes(tooltip.id))
        : null;
      const partial = (owner || activeBlock)?.classList.contains(marker) || false;
      const walker = document.createTreeWalker(tooltip, 4 /* SHOW_TEXT */);
      let node;
      while ((node = walker.nextNode())) {
        if (partial && /^\s*Wrong Answer(?=[.,\s]|$)/.test(node.nodeValue)) {
          node.nodeValue = node.nodeValue.replace('Wrong Answer', 'Partially Correct');
          changedTooltipNodes.add(node);
        } else if (!partial && changedTooltipNodes.has(node)) {
          node.nodeValue = node.nodeValue.replace(/^([\s]*)Partially Correct/, '$1Wrong Answer');
          changedTooltipNodes.delete(node);
        }
      }
    }
  }

  function collect(record, snapshotRevision = null) {
    if (!record || record.id == null) return;
    const key = String(record.id);
    let cases = casesByRecord.get(key);
    if (!cases) casesByRecord.set(key, cases = new Map());
    let versions = caseVersions.get(key);
    if (!versions) caseVersions.set(key, versions = new Map());
    const subtasks = record.detail?.judgeResult?.subtasks;
    for (const subtask of Object.values(subtasks || {})) {
      if (!subtask || typeof subtask !== 'object') continue;
      for (const [caseKey, testCase] of Object.entries(subtask.testCases || {})) {
        if (!testCase || typeof testCase !== 'object') continue;
        const id = Number(testCase.id ?? caseKey);
        if (!Number.isInteger(id) || id < 0) continue;
        // A delayed detail response must not overwrite a newer live result.
        if (snapshotRevision !== null && (versions.get(id) || 0) > snapshotRevision) {
          continue;
        }
        const fields = Object.fromEntries(Object.entries(testCase).filter(([, value]) => value != null));
        cases.set(id, { ...cases.get(id), ...fields, id });
        versions.set(id, ++revision);
      }
    }
  }

  function renderedCase(block, id) {
    // Vue's current props include updates delivered through the shared WS worker.
    for (let component = block.__vueParentComponent; component; component = component.parent) {
      const testCase = component.props?.testCase;
      if (testCase && Number(testCase.id) === id) return testCase;
    }
    return null;
  }

  function update() {
    scheduled = false;
    const recordId = location.pathname.match(/^\/record\/(\d+)\/?$/)?.[1];
    if (recordId !== displayedRecordId) {
      displayedRecordId = recordId;
      activeBlock = null;
    }
    const context = document.getElementById('lentille-context')?.textContent;
    if (context && context !== lastContext) {
      try {
        const payload = JSON.parse(context);
        collect(payload.data?.record, 0);
        lastContext = context;
      } catch {
        // The JSON script may still be arriving while the document loads.
      }
    }
    if (!recordId) return;

    const cases = casesByRecord.get(recordId);
    if (!document.getElementById(`${marker}-style`) && document.head) {
      const style = document.createElement('style');
      style.id = `${marker}-style`;
      style.textContent = `
        .test-case.${marker} { background: #f0ad4e !important; }
        .test-case[${scoreAttribute}]::after {
          content: attr(${scoreAttribute});
          position: absolute;
          top: 0;
          right: 0;
          padding: 6px;
          font-size: .65em;
          text-align: right;
          white-space: nowrap;
          pointer-events: none;
          z-index: 2;
        }
      `;
      document.head.appendChild(style);
    }

    for (const block of document.querySelectorAll('.test-case')) {
      const idLabel = block.querySelector('.id');
      const number = idLabel?.textContent.trim().match(/^#(\d+)(?:\s+score\s+\S+)?$/);
      const label = block.querySelector('.content .status');
      if (!number) {
        continue;
      }
      const id = Number(number[1]) - 1;
      const cached = cases?.get(id);
      const rendered = renderedCase(block, id);
      const testCase = rendered
        ? { ...cached, ...Object.fromEntries(Object.entries(rendered).filter(([, value]) => value != null)) }
        : cached;
      const idText = `#${number[1]}`;
      if (idLabel.textContent !== idText) idLabel.textContent = idText;
      block.querySelector(`.${marker}-score`)?.remove();
      const scoreText = testCase?.score == null ? '—' : `+${testCase.score}`;
      if (block.getAttribute(scoreAttribute) !== scoreText) block.setAttribute(scoreAttribute, scoreText);
      if (!label) continue;
      const eligible = testCase?.status === 6 && testCase.score > 0;
      // Only replace WA (or a PC label already owned by this script).
      const replaceable = label.textContent.trim() === 'WA'
        || (block.classList.contains(marker) && label.textContent.trim() === 'PC');
      if (eligible && replaceable) {
        if (!block.classList.contains(marker)) block.classList.add(marker);
        if (label.textContent !== 'PC') label.textContent = 'PC';
      } else if (block.classList.contains(marker)) {
        block.classList.remove(marker);
        if (label.textContent.trim() === 'PC') label.textContent = 'WA';
      }
    }
    updateTooltips();
  }

  function receiveStatus(value, depth = 0) {
    if (depth > 8 || value == null) return;
    try {
      if (typeof value === 'string') {
        if (!value.includes('status_push')) return;
        receiveStatus(JSON.parse(value), depth + 1);
        return;
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const offset = 1 + bytes[0];
        if (bytes.length <= offset || ![1, 16].includes(bytes[offset])) return;
        const decoder = new TextDecoder();
        if (!/^Record:\d+$/.test(decoder.decode(bytes.subarray(1, offset)))) return;
        receiveStatus(decoder.decode(bytes.subarray(offset + 1)), depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      if (value.type === 'status_push' && value.record) {
        collect(value.record);
        if (String(value.record.id) === location.pathname.match(/^\/record\/(\d+)\/?$/)?.[1]) schedule();
        return;
      }
      // Comlink serializes shared-worker callbacks into argumentList/RAW values.
      for (const key of ['argumentList', 'value', 'data', 'payload']) {
        if (Object.hasOwn(value, key)) receiveStatus(value[key], depth + 1);
      }
      if (Array.isArray(value)) for (const item of value) receiveStatus(item, depth + 1);
    } catch {
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }

  function isRecordRequest(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && /^\/record\/\d+\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function readResponse(value, startedAt) {
    try {
      let payload = value;
      if (typeof value === 'string') {
        try {
          payload = JSON.parse(value);
        } catch {
          const html = new DOMParser().parseFromString(value, 'text/html');
          const context = html.getElementById('lentille-context')?.textContent;
          if (!context) return;
          payload = JSON.parse(context);
        }
      }
      const record = payload?.data?.record || payload?.currentData?.record || payload?.record;
      if (record) {
        collect(record, startedAt);
        schedule();
      }
    } catch {
    }
  }

  // Capture SPA navigation data even when the initial document was a problem page.
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (...args) {
      const startedAt = revision;
      const requestUrl = typeof args[0] === 'string' || args[0] instanceof URL
        ? args[0] : args[0]?.url;
      const result = Reflect.apply(nativeFetch, this, args);
      if (isRecordRequest(requestUrl)) {
        result.then(response => response.clone().text().then(body => {
          readResponse(body, startedAt);
        })).catch(() => {});
      }
      return result;
    };
  }

  const nativeOpen = window.XMLHttpRequest?.prototype.open;
  if (nativeOpen) {
    const observed = new WeakSet();
    const requests = new WeakMap();
    const nativeSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (...args) {
      const result = Reflect.apply(nativeOpen, this, args);
      requests.set(this, { url: args[1], startedAt: revision });
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener('load', () => {
          const request = requests.get(this);
          if (!request || !isRecordRequest(request.url)) return;
          try {
            let body = this.response;
            if (!this.responseType || this.responseType === 'text') body = this.responseText;
            else if (this.responseType === 'document') body = this.responseXML?.documentElement?.outerHTML;
            if (['json', '', 'text', 'document'].includes(this.responseType)) readResponse(body, request.startedAt);
          } catch {
          }
        });
      }
      return result;
    };
    window.XMLHttpRequest.prototype.send = function (...args) {
      const request = requests.get(this);
      if (request) request.startedAt = revision;
      return Reflect.apply(nativeSend, this, args);
    };
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      schedule();
      return result;
    };
  }

  // Observe the same live status messages used by the page; do not change them.
  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        socket.addEventListener('message', event => {
          if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
            event.data.arrayBuffer().then(data => {
              receiveStatus(data);
            }).catch(() => {});
          } else {
            receiveStatus(event.data);
          }
        });
        return socket;
      },
    });
  }

  const observedPorts = new WeakSet();
  function observePort(port) {
    if (!port || observedPorts.has(port)) return;
    observedPorts.add(port);
    port.addEventListener('message', event => {
      receiveStatus(event.data);
    });
  }
  for (const name of ['MessageChannel', 'SharedWorker']) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = new Proxy(Native, {
      construct(Target, args) {
        const instance = new Target(...args);
        observePort(instance.port);
        observePort(instance.port1);
        observePort(instance.port2);
        return instance;
      },
    });
  }

  new MutationObserver(schedule).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-describedby', 'class', scoreAttribute],
  });
  // Floating tooltips may be mounted outside the test-case block.
  for (const eventName of ['pointerover', 'focusin', 'touchstart']) {
    document.addEventListener(eventName, event => {
      const block = event.target.closest?.('.test-case');
      if (block) {
        activeBlock = block;
        schedule();
      }
    }, { capture: true, passive: true });
  }
  window.addEventListener('popstate', schedule);
  // Score-only prop updates need not change DOM text. Repair them without requests.
  window.setInterval(() => {
    if (!document.hidden && /^\/record\/\d+\/?$/.test(location.pathname)) schedule();
  }, 500);
  schedule();
})();
