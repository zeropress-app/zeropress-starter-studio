const THEME_KEY = "zeropress-theme";
const SEARCH_ADAPTER_URL = "/_zeropress/search.js";
const SEARCH_LIMIT = 8;

document.documentElement.classList.add("js");

let searchAdapterPromise = null;
let smoothScrollEnhanced = false;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function enableSmoothScrollAfterInitialNavigation() {
  if (smoothScrollEnhanced) {
    return;
  }

  smoothScrollEnhanced = true;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.documentElement.classList.add("is-scroll-enhanced");
    });
  });
}

function getStorage(type) {
  try {
    return window[type];
  } catch {
    return null;
  }
}

const themeStorage = getStorage("localStorage");

function normalizePath(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  try {
    themeStorage?.setItem(THEME_KEY, theme);
  } catch {
    // Theme persistence is optional, including when the storage quota is full.
  }

  const toggle = document.querySelector("[data-theme-toggle]");
  if (!toggle) {
    return;
  }

  toggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
}

function initThemeToggle() {
  let savedTheme = null;
  try {
    savedTheme = themeStorage?.getItem(THEME_KEY);
  } catch {
    // Use the system preference when storage cannot be read.
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : (prefersDark ? "dark" : "light"));

  const toggle = document.querySelector("[data-theme-toggle]");
  if (!toggle || toggle.dataset.themeToggleReady === "true") {
    return;
  }

  toggle.disabled = false;
  toggle.dataset.themeToggleReady = "true";
  toggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    setTheme(currentTheme === "dark" ? "light" : "dark");
  });
}

function createDateFormatter(options) {
  const styles = {};
  if (options.dateStyle && options.dateStyle !== "none") {
    styles.dateStyle = options.dateStyle;
  }
  if (options.timeStyle && options.timeStyle !== "none") {
    styles.timeStyle = options.timeStyle;
  }
  if (!Object.keys(styles).length) {
    return { format: () => "" };
  }

  if (!window.Intl || !Intl.DateTimeFormat) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat(undefined, styles);
  } catch {
    return null;
  }
}

const localDateFormatter = createDateFormatter({
  dateStyle: document.documentElement.dataset.zpDateStyle || "medium",
});

const localDateTimeFormatter = createDateFormatter({
  dateStyle: document.documentElement.dataset.zpDateStyle || "medium",
  timeStyle: document.documentElement.dataset.zpTimeStyle || "none",
});

function enhanceTimeElement(time, formatter) {
  if (!(time instanceof HTMLTimeElement) || !formatter) {
    return;
  }

  const value = time.getAttribute("datetime");
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return;
  }

  if (!time.getAttribute("title")) {
    time.setAttribute("title", value);
  }
  time.textContent = formatter.format(date);
}

function enhanceLocalTimes(root = document) {
  root.querySelectorAll("time[data-zp-local-date]").forEach((time) => {
    enhanceTimeElement(time, localDateFormatter);
  });

  root.querySelectorAll("time[data-zp-local-date-time]").forEach((time) => {
    enhanceTimeElement(time, localDateTimeFormatter);
  });
}

function updateFeaturedPosts(root = document) {
  root.querySelectorAll(".post-list--home").forEach((list) => {
    const items = Array.from(list.children).filter((item) =>
      item.matches(".post-item, .post-list-item")
    );

    items.forEach((item) => item.classList.remove("is-featured"));

    const firstVisible = items.find((item) => !item.hidden);
    if (firstVisible) {
      firstVisible.classList.add("is-featured");
    }
  });
}

function initNavigationState() {
  const currentPath = normalizePath(window.location.pathname);

  document.querySelectorAll(".site-nav a").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.includes(".xml")) {
      return;
    }

    const linkPath = normalizePath(new URL(href, window.location.origin).pathname);
    const isActive = linkPath === "/"
      ? currentPath === "/"
      : currentPath === linkPath || currentPath.startsWith(linkPath);

    link.classList.toggle("active", isActive);
  });
}

function initArticleContentLinks(root = document) {
  root.querySelectorAll(".article-content a[href]").forEach((link) => {
    if (link.dataset.articleLinkReady === "true") {
      return;
    }

    link.dataset.articleLinkReady = "true";

    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) {
      return;
    }

    const targetUrl = new URL(href, window.location.href);
    if (targetUrl.origin !== window.location.origin) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer noopener");
    }
  });
}

