import { getButtonPress, getDirection, getGamepadInfo } from "./gamepad_standardizer.esm.js";

const POLL_MS = 50;
const INITIAL_REPEAT_MS = 260;
const REPEAT_MS = 120;
const TRIGGER_THRESHOLD = 0.18;
const TRIGGER_REPEAT_FAST_MS = 85;
const TRIGGER_REPEAT_SLOW_MS = 240;
const LEFT_STICK_DEADZONE = 0.28;
const RIGHT_STICK_DEADZONE = 0.22;
const RADIAL_STICK_DEADZONE = 0.52;
const RADIAL_SUBACTION_DEADZONE = 0.42;
const SCROLL_STEP = 32;

const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
};

const RAW_BUTTON = {
  SHARE: [17, 18],
};

const state = new Map();
const infoCache = new Map();
let handyHeld = false;
let paneFocus = "main";
let sidebarIndex = -1;
let windowFocused = document.hasFocus();
let releaseFocusBridge = null;
const DEBUG_LOGGING = true;

function findHostBridge() {
  const visited = new Set();
  const stack = [window];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (
      typeof candidate.dispatchMessage === "function" &&
      typeof candidate.subscribe === "function"
    ) {
      return candidate;
    }

    for (const key of Object.keys(candidate)) {
      if (key === "window" || key === "self" || key === "globalThis") continue;
      let value;
      try {
        value = candidate[key];
      } catch {
        continue;
      }
      if (
        value &&
        (typeof value === "object" || typeof value === "function") &&
        !visited.has(value)
      ) {
        stack.push(value);
      }
    }
  }
  return null;
}

function setWindowFocused(focused, source = "unknown") {
  if (windowFocused === focused) return;
  windowFocused = focused;
  if (!focused) {
    setHandyHeld(false);
    closeRadial();
  }
  debugLog("window focus changed", { focused, source });
}

function installFocusBridge() {
  const bridge = findHostBridge();
  if (!bridge) {
    debugLog("focus bridge unavailable; using DOM focus fallback");
    return false;
  }

  debugLog("focus bridge discovered");
  try {
    bridge.dispatchMessage("electron-window-focus-request", {});
    releaseFocusBridge = bridge.subscribe("electron-window-focus-changed", (payload) => {
      setWindowFocused(!!payload?.isFocused, "electron-bridge");
    });
    return true;
  } catch (error) {
    console.warn("[riff-controller] failed to subscribe to electron focus bridge", error);
    releaseFocusBridge = null;
    return false;
  }
}

const RADIAL_MENU = [
  {
    id: "plane",
    label: "Plane",
    icon: "plane",
    actions: [
      {
        id: "plane-related",
        label: "Find Related Tickets",
        icon: "search",
        prompt:
          "Use Plane to find related tickets for the current task or thread. Summarize the strongest matches first, and if you need clarification ask me with a survey.",
      },
      {
        id: "plane-board",
        label: "Board",
        icon: "board",
        prompt:
          "Use Plane to show me the state of the current project's board. Group the result by status and call out what is blocked or in progress.",
      },
      {
        id: "plane-cycle",
        label: "Current Cycle",
        icon: "clock",
        prompt:
          "Use Plane to inspect the current cycle for this project and summarize the key deadlines, active issues, and risks.",
      },
      {
        id: "plane-issue",
        label: "Create Issue",
        icon: "plus",
        prompt:
          "Draft a new Plane issue for the current task. Ask me any missing fields with a survey before creating it.",
      },
    ],
  },
  {
    id: "search",
    label: "Search",
    icon: "search",
    actions: [
      {
        id: "search-current",
        label: "Search Current Topic",
        icon: "spark",
        prompt:
          "Use MrSearch to research the current topic or code problem. Return the most relevant hits and explain why they matter.",
      },
      {
        id: "search-repo",
        label: "Search Repo",
        icon: "code",
        prompt:
          "Search this repository for the current concept, symbol, or feature area and summarize the most relevant files.",
      },
      {
        id: "search-docs",
        label: "Search Docs",
        icon: "book",
        prompt:
          "Search the relevant docs for the current topic and summarize the answer with primary-source citations where possible.",
      },
    ],
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    icon: "book",
    actions: [
      {
        id: "deepwiki-ask",
        label: "Ask Question",
        icon: "help",
        prompt:
          "Use DeepWiki to answer a question about the current repository or dependency. If you need the exact question from me, ask with a survey.",
      },
      {
        id: "deepwiki-arch",
        label: "Architecture",
        icon: "map",
        prompt:
          "Use DeepWiki to explain the architecture of the current repository at a high level, then point to the most relevant modules.",
      },
      {
        id: "deepwiki-source",
        label: "Read Docs",
        icon: "file",
        prompt:
          "Use DeepWiki to read the most relevant docs or wiki sections for the current problem and summarize them succinctly.",
      },
    ],
  },
  {
    id: "codex-mcp",
    label: "Codex-MCP",
    icon: "bot",
    actions: [
      {
        id: "codex-work",
        label: "Work On This",
        icon: "bot",
        prompt:
          "Use codex-mcp to delegate the current task to Codex workers. Break it into concrete subtasks, then summarize the plan before executing.",
      },
      {
        id: "codex-agents",
        label: "View Active Agents",
        icon: "agents",
        prompt:
          "Use codex-mcp to list the currently active agents or jobs, and summarize what each is working on.",
      },
      {
        id: "codex-abort",
        label: "Abort",
        icon: "abort",
        prompt:
          "Use codex-mcp to identify active workers for this task and abort the ones that should stop. Confirm what was stopped and what remains.",
      },
    ],
  },
  {
    id: "session",
    label: "Session",
    icon: "spark",
    actions: [
      {
        id: "session-interrupt",
        label: "Interrupt",
        icon: "abort",
        prompt:
          "Interrupt the current work cleanly, summarize where you stopped, and ask me what to do next with a survey.",
      },
      {
        id: "session-thread",
        label: "New Thread",
        icon: "plus",
        prompt:
          "Start a fresh thread for a new task boundary. Ask me for the task title or objective with a survey before proceeding.",
      },
      {
        id: "session-resume",
        label: "Resume Context",
        icon: "history",
        prompt:
          "Help me resume the right thread or session for this work. Ask a survey if you need to narrow it down.",
      },
    ],
  },
  {
    id: "voice",
    label: "Voice",
    icon: "mic",
    actions: [
      {
        id: "voice-couch",
        label: "Couch Mode",
        icon: "controller",
        prompt:
          "Enter couch mode for this conversation. Use surveys at stopping points and keep responses optimized for controller navigation and voice.",
      },
      {
        id: "voice-handy",
        label: "Handy Status",
        icon: "mic",
        prompt:
          "Explain the current Handy push-to-talk setup for this environment and tell me whether anything is missing for hands-free use.",
      },
      {
        id: "voice-survey",
        label: "Survey Me",
        icon: "list",
        prompt:
          "Ask me the next high-value clarifying questions as a survey so I can answer from the controller.",
      },
    ],
  },
];

