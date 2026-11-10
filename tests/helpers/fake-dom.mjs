export class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.lang = '';
    this.open = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.lastSelection = undefined;
    this.children = [];
    this.replaceChildrenCount = 0;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    if (!this.hidden) globalThis.document.activeElement = this;
  }

  setSelectionRange(start, end) {
    this.lastSelection = { start, end };
  }

  replaceChildren(...children) {
    this.children = children;
    this.replaceChildrenCount++;
    this.textContent = children.map(child => child.textContent ?? '').join('');
    for (const child of children) {
      child.parentElement = this;
    }
  }
}

class FakeTextNode {
  constructor(data) {
    this.data = data;
    this.parentElement = undefined;
  }

  get textContent() {
    return this.data;
  }

  appendData(data) {
    this.data += data;
    if (this.parentElement) this.parentElement.textContent += data;
  }
}

export function createFakeDocument(ids) {
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  return {
    activeElement: undefined,
    createTextNode(data) {
      return new FakeTextNode(data);
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
  };
}

export async function withFakeDom(document, callback, { clipboard } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: clipboard ? { clipboard } : {},
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: callback => callback(),
  });

  try {
    await callback();
  } finally {
    restoreGlobal('document', previousDocument);
    restoreGlobal('navigator', previousNavigator);
    restoreGlobal('requestAnimationFrame', previousAnimationFrame);
  }
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function flushTasks() {
  await new Promise(resolve => setImmediate(resolve));
}