function initNewsletterIsland(root = document) {
  const modal = root.querySelector("[data-newsletter-modal]");
  const openButtons = Array.from(root.querySelectorAll("[data-newsletter-open]"))
    .filter((element) => element instanceof HTMLButtonElement);

  if (typeof HTMLDialogElement === "undefined" || !(modal instanceof HTMLDialogElement) || typeof modal.showModal !== "function" || openButtons.length === 0) {
    return;
  }

  if (modal.dataset.newsletterReady === "true") {
    return;
  }
  modal.dataset.newsletterReady = "true";

  const closeTargets = Array.from(modal.querySelectorAll("[data-newsletter-close]"));
  const closeButton = modal.querySelector(".newsletter-modal__close");
  let lastFocused = null;

  const openModal = (trigger) => {
    if (modal.open) return;
    lastFocused = trigger instanceof HTMLElement ? trigger : document.activeElement;
    modal.showModal();
    document.documentElement.classList.add("newsletter-modal-open");

    if (closeButton instanceof HTMLButtonElement) {
      closeButton.focus();
    }
  };

  const closeModal = () => {
    modal.close();
  };

  modal.addEventListener("close", () => {
    document.documentElement.classList.remove("newsletter-modal-open");

    if (lastFocused instanceof HTMLElement && lastFocused.isConnected) {
      lastFocused.focus({ preventScroll: true });
    }
    lastFocused = null;
  });

  openButtons.forEach((button) => {
    button.addEventListener("click", () => openModal(button));
  });

  closeTargets.forEach((target) => {
    target.addEventListener("click", closeModal);
  });

  // Keyboard events in an embedded page do not bubble to the parent dialog.
  const frame = modal.querySelector("iframe");
  const boundFrameDocuments = new WeakSet();
  const bindFrameKeyboard = () => {
    let frameDocument;
    try {
      frameDocument = frame?.contentDocument;
    } catch {
      return;
    }
    if (!frameDocument || boundFrameDocuments.has(frameDocument)) return;
    boundFrameDocuments.add(frameDocument);
    frameDocument.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !modal.open) return;
      if (frameDocument.querySelector("dialog[open]")) return;
      event.preventDefault();
      closeModal();
    });
  };
  frame?.addEventListener("load", bindFrameKeyboard);
  bindFrameKeyboard();

  document.documentElement.classList.add("newsletter-ready");
}

function loadSearchAdapter() {
  if (!searchAdapterPromise) {
    searchAdapterPromise = import(SEARCH_ADAPTER_URL);
  }

  return searchAdapterPromise;
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable
    || target.matches("input, textarea, select")
    || target.closest("[contenteditable='true']");
}

function announce(message) {
  const liveRegion = document.querySelector("[data-zp-status]");
  if (!liveRegion) {
    return;
  }

  liveRegion.textContent = "";
  window.setTimeout(() => {
    liveRegion.textContent = message;
  }, 20);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value) {
  if (!value) {
    return "";
  }

  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value);
  return textarea.value.trim();
}

function toPlainText(value) {
  if (!value) {
    return "";
  }

  const template = document.createElement("template");
  template.innerHTML = String(value);
  return (template.content.textContent || "").trim();
}

function getSearchExcerpt(row) {
  if (!row) {
    return "";
  }

  return decodeHtmlEntities(row.plain_excerpt) || toPlainText(row.excerpt) || "";
}

function tokenizeSearchQuery(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
}

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter((term) => {
    if (seen.has(term)) {
      return false;
    }

    seen.add(term);
    return true;
  });
}

function highlightMatches(text, terms) {
  if (!text || !terms.length) {
    return escapeHtml(text || "");
  }

  const sorted = terms.slice().sort((left, right) => right.length - left.length);
  const pattern = sorted.map(escapeRegExp).join("|");
  return escapeHtml(text).replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

function buildSearchResultUrl(url, query) {
  if (!url || url === "#") {
    return url || "#";
  }

  try {
    const next = new URL(url, window.location.origin);
    if (next.origin !== window.location.origin) {
      return url;
    }

    next.searchParams.set("q", query);
    return `${next.pathname}${next.search}${next.hash}`;
  } catch {
    return url;
  }
}

function shouldSkipSearchHighlight(node) {
  const parent = node?.parentElement;
  if (!parent) {
    return true;
  }

  return Boolean(parent.closest([
    "script",
    "style",
    "textarea",
    "input",
    "button",
    "select",
    "pre",
    ".heading-anchor",
    ".cmdk",
    ".site-header",
    ".site-footer",
    ".post-toc-aside",
    ".comments-block",
    ".newsletter-modal",
    ".floating-actions",
  ].join(",")));
}

function clearSearchHighlights() {
  document.querySelectorAll("[data-search-hit]").forEach((mark) => {
    const text = document.createTextNode(mark.textContent || "");
    const parent = mark.parentNode;
    mark.replaceWith(text);
    if (parent?.normalize) {
      parent.normalize();
    }
  });

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Highlight cleanup can still complete if URL mutation fails.
  }

  const clearButton = document.querySelector("[data-clear-search-highlights]");
  if (clearButton instanceof HTMLButtonElement) {
    clearButton.hidden = true;
  }

  announce("Search highlights cleared.");
}