const radialState = {
  open: false,
  mainIndex: 0,
  actionIndex: 0,
  announced: "",
  root: null,
  status: null,
  mainRing: null,
  actionRing: null,
  center: null,
};

function debugLog(message, extra) {
  if (!DEBUG_LOGGING) return;
  if (extra === undefined) {
    console.info(`[riff-controller] ${message}`);
  } else {
    console.info(`[riff-controller] ${message}`, extra);
  }
}

function now() {
  return performance.now();
}

function pressEdge(key, pressed) {
  const entry = state.get(key) || { down: false, since: 0, nextRepeatAt: 0 };
  const t = now();
  let fire = false;

  if (pressed) {
    if (!entry.down) {
      entry.down = true;
      entry.since = t;
      entry.nextRepeatAt = t + INITIAL_REPEAT_MS;
      fire = true;
    } else if (t >= entry.nextRepeatAt) {
      entry.nextRepeatAt = t + REPEAT_MS;
      fire = true;
    }
  } else {
    entry.down = false;
    entry.since = 0;
    entry.nextRepeatAt = 0;
  }

  state.set(key, entry);
  return fire;
}

function analogValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  return value ? 1 : 0;
}

function analogRepeat(key, value, threshold = TRIGGER_THRESHOLD) {
  const entry = state.get(key) || { down: false, since: 0, nextRepeatAt: 0 };
  const t = now();
  const strength = Math.max(0, Math.min(1, analogValue(value)));
  const pressed = strength >= threshold;
  let fire = false;

  if (pressed) {
    const normalized = (strength - threshold) / (1 - threshold);
    const repeatMs = TRIGGER_REPEAT_SLOW_MS - (TRIGGER_REPEAT_SLOW_MS - TRIGGER_REPEAT_FAST_MS) * normalized;
    if (!entry.down) {
      entry.down = true;
      entry.since = t;
      entry.nextRepeatAt = t + repeatMs;
      fire = true;
    } else if (t >= entry.nextRepeatAt) {
      entry.nextRepeatAt = t + repeatMs;
      fire = true;
    }
  } else {
    entry.down = false;
    entry.since = 0;
    entry.nextRepeatAt = 0;
  }

  state.set(key, entry);
  return fire;
}

