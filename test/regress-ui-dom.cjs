"use strict";

// 렌더러 조각(chat.js)을 vm에서 돌리는 회귀 시험용 최소 DOM. question-fake-dom의 요소에
// classList 전체, 형제 탐색, 클래스 선택자 조회만 덧붙였다.
const { FakeNode } = require("./question-fake-dom.cjs");

class UiNode extends FakeNode {
  constructor(tag) {
    super(tag);
    this.rootMark = false;
    this.rows = 0;
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(" "); };
    return {
      add: (...add) => set([...new Set([...names(), ...add])]),
      remove: (...gone) => set(names().filter((name) => !gone.includes(name))),
      contains: (name) => names().includes(name),
      toggle: (name, force) => {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        set(on ? [...new Set([...names(), name])] : names().filter((n) => n !== name));
        return on;
      },
    };
  }

  get isConnected() { return this.root().rootMark === true; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get previousElementSibling() {
    if (!this.parent) return null;
    return this.parent.children[this.parent.children.indexOf(this) - 1] || null;
  }

  before(node) { this.parent.insertBefore(node, this); }
  focus() {}
  scrollIntoView() {}

  querySelectorAll(selector) {
    const name = selector.replace(/^\./, "");
    return this.findAll((node) => node.className.split(/\s+/).includes(name));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function makeUiDocument() {
  return {
    createElement: (tag) => new UiNode(tag),
    createTextNode: (text) => { const node = new UiNode("#text"); node.own = String(text); return node; },
  };
}

module.exports = { UiNode, makeUiDocument };