function highlightSearchLanding() {
  let query = "";
  try {
    query = new URLSearchParams(window.location.search).get("q") || "";
  } catch {
    query = "";
  }

  const terms = uniqueTerms(tokenizeSearchQuery(query));
  if (!terms.length) {
    return false;
  }

  const root = document.querySelector("[data-pagefind-body]") || document.querySelector(".article-content");
  if (!root) {
    return false;
  }

  const sorted = terms.slice().sort((left, right) => right.length - left.length);
  const regex = new RegExp(`(${sorted.map(escapeRegExp).join("|")})`, "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node = walker.nextNode();

  while (node) {
    if (node.nodeValue?.trim() && !shouldSkipSearchHighlight(node) && regex.test(node.nodeValue)) {
      nodes.push(node);
    }
    regex.lastIndex = 0;
    node = walker.nextNode();
  }

  let firstHit = null;
  let hitCount = 0;
  const maxHits = 50;

  nodes.forEach((textNode) => {
    if (hitCount >= maxHits) {
      return;
    }

    const text = textNode.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match = null;
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) && hitCount < maxHits) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.dataset.searchHit = "";
      mark.textContent = match[0];
      fragment.appendChild(mark);
      if (!firstHit) {
        firstHit = mark;
      }
      hitCount += 1;
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  });

  if (!firstHit) {
    return false;
  }

  firstHit.classList.add("is-current");
  const clearButton = document.querySelector("[data-clear-search-highlights]");
  if (clearButton instanceof HTMLButtonElement) {
    clearButton.hidden = false;
  }

  window.setTimeout(() => {
    firstHit.scrollIntoView({ block: "center", behavior: "auto" });
    enableSmoothScrollAfterInitialNavigation();
  }, 120);

  return true;
}