function visible(node) {
  if (!(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function focusElement(node) {
  if (!(node instanceof HTMLElement) || !visible(node)) return false;
  if (typeof node.scrollIntoView === "function") {
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  node.focus({ preventScroll: false });
  return document.activeElement === node;
}

function interactiveTarget(node) {
  if (!(node instanceof HTMLElement)) return null;
  const target = node.closest(
    [
      "a[href]",
      "button",
      "[role='tab']",
      "[role='button']",
      "[role='treeitem']",
      "[role='option']",
    ].join(","),
  );
  return target instanceof HTMLElement ? target : node;
}

function activateElement(node) {
  const target = interactiveTarget(node);
  if (!(target instanceof HTMLElement) || !visible(target)) return false;
  focusElement(target);

  if (typeof target.click === "function") {
    target.click();
    return true;
  }

  if (
    target instanceof HTMLAnchorElement ||
    target instanceof HTMLButtonElement ||
    ["button", "tab", "treeitem", "option"].includes(target.getAttribute("role") || "")
  ) {
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return true;
  }

  return true;
}

function samePath(href) {
  try {
    const url = new URL(href, window.location.href);
    return url.pathname === window.location.pathname;
  } catch {
    return false;
  }
}

function firstText(node) {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

function hasMeaningfulLabel(node) {
  if (!(node instanceof HTMLElement)) return false;
  const text = firstText(node);
  if (text.length >= 2) return true;
  const aria = (node.getAttribute("aria-label") || "").trim();
  return aria.length >= 2;
}

function isCommandLikeLabel(label) {
  return /^(new|create|add|upload|attach|import|open|pick|choose|browse)\b/i.test(label);
}

function isSidebarThreadCandidate(node) {
  if (!(node instanceof HTMLElement) || !visible(node)) return false;
  const target = interactiveTarget(node);
  if (!(target instanceof HTMLElement) || !visible(target)) return false;
  node = target;
  if (node.getAttribute("aria-disabled") === "true") return false;
  if ("disabled" in node && node.disabled) return false;
  if (node.getAttribute("aria-haspopup") === "dialog") return false;
  if (node.getAttribute("aria-expanded") && !hasMeaningfulLabel(node)) return false;
  if (node.getAttribute("role") === "tab") return false;
  if (node.closest("[role='tablist']")) return false;
  if (node.getAttribute("aria-controls")) return false;

  const text = firstText(node);
  if (!text || text.length > 160) return false;
  if (isCommandLikeLabel(text)) return false;

  const href = node instanceof HTMLAnchorElement ? node.getAttribute("href") || "" : "";
  const aria = (node.getAttribute("aria-label") || "").trim();
  if (aria && isCommandLikeLabel(aria)) return false;
  const attrBlob = [
    aria,
    node.getAttribute("data-testid") || "",
    node.getAttribute("data-state") || "",
    node.getAttribute("role") || "",
    node.className || "",
    href,
  ]
    .join(" ")
    .toLowerCase();

  const container = node.closest(
    [
      "[aria-label*='thread' i]",
      "[aria-label*='conversation' i]",
      "[data-testid*='thread' i]",
      "[data-testid*='conversation' i]",
      "[class*='thread']",
      "[class*='sidebar']",
      "[role='navigation']",
      "aside",
      "nav",
    ].join(","),
  );
  const containerBlob = (
    [
      container?.getAttribute?.("aria-label") || "",
      container?.getAttribute?.("data-testid") || "",
      container?.className || "",
      firstText(container || document.body).slice(0, 400),
    ].join(" ")
  ).toLowerCase();

  if (href) {
    if (
      href.startsWith("/local/") ||
      href.startsWith("/remote/") ||
      href.includes("/thread/") ||
      href.includes("/conversation/") ||
      href.includes("/chat/")
    ) {
      return true;
    }
  }

  return (
    attrBlob.includes("thread") ||
    attrBlob.includes("conversation") ||
    attrBlob.includes("resume") ||
    containerBlob.includes("threads") ||
    containerBlob.includes("conversations")
  );
}

function threadLinks() {
  const selectors = [
    "nav a[href^=\"/local/\"]",
    "nav a[href^=\"/remote/\"]",
    "a[href^=\"/local/\"]",
    "a[href^=\"/remote/\"]",
    "a[href*=\"/local/\"]",
    "a[href*=\"/remote/\"]",
    "aside a[href]",
    "aside button",
    "aside [role=\"button\"]",
    "aside [role=\"option\"]",
    "aside [role=\"treeitem\"]",
    "aside [tabindex]",
    "[role=\"navigation\"] a[href]",
    "[role=\"navigation\"] button",
    "[aria-label*=\"thread\" i] a[href]",
    "[aria-label*=\"thread\" i] button",
    "[aria-label*=\"conversation\" i] a[href]",
    "[aria-label*=\"conversation\" i] button",
    "[data-testid*=\"thread\" i] a[href]",
    "[data-testid*=\"thread\" i]",
    "[data-testid*=\"conversation\" i] a[href]",
    "[data-testid*=\"conversation\" i]",
  ];
  const seen = new Set();
  const links = [];

  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!(node instanceof HTMLElement) || !isSidebarThreadCandidate(node)) continue;
      const target = interactiveTarget(node);
      if (!(target instanceof HTMLElement)) continue;
      const key =
        target instanceof HTMLAnchorElement
          ? target.getAttribute("href") || firstText(target)
          : target.getAttribute("data-testid") || target.getAttribute("aria-label") || firstText(target);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      links.push(target);
    }
  }

  debugLog("thread candidates", {
    count: links.length,
    labels: links.slice(0, 12).map((node) => ({
      text: firstText(node),
      href: node.getAttribute("href") || "",
      ariaCurrent: node.getAttribute("aria-current"),
      ariaSelected: node.getAttribute("aria-selected"),
    })),
  });
  return links;
}

function cycleThreads(delta) {
  const links = threadLinks();
  if (links.length === 0) return false;

  let index = links.findIndex(
    (link) =>
      link.getAttribute("aria-current") === "page" ||
      link.getAttribute("aria-selected") === "true" ||
      (link instanceof HTMLAnchorElement && samePath(link.href)) ||
      link === document.activeElement,
  );

  if (index === -1) index = delta > 0 ? -1 : 0;

  const next = (index + delta + links.length) % links.length;
  sidebarIndex = next;
  paneFocus = "sidebar";
  debugLog("cycleThreads", {
    delta,
    index,
    next,
    current: index >= 0 ? firstText(links[index]) : null,
    target: firstText(links[next]),
    href: links[next].getAttribute("href") || "",
  });
  const ok = activateElement(links[next]);
  debugLog("cycleThreads result", {
    ok,
    activeElement: document.activeElement instanceof HTMLElement ? firstText(document.activeElement) : null,
    pathname: window.location.pathname,
  });
  return ok;
}

function folderTabs() {
  const lists = Array.from(document.querySelectorAll("[role=\"tablist\"]")).filter(visible);
  for (const list of lists) {
    const tabs = Array.from(list.querySelectorAll("[role=\"tab\"],button"))
      .map((node) => interactiveTarget(node))
      .filter((node) => node instanceof HTMLElement && visible(node) && hasMeaningfulLabel(node));
    if (tabs.length >= 2 && tabs.length <= 8) return tabs;
  }

  return Array.from(
    document.querySelectorAll("button[aria-selected], [data-state=\"active\"], [data-state=\"inactive\"]"),
  )
    .map((node) => interactiveTarget(node))
    .filter((node) => node instanceof HTMLElement && visible(node) && hasMeaningfulLabel(node));
}

function cycleFolders(delta) {
  const tabs = folderTabs();
  if (tabs.length < 2) return false;

  let index = tabs.findIndex(
    (tab) =>
      tab.getAttribute("aria-selected") === "true" ||
      tab.getAttribute("data-state") === "active" ||
      tab.getAttribute("aria-current") === "page",
  );

  if (index === -1) {
    const focused = document.activeElement;
    index = focused ? tabs.indexOf(focused) : -1;
  }
  if (index === -1) index = 0;

  const next = (index + delta + tabs.length) % tabs.length;
  paneFocus = "sidebar";
  debugLog("cycleFolders", {
    delta,
    index,
    next,
    current: index >= 0 ? firstText(tabs[index]) : null,
    target: firstText(tabs[next]),
  });
  const ok = activateElement(tabs[next]);
  debugLog("cycleFolders result", { ok });
  return ok;
}

function sidebarTarget() {
  const links = threadLinks();
  const activeIndex = links.findIndex(
    (link) =>
      link.getAttribute("aria-current") === "page" ||
      link.getAttribute("aria-selected") === "true" ||
      (link instanceof HTMLAnchorElement && samePath(link.href)) ||
      link === document.activeElement,
  );
  if (activeIndex !== -1) {
    sidebarIndex = activeIndex;
    return links[activeIndex];
  }
  if (sidebarIndex >= 0 && sidebarIndex < links.length) return links[sidebarIndex];
  sidebarIndex = links.length > 0 ? 0 : -1;
  return links[0] || null;
}

function mainTarget() {
  const selectors = [
    "textarea",
    "input:not([type='hidden'])",
    "[contenteditable='true']",
    "[role='textbox']",
    "[data-lexical-editor='true']",
    "main [tabindex]",
    "main button",
  ];

  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (node instanceof HTMLElement && visible(node)) return node;
    }
  }

  const main = document.querySelector("main");
  return main instanceof HTMLElement ? main : document.body;
}

