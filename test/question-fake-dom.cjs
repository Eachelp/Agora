"use strict";

// 질문 카드 시험용 최소 DOM. 카드가 쓰는 만큼만 흉내 낸다: 요소 만들기, 자식 붙이기·끼우기·떼기, 속성,
// 이벤트, 라디오·체크박스의 클릭 동작. 진짜 브라우저와 다른 점은 레이아웃·초점이 없다는 것뿐이다.
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.name = "";
    this.title = "";
    this.placeholder = "";
    this.maxLength = -1;
    this.own = "";
    this.moves = 0; // 이 요소가 부모 안에서 다시 끼워진 횟수(출렁임 시험용)
  }

  get textContent() {
    return this.own + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.own = String(value);
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  insertBefore(node, reference) {
    if (node.parent === this) node.moves += 1;
    node.remove();
    node.parent = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  dispatch(type, event = {}) {
    const payload = { type, target: this, preventDefault() { payload.prevented = true; }, ...event };
    for (const handler of this.listeners[type] || []) handler(payload);
    return payload;
  }

  // 사용자가 누른 것처럼: 꺼진 요소는 반응하지 않고, 라디오·체크박스는 상태를 바꾼 뒤 change를 낸다.
  click() {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && this.type === "radio") {
      if (this.checked) return;
      this.root().findAll((node) => node.tagName === "INPUT" && node.type === "radio" && node.name === this.name)
        .forEach((node) => { node.checked = false; });
      this.checked = true;
      this.dispatch("change");
      return;
    }
    if (this.tagName === "INPUT" && this.type === "checkbox") {
      this.checked = !this.checked;
      this.dispatch("change");
      return;
    }
    this.dispatch("click");
  }

  // 사용자가 글을 쓴 것처럼.
  type_(text) {
    this.value = text;
    this.dispatch("input");
  }

  root() {
    let node = this;
    while (node.parent) node = node.parent;
    return node;
  }

  findAll(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.findAll(predicate, found);
    }
    return found;
  }

  find(predicate) { return this.findAll(predicate)[0] || null; }
  byClass(name) { return this.findAll((node) => node.className.split(/\s+/).includes(name)); }
}

function makeDocument() {
  return {
    createElement: (tag) => new FakeNode(tag),
    // 카드는 문서에 이벤트를 걸지 않는다. 걸면 시험이 실패한다(남는 리스너가 없어야 한다).
    addEventListener() { throw new Error("카드가 document에 리스너를 걸면 안 됩니다"); },
  };
}

module.exports = { FakeNode, makeDocument };