function initSearch(root = document) {
  const palette = document.querySelector("[data-cmdk]");
  if (!(palette instanceof HTMLElement) || palette.dataset.cmdkReady === "true") {
    return;
  }
  palette.dataset.cmdkReady = "true";

  const input = palette.querySelector("[data-cmdk-input]");
  const list = palette.querySelector("[data-cmdk-list]");
  const empty = palette.querySelector("[data-cmdk-empty]");
  if (!(input instanceof HTMLInputElement) || !(list instanceof HTMLElement) || !(empty instanceof HTMLElement)) {
    return;
  }

  document.querySelectorAll("[data-cmdk-open]").forEach((button) => {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.removeAttribute("aria-disabled");
    }
  });

  const clearButton = document.querySelector("[data-clear-search-highlights]");
  if (clearButton instanceof HTMLButtonElement) {
    clearButton.addEventListener("click", clearSearchHighlights);
  }

  if (!highlightSearchLanding()) {
    enableSmoothScrollAfterInitialNavigation();
  }

  let previousFocus = null;
  let renderTicket = 0;

  const focusableSelector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "textarea:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const setEmpty = (message) => {
    empty.textContent = message;
    empty.hidden = false;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  };

  const clearActive = () => {
    list.querySelectorAll("a").forEach((item) => {
      item.classList.remove("is-active");
      item.setAttribute("aria-selected", "false");
    });
    input.removeAttribute("aria-activedescendant");
  };

  const setActiveOption = (item) => {
    clearActive();
    if (!(item instanceof HTMLAnchorElement)) {
      return;
    }

    item.classList.add("is-active");
    item.setAttribute("aria-selected", "true");
    if (item.id) {
      input.setAttribute("aria-activedescendant", item.id);
    }
  };

  const renderResults = (results, terms, query) => {
    list.replaceChildren();
    let first = null;

    results.forEach((entry, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "presentation");

      const link = document.createElement("a");
      link.href = buildSearchResultUrl(entry.url, query);
      link.className = "cmdk__result";
      link.id = `cmdk-option-${index}`;
      link.setAttribute("role", "option");
      link.setAttribute("aria-selected", "false");

      const titleHtml = highlightMatches(entry.title, terms);
      const excerptHtml = entry.excerpt ? highlightMatches(entry.excerpt, terms) : "";
      link.innerHTML = `<span class="cmdk__result-title">${titleHtml}</span>`
        + (excerptHtml ? `<span class="cmdk__result-excerpt">${excerptHtml}</span>` : "");

      item.appendChild(link);
      list.appendChild(item);
      if (!first) {
        first = link;
      }
    });

    input.setAttribute("aria-expanded", results.length ? "true" : "false");
    if (first) {
      setActiveOption(first);
    }
  };

  const render = (query) => {
    const ticket = ++renderTicket;
    const normalizedQuery = String(query || "").trim();
    list.replaceChildren();

    if (!normalizedQuery) {
      setEmpty("Type to search.");
      return;
    }

    setEmpty("Searching...");
    const terms = tokenizeSearchQuery(normalizedQuery);

    loadSearchAdapter()
      .then((api) => api.search(normalizedQuery, { limit: SEARCH_LIMIT }))
      .then((searchResult) => {
        if (ticket !== renderTicket) {
          return null;
        }

        const rawResults = searchResult?.results || [];
        if (!rawResults.length) {
          list.replaceChildren();
          setEmpty("No matches.");
          return null;
        }

        return Promise.all(rawResults.map((result) => result.data())).then((rows) => {
          if (ticket !== renderTicket) {
            return;
          }

          const entries = rows.map((row) => {
            const url = row.url || "#";
            return {
              url,
              title: row.meta?.title || url,
              excerpt: getSearchExcerpt(row),
            };
          });

          empty.hidden = true;
          renderResults(entries, terms, normalizedQuery);
        });
      })
      .catch((error) => {
        if (ticket !== renderTicket) {
          return;
        }

        console.warn("[ZeroPress Search]", "Search is unavailable.", error);
        list.replaceChildren();
        setEmpty("Search index is unavailable.");
      });
  };

  const open = (prefill = "") => {
    document.dispatchEvent(new Event("zp:close-navigation"));
    if (palette.hidden) {
      previousFocus = document.activeElement;
    }

    palette.hidden = false;
    input.value = prefill;
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 10);
    render(prefill);
  };

  const close = () => {
    palette.hidden = true;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        previousFocus.focus();
      }
    }
    previousFocus = null;
  };

  const trapPaletteFocus = (event) => {
    const focusable = Array.from(palette.querySelectorAll(focusableSelector))
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);

    if (!focusable.length) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.querySelectorAll("[data-cmdk-open]").forEach((button) => {
    button.addEventListener("click", () => open());
  });

  palette.querySelectorAll("[data-cmdk-close]").forEach((element) => {
    element.addEventListener("click", close);
  });

  input.addEventListener("input", () => render(input.value));
  list.addEventListener("focusin", (event) => {
    const option = event.target.closest?.("a.cmdk__result");
    if (option && list.contains(option)) setActiveOption(option);
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]:not([data-mobile-nav-dialog])")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      palette.hidden ? open() : close();
      return;
    }

    if (!palette.hidden && event.key === "Tab") {
      trapPaletteFocus(event);
      return;
    }

    if (event.key === "Escape" && !palette.hidden) {
      close();
      return;
    }

    if (!palette.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const items = Array.from(list.querySelectorAll("a"));
      if (!items.length) {
        return;
      }

      let index = items.findIndex((item) => item.classList.contains("is-active"));
      index = event.key === "ArrowDown"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
      setActiveOption(items[index]);
      if (list.contains(document.activeElement)) items[index].focus();
      items[index].scrollIntoView({ block: "nearest" });
      return;
    }

    if (!palette.hidden && event.key === "Enter" && event.target === input) {
      const active = list.querySelector("a.is-active");
      if (active instanceof HTMLAnchorElement) {
        event.preventDefault();
        window.location.href = active.href;
      }
      return;
    }

    if (palette.hidden && event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!isEditableTarget(event.target)) {
        event.preventDefault();
        open();
      }
    }
  });
}

function initBackToTop() {
  const button = document.querySelector("[data-back-to-top]");
  if (!(button instanceof HTMLButtonElement) || button.dataset.backToTopReady === "true") {
    return;
  }

  button.dataset.backToTopReady = "true";

  const update = () => {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
    button.style.setProperty("--scroll-progress-angle", `${(progress * 360).toFixed(1)}deg`);

    const visible = window.scrollY > 360;
    button.hidden = false;
    button.classList.toggle("is-visible", visible);
    button.setAttribute("aria-hidden", visible ? "false" : "true");
    button.tabIndex = visible ? 0 : -1;
  };

  button.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  });

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

function applyPageEnhancements(root = document) {
  enhanceLocalTimes(root);
  updateFeaturedPosts(root);
  initArticleContentLinks(root);
  initNewsletterIsland(root);
  initSearch(root);
  initBackToTop();
  initNavigationState();
}

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  applyPageEnhancements(document);
});