function focusSidebarPane() {
  const target = sidebarTarget();
  if (!target) return false;
  paneFocus = "sidebar";
  return focusElement(target);
}

function focusMainPane() {
  paneFocus = "main";
  return focusElement(mainTarget());
}

function moveSidebarSelection(delta, activate = false) {
  const links = threadLinks();
  if (links.length === 0) return false;

  const current = sidebarTarget();
  let index = current ? links.indexOf(current) : -1;
  if (index === -1) index = delta > 0 ? -1 : 0;

  const next = (index + delta + links.length) % links.length;
  sidebarIndex = next;
  paneFocus = "sidebar";
  debugLog("moveSidebarSelection", {
    delta,
    activate,
    index,
    next,
    target: firstText(links[next]),
    href: links[next].getAttribute("href") || "",
  });
  return activate ? activateElement(links[next]) : focusElement(links[next]);
}

function activateSidebarSelection() {
  const target = sidebarTarget();
  debugLog("activateSidebarSelection", {
    hasTarget: !!target,
    target: target ? firstText(target) : null,
    href: target?.getAttribute("href") || "",
  });
  return target ? activateElement(target) : false;
}

function sidebarFocused() {
  return paneFocus === "sidebar";
}

function keyboardTarget() {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body;
}

function dispatchKeyboardEvent(type, options) {
  keyboardTarget().dispatchEvent(
    new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}

function dispatchKey(key) {
  const target = keyboardTarget();
  for (const type of ["keydown", "keyup"]) {
    target.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

function setHandyHeld(held) {
  if (held === handyHeld) return;

  if (held) {
    dispatchKeyboardEvent("keydown", {
      key: "Control",
      code: "ControlLeft",
      ctrlKey: true,
    });
    dispatchKeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });
  } else {
    dispatchKeyboardEvent("keyup", {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });
    dispatchKeyboardEvent("keyup", {
      key: "Control",
      code: "ControlLeft",
      ctrlKey: false,
    });
  }

  handyHeld = held;
}

function scrollContainer(axis) {
  let node = document.activeElement instanceof Element ? document.activeElement : document.body;
  while (node && node !== document.body) {
    if (!(node instanceof HTMLElement)) break;
    const canScrollY = node.scrollHeight > node.clientHeight + 8;
    const canScrollX = node.scrollWidth > node.clientWidth + 8;
    if ((axis === "y" && canScrollY) || (axis === "x" && canScrollX)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function prepareScrollSurface(target) {
  if (!(target instanceof HTMLElement)) return;
  target.style.willChange = "scroll-position";
  target.style.backfaceVisibility = "hidden";
  target.style.contain = "paint";
  target.style.overflowAnchor = "none";
}

function forceRepaint(node) {
  if (!(node instanceof HTMLElement)) return;
  node.style.transform = "translateZ(0)";
  requestAnimationFrame(() => {
    node.style.transform = "";
  });
}

function sidebarScrollContainer() {
  const target = sidebarTarget();
  if (!(target instanceof HTMLElement)) return null;
  let node = target.parentElement;
  while (node && node !== document.body) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 8) return node;
    node = node.parentElement;
  }
  return null;
}

function scrollByAnalog(y) {
  const dy = Math.abs(y) >= RIGHT_STICK_DEADZONE ? y * SCROLL_STEP : 0;
  if (dy === 0) return;
  if (sidebarFocused()) {
    const sidebar = sidebarScrollContainer();
    if (sidebar instanceof HTMLElement) {
      prepareScrollSurface(sidebar);
      sidebar.scrollBy({ top: dy, behavior: "auto" });
      forceRepaint(sidebar);
      return;
    }
  }
  const target = scrollContainer("y");
  if (target === document.documentElement || target === document.body || target === document.scrollingElement) {
    window.scrollBy({ top: dy, behavior: "auto" });
  } else if (target instanceof HTMLElement) {
    prepareScrollSurface(target);
    target.scrollBy({ top: dy, behavior: "auto" });
    forceRepaint(target);
  }
}

function handleDirectionalInput(prefix, direction) {
  if (!direction) return;
  if (sidebarFocused()) {
    if (pressEdge(`${prefix}-up`, !!direction.up)) moveSidebarSelection(-1, false);
    if (pressEdge(`${prefix}-down`, !!direction.down)) moveSidebarSelection(1, false);
    if (pressEdge(`${prefix}-left`, !!direction.left)) cycleFolders(-1);
    if (pressEdge(`${prefix}-right`, !!direction.right)) cycleFolders(1);
    return;
  }
  if (pressEdge(`${prefix}-up`, !!direction.up)) dispatchKey("ArrowUp");
  if (pressEdge(`${prefix}-down`, !!direction.down)) dispatchKey("ArrowDown");
  if (pressEdge(`${prefix}-left`, !!direction.left)) dispatchKey("ArrowLeft");
  if (pressEdge(`${prefix}-right`, !!direction.right)) dispatchKey("ArrowRight");
}

function handleRightStickFocus(rightAnalog) {
  if (!rightAnalog) {
    pressEdge("right-pane-left", false);
    pressEdge("right-pane-right", false);
    return;
  }

  const x = rightAnalog.x || 0;
  if (pressEdge("right-pane-left", x <= -0.65)) focusSidebarPane();
  if (pressEdge("right-pane-right", x >= 0.65)) focusMainPane();
}

function buttonPressed(gamepad, indexes) {
  return indexes.some((index) => {
    const button = gamepad.buttons?.[index];
    return !!button && (button.pressed || button.value >= 0.5);
  });
}

function rawExtraPressedIndexes(gamepad) {
  const pressed = [];
  const buttons = gamepad.buttons || [];
  for (let index = 16; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (button && (button.pressed || button.value >= 0.5)) {
      pressed.push(index);
    }
  }
  return pressed;
}

function activeMenu() {
  return RADIAL_MENU[radialState.mainIndex] || RADIAL_MENU[0];
}

function activeAction() {
  const menu = activeMenu();
  return menu.actions[radialState.actionIndex] || menu.actions[0];
}

function ensureRadial() {
  if (radialState.root) return radialState.root;

  const style = document.createElement("style");
  style.textContent = `
    .riff-radial {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 2147483647;
      background:
        radial-gradient(circle at center, rgba(11, 20, 30, 0.26) 0, rgba(11, 20, 30, 0.5) 22%, rgba(6, 10, 14, 0.78) 100%);
      backdrop-filter: blur(16px) saturate(120%);
      color: #f6efe5;
      font-family: "Iosevka Term", "JetBrains Mono", "Fira Code", monospace;
    }
    .riff-radial.is-open {
      display: flex;
    }
    .riff-radial__stage {
      position: relative;
      width: min(78vmin, 920px);
      height: min(78vmin, 920px);
    }
    .riff-radial__ring {
      position: absolute;
      inset: 0;
    }
    .riff-radial__node {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 9.75rem;
      min-height: 7.75rem;
      transform: translate(-50%, -50%);
      border-radius: 1.55rem;
      border: 1px solid rgba(255, 236, 210, 0.16);
      background: linear-gradient(180deg, rgba(18, 24, 31, 0.94), rgba(10, 14, 19, 0.92));
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.38);
      display: grid;
      place-items: center;
      gap: 0.55rem;
      padding: 0.95rem;
      text-align: center;
      transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
    }
    .riff-radial__node[data-kind="action"] {
      width: 10.5rem;
      min-height: 8.5rem;
      border-radius: 1.65rem;
      background: linear-gradient(180deg, rgba(18, 30, 36, 0.95), rgba(8, 12, 16, 0.94));
    }
    .riff-radial__node.is-active {
      border-color: rgba(255, 204, 112, 0.86);
      background: linear-gradient(180deg, rgba(70, 46, 20, 0.98), rgba(18, 14, 10, 0.98));
      box-shadow: 0 0 0 1px rgba(255, 204, 112, 0.33), 0 22px 56px rgba(0, 0, 0, 0.52);
      transform: translate(-50%, -50%) scale(1.06);
    }
    .riff-radial__node.is-muted {
      opacity: 0.72;
    }
    .riff-radial__icon {
      width: 2rem;
      height: 2rem;
      color: #ffcf86;
    }
    .riff-radial__label {
      font-size: 0.95rem;
      font-weight: 600;
      line-height: 1.2;
      letter-spacing: 0.01em;
    }
    .riff-radial__center {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 16.5rem;
      min-height: 16.5rem;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background:
        radial-gradient(circle at 50% 35%, rgba(255, 213, 155, 0.24), rgba(58, 33, 17, 0.92) 55%, rgba(8, 10, 14, 0.98) 100%);
      border: 1px solid rgba(255, 220, 180, 0.18);
      box-shadow: 0 26px 80px rgba(0, 0, 0, 0.46);
      padding: 1.5rem;
      display: grid;
      gap: 0.8rem;
      align-content: center;
      text-align: center;
    }
    .riff-radial__kicker {
      font-size: 0.7rem;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: rgba(255, 214, 160, 0.7);
    }
    .riff-radial__title {
      font-size: 1.22rem;
      font-weight: 700;
      line-height: 1.2;
    }
    .riff-radial__subtitle {
      font-size: 0.95rem;
      line-height: 1.4;
      color: rgba(246, 239, 229, 0.8);
    }
    .riff-radial__hint {
      font-size: 0.78rem;
      line-height: 1.45;
      color: rgba(255, 230, 200, 0.72);
    }
    .riff-radial__status {
      position: absolute;
      bottom: 3.5vmin;
      left: 50%;
      transform: translateX(-50%);
      min-width: min(38rem, 80vw);
      text-align: center;
      font-size: 0.9rem;
      line-height: 1.4;
      color: rgba(255, 236, 210, 0.78);
      letter-spacing: 0.01em;
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "riff-radial";
  root.innerHTML = `
    <div class="riff-radial__stage">
      <div class="riff-radial__ring riff-radial__ring--main"></div>
      <div class="riff-radial__ring riff-radial__ring--actions"></div>
      <div class="riff-radial__center">
        <div class="riff-radial__kicker">Riff Couch Wheel</div>
        <div class="riff-radial__title"></div>
        <div class="riff-radial__subtitle"></div>
        <div class="riff-radial__hint">Hold Share, steer with the sticks, release Share or press A to execute.</div>
      </div>
      <div class="riff-radial__status"></div>
    </div>
  `;
  document.body.appendChild(root);

  radialState.root = root;
  radialState.mainRing = root.querySelector(".riff-radial__ring--main");
  radialState.actionRing = root.querySelector(".riff-radial__ring--actions");
  radialState.center = root.querySelector(".riff-radial__center");
  radialState.status = root.querySelector(".riff-radial__status");
  renderRadial();
  return root;
}

function iconSvg(name) {
  const common = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const icons = {
    plane: `<svg ${common}><path d="M6 4h12"/><path d="M4 9h16"/><path d="M8 14h8"/><path d="M10 19h4"/></svg>`,
    search: `<svg ${common}><circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/></svg>`,
    board: `<svg ${common}><path d="M4 5h16v11H4z"/><path d="M9 16v3"/><path d="M15 16v3"/><path d="M8 9h3"/><path d="M13 9h3"/></svg>`,
    clock: `<svg ${common}><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></svg>`,
    plus: `<svg ${common}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    spark: `<svg ${common}><path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8Z"/><path d="M19 4v2"/><path d="M20 5h-2"/></svg>`,
    code: `<svg ${common}><path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/></svg>`,
    book: `<svg ${common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 0 4 23V5.5Z"/><path d="M8 7h8"/></svg>`,
    help: `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.9.6-1.5 1.2-1.5 2"/><path d="M12 17h.01"/></svg>`,
    map: `<svg ${common}><path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14"/><path d="M15 6v14"/></svg>`,
    file: `<svg ${common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>`,
    bot: `<svg ${common}><rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4"/><path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M9 16h6"/></svg>`,
    agents: `<svg ${common}><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    abort: `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/><path d="M16 8l-8 8"/></svg>`,
    mic: `<svg ${common}><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>`,
    controller: `<svg ${common}><path d="M6 10h12a3 3 0 0 1 3 3v3l-4-2-2 2-2-2-2 2-2-2-4 2v-3a3 3 0 0 1 3-3Z"/><path d="M8 13h3"/><path d="M9.5 11.5v3"/><circle cx="16" cy="12.5" r=".5"/><circle cx="18" cy="14.5" r=".5"/></svg>`,
    list: `<svg ${common}><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`,
    history: `<svg ${common}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>`,
  };
  return icons[name] || icons.spark;
}

function positionNode(node, index, total, radius) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;
  node.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function renderRadial() {
  ensureRadial();
  const menu = activeMenu();
  const action = activeAction();

  radialState.mainRing.textContent = "";
  radialState.actionRing.textContent = "";

  RADIAL_MENU.forEach((entry, index) => {
    const node = document.createElement("div");
    node.className = `riff-radial__node${index === radialState.mainIndex ? " is-active" : " is-muted"}`;
    node.dataset.kind = "main";
    node.innerHTML = `${iconSvg(entry.icon)}<div class="riff-radial__label">${entry.label}</div>`;
    const icon = node.querySelector("svg");
    if (icon) icon.classList.add("riff-radial__icon");
    positionNode(node, index, RADIAL_MENU.length, 220);
    radialState.mainRing.appendChild(node);
  });

  menu.actions.forEach((entry, index) => {
    const node = document.createElement("div");
    node.className = `riff-radial__node${index === radialState.actionIndex ? " is-active" : ""}`;
    node.dataset.kind = "action";
    node.innerHTML = `${iconSvg(entry.icon)}<div class="riff-radial__label">${entry.label}</div>`;
    const icon = node.querySelector("svg");
    if (icon) icon.classList.add("riff-radial__icon");
    positionNode(node, index, menu.actions.length, 356);
    radialState.actionRing.appendChild(node);
  });

  const title = radialState.center.querySelector(".riff-radial__title");
  const subtitle = radialState.center.querySelector(".riff-radial__subtitle");
  if (title) title.textContent = `${menu.label} -> ${action.label}`;
  if (subtitle) subtitle.textContent = action.prompt;
  if (radialState.status) {
    radialState.status.textContent =
      radialState.announced || "Left stick selects a tool family. Right stick selects the action. Release Share to execute.";
  }
}

function setRadialStatus(text) {
  radialState.announced = text;
  if (radialState.status) radialState.status.textContent = text;
}

function openRadial() {
  ensureRadial();
  radialState.open = true;
  radialState.root.classList.add("is-open");
  radialState.mainIndex = 0;
  radialState.actionIndex = 0;
  setRadialStatus("Share held. Steer with the sticks. Press B to cancel.");
  renderRadial();
}

function closeRadial() {
  if (!radialState.open) return;
  radialState.open = false;
  radialState.root.classList.remove("is-open");
}

function chooseByAnalog(analog, items, prefix) {
  if (!analog) return null;
  const x = analog.x || 0;
  const y = analog.y || 0;
  const magnitude = Math.hypot(x, y);
  const threshold = prefix === "radial-action" ? RADIAL_SUBACTION_DEADZONE : RADIAL_STICK_DEADZONE;
  if (magnitude < threshold) {
    pressEdge(`${prefix}-release`, false);
    return null;
  }

  const angle = Math.atan2(y, x) + Math.PI / 2;
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
  return Math.floor((normalized / (Math.PI * 2)) * items.length) % items.length;
}

function updateRadialSelection(leftAnalog, rightAnalog, dpad) {
  const mainChoice = chooseByAnalog(leftAnalog, RADIAL_MENU, "radial-main");
  if (mainChoice !== null && mainChoice !== radialState.mainIndex) {
    radialState.mainIndex = mainChoice;
    radialState.actionIndex = 0;
    setRadialStatus(`Tool family: ${activeMenu().label}`);
    renderRadial();
  }

  const actions = activeMenu().actions;
  const actionChoice = chooseByAnalog(rightAnalog, actions, "radial-action");
  if (actionChoice !== null && actionChoice !== radialState.actionIndex) {
    radialState.actionIndex = actionChoice;
    setRadialStatus(`Action: ${activeAction().label}`);
    renderRadial();
  }

  if (!dpad) return;
  if (pressEdge("radial-dpad-left", !!dpad.left)) {
    radialState.mainIndex = (radialState.mainIndex - 1 + RADIAL_MENU.length) % RADIAL_MENU.length;
    radialState.actionIndex = 0;
    renderRadial();
  }
  if (pressEdge("radial-dpad-right", !!dpad.right)) {
    radialState.mainIndex = (radialState.mainIndex + 1) % RADIAL_MENU.length;
    radialState.actionIndex = 0;
    renderRadial();
  }
  if (pressEdge("radial-dpad-up", !!dpad.up)) {
    const count = activeMenu().actions.length;
    radialState.actionIndex = (radialState.actionIndex - 1 + count) % count;
    renderRadial();
  }
  if (pressEdge("radial-dpad-down", !!dpad.down)) {
    const count = activeMenu().actions.length;
    radialState.actionIndex = (radialState.actionIndex + 1) % count;
    renderRadial();
  }
}

function textEntryTarget() {
  const selectors = [
    "textarea",
    "main textarea",
    "input[type='text']",
    "[contenteditable='true']",
    "[role='textbox']",
    "[data-lexical-editor='true']",
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node instanceof HTMLElement && visible(node)) return node;
  }
  return null;
}

function setInputText(node, text) {
  if (!node) return false;

  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor?.set?.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  if (node.isContentEditable) {
    node.textContent = text;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return true;
  }

  return false;
}

function submitPrompt(prompt) {
  focusMainPane();
  const target = textEntryTarget();
  if (!target) {
    setRadialStatus("No visible composer found. Focus the main pane and try again.");
    return false;
  }

  focusElement(target);
  if (!setInputText(target, prompt)) {
    setRadialStatus("Could not inject the prompt into the composer.");
    return false;
  }

  setTimeout(() => {
    dispatchKey("Enter");
  }, 35);
  return true;
}

function executeRadialAction(source = "release") {
  const action = activeAction();
  if (!action) return false;

  const ok = submitPrompt(action.prompt);
  debugLog("radial execute", { source, menu: activeMenu().id, action: action.id, ok });
  if (ok) {
    setRadialStatus(`Sent: ${activeMenu().label} -> ${action.label}`);
    closeRadial();
  }
  return ok;
}

function rawSharePressed(gamepad) {
  const known = buttonPressed(gamepad, RAW_BUTTON.SHARE);
  if (known) return true;
  const extraPressed = rawExtraPressedIndexes(gamepad);
  for (const index of extraPressed) {
    if (pressEdge(`raw-extra-${index}`, true)) {
      debugLog("raw extra button pressed", { index });
    }
  }
  for (let index = 16; index < (gamepad.buttons?.length || 0); index += 1) {
    if (!extraPressed.includes(index)) {
      pressEdge(`raw-extra-${index}`, false);
    }
  }
  return extraPressed.length > 0;
}

async function getInfo(gamepad) {
  let cached = infoCache.get(gamepad.index);
  if (!cached) {
    cached = getGamepadInfo(gamepad).catch((error) => {
      console.warn("[riff-controller] failed to standardize gamepad", error);
      infoCache.delete(gamepad.index);
      return null;
    });
    infoCache.set(gamepad.index, cached);
  }
  return cached;
}

async function poll() {
  const activeWindowFocused = document.hasFocus() && document.visibilityState === "visible";
  if (!releaseFocusBridge && windowFocused !== activeWindowFocused) {
    setWindowFocused(activeWindowFocused, "dom");
  }

  if (!windowFocused) {
    setHandyHeld(false);
    closeRadial();
    return;
  }

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gamepad = Array.from(pads).find(Boolean);
  if (!gamepad) {
    setHandyHeld(false);
    closeRadial();
    return;
  }

  const info = await getInfo(gamepad);
  if (!info) return;

  const buttons = getButtonPress(gamepad, info, false);
  const direction = getDirection(gamepad, info, LEFT_STICK_DEADZONE);
  const sharePressed = rawSharePressed(gamepad);

  if (pressEdge("share-hold", sharePressed)) {
    debugLog("share pressed");
    openRadial();
  }

  if (radialState.open) {
    setHandyHeld(false);
    updateRadialSelection(direction.leftAnalog, direction.rightAnalog, direction.dpad);
    if (pressEdge("radial-a", !!buttons[BUTTON.A])) executeRadialAction("button-a");
    if (pressEdge("radial-b", !!buttons[BUTTON.B])) {
      setRadialStatus("Cancelled radial overlay.");
      closeRadial();
    }
    if (!sharePressed) {
      executeRadialAction("share-release");
    }
    return;
  }

  if (pressEdge("lb", !!buttons[BUTTON.LB])) {
    debugLog("LB pressed");
    cycleThreads(-1);
  }
  if (pressEdge("rb", !!buttons[BUTTON.RB])) {
    debugLog("RB pressed");
    cycleThreads(1);
  }
  if (analogRepeat("lt", buttons[BUTTON.LT])) {
    debugLog("LT fired", { value: analogValue(buttons[BUTTON.LT]) });
    cycleFolders(-1);
  }
  if (analogRepeat("rt", buttons[BUTTON.RT])) {
    debugLog("RT fired", { value: analogValue(buttons[BUTTON.RT]) });
    cycleFolders(1);
  }

  handleDirectionalInput("dpad", direction.dpad);
  handleDirectionalInput("left-stick", direction.leftAnalog);

  if (pressEdge("button-a", !!buttons[BUTTON.A])) {
    if (sidebarFocused()) {
      activateSidebarSelection();
    } else {
      dispatchKey("Enter");
    }
  }
  if (pressEdge("button-b", !!buttons[BUTTON.B])) dispatchKey("Escape");
  if (pressEdge("button-x", !!buttons[BUTTON.X])) dispatchKey(" ");
  if (pressEdge("button-y", !!buttons[BUTTON.Y])) dispatchKey("/");

  const rightAnalog = direction.rightAnalog;
  handleRightStickFocus(rightAnalog);
  if (rightAnalog) scrollByAnalog(rightAnalog.y || 0);

  const selectPressed = !!buttons[BUTTON.SELECT];
  pressEdge("select", selectPressed);
  setHandyHeld(selectPressed);
}

window.__riffController = {
  cycleThreads,
  cycleFolders,
  dispatchKey,
  moveSidebarSelection,
  activateSidebarSelection,
  focusSidebarPane,
  focusMainPane,
  infoCache,
  openRadial,
  closeRadial,
  executeRadialAction,
};

window.addEventListener("gamepadconnected", async (event) => {
  const info = await getInfo(event.gamepad);
  console.info("[riff-controller] connected", {
    id: event.gamepad?.id || "gamepad",
    mapping: info?.originInfo?.mapping || event.gamepad?.mapping || "unknown",
    vendor: info?.vendor || "unknown",
    product: info?.product || "unknown",
    buttons: event.gamepad?.buttons?.length || 0,
    extraButtonsStartAt: 10,
  });
});

window.addEventListener("gamepaddisconnected", (event) => {
  infoCache.delete(event.gamepad.index);
  setHandyHeld(false);
  closeRadial();
});

window.addEventListener("focus", () => {
  if (!releaseFocusBridge) setWindowFocused(true, "dom-focus");
});

window.addEventListener("blur", () => {
  if (!releaseFocusBridge) setWindowFocused(false, "dom-blur");
});

document.addEventListener("visibilitychange", () => {
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (!releaseFocusBridge) setWindowFocused(focused, "dom-visibility");
});

installFocusBridge();

setInterval(() => {
  void poll();
}, POLL_MS);
