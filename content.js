(function () {
  "use strict";

  let overlay = null;
  let selectedIndex = 0;
  let allItems = [];
  let sectionRanges = [];
  let rawSections = [];
  let pendingReopen = false;
  let lastUrl = window.location.href;
  let lastError = "";

  var REOPEN_KEY = "gbn-reopen";

  document.addEventListener("keydown", onKeyDown, true);

  if (sessionStorage.getItem(REOPEN_KEY)) {
    sessionStorage.removeItem(REOPEN_KEY);
    waitForPageReady(function () { open(); });
  }

  // Watch for SPA navigation (GitHub uses Turbo).
  setInterval(function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (pendingReopen) {
        pendingReopen = false;
        sessionStorage.removeItem(REOPEN_KEY);
        waitForPageReady(function () { open(); });
      }
    }
  }, 100);

  // Turbo fires this event after client-side navigation completes.
  document.addEventListener("turbo:load", function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (pendingReopen) {
        pendingReopen = false;
        sessionStorage.removeItem(REOPEN_KEY);
        waitForPageReady(function () { open(); });
      }
    }
  });

  function waitForPageReady(cb) {
    var attempts = 0;
    var check = setInterval(function () {
      attempts++;
      if (document.querySelector("main") || attempts > 30) {
        clearInterval(check);
        setTimeout(cb, 150);
      }
    }, 100);
  }

  // ── URL Parsing ────────────────────────────────────────────────────

  function parseGitHubUrl() {
    var parts = window.location.pathname.split("/").filter(Boolean);

    if (parts.length < 2) return { context: "top" };

    var systemPaths = [
      "settings", "explore", "notifications", "new", "organizations",
      "login", "signup", "search", "marketplace", "sponsors", "features",
      "pricing", "enterprise", "topics", "trending", "collections",
      "events", "about", "codespaces", "discussions", "orgs", "users",
      "stars", "watching", "dashboard", "account", "sessions"
    ];
    if (systemPaths.includes(parts[0])) return { context: "top" };

    var owner = parts[0];
    var repo = parts[1];
    var branch = null;
    var dirPath = "";

    if ((parts[2] === "tree" || parts[2] === "blob") && parts.length >= 4) {
      branch = parts[3];
      dirPath = parts[2] === "tree"
        ? parts.slice(4).join("/")
        : parts.slice(4, -1).join("/"); // blob → parent directory
    }

    return { context: "repo", owner: owner, repo: repo, branch: branch, dirPath: dirPath };
  }

  // ── GitHub API ─────────────────────────────────────────────────────

  function apiCall(endpoint) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "github-api", endpoint: endpoint }, resolve);
    });
  }

  async function fetchRepos() {
    var result = await apiCall("/user/repos?per_page=100&sort=pushed&affiliation=owner");
    if (!result || result.error) {
      lastError = result ? result.error : "No response from background script";
      return [];
    }
    if (!Array.isArray(result.data)) {
      lastError = "Unexpected API response";
      return [];
    }
    return result.data.map(function (r) {
      return {
        type: "repo",
        title: r.name,
        href: "/" + r.full_name,
        isPrivate: r.private
      };
    });
  }

  async function fetchDefaultBranch(owner, repo) {
    var result = await apiCall("/repos/" + owner + "/" + repo);
    if (!result || result.error) {
      lastError = result ? result.error : "No response from background script";
      return "main";
    }
    return result.data.default_branch;
  }

  async function fetchContents(owner, repo, branch, dirPath) {
    var path = dirPath ? "/" + dirPath : "";
    var endpoint = "/repos/" + owner + "/" + repo + "/contents" + path + "?ref=" + branch;
    var result = await apiCall(endpoint);
    if (!result || result.error) {
      lastError = result ? result.error : "No response from background script";
      return [];
    }

    return result.data
      .sort(function (a, b) {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.name.localeCompare(b.name);
      })
      .map(function (item) {
        return {
          type: item.type === "dir" ? "directory" : "file",
          title: item.name,
          href: "/" + owner + "/" + repo + "/" +
            (item.type === "dir" ? "tree" : "blob") + "/" + branch + "/" + item.path
        };
      });
  }

  // ── Keyboard ───────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "b") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggle();
      return;
    }

    if (!overlay) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      activateSelection();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      // Always go back: activate the last parent/repos-root item in the list.
      for (var i = allItems.length - 1; i >= 0; i--) {
        if (allItems[i].type === "parent" || allItems[i].type === "repos-root") {
          activateIndex(i);
          break;
        }
      }
    } else if (e.key === "ArrowRight") {
      var selItem2 = allItems[selectedIndex];
      if (selItem2 && (selItem2.type === "directory" || selItem2.type === "repo")) {
        e.preventDefault();
        e.stopPropagation();
        activateSelection();
      }
    } else if (e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      jumpSection(1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      e.stopPropagation();
      jumpSection(-1);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────

  function navigate(item) {
    // "My Repositories" — reopen overlay in top-level mode without navigating.
    if (item.type === "repos-root") {
      close();
      // Defer to next tick so the DOM cleanup from close() finishes first.
      setTimeout(function () { open("top"); }, 0);
      return;
    }

    if (!item.href) return;

    // Reopen overlay after navigating to repos, directories, or parents — not files.
    pendingReopen = item.type !== "file";
    if (pendingReopen) sessionStorage.setItem(REOPEN_KEY, "1");
    close();

    // Click a temporary <a> so GitHub's Turbo can intercept for SPA navigation.
    var a = document.createElement("a");
    a.href = item.href;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Overlay ────────────────────────────────────────────────────────

  function toggle() {
    overlay ? close() : open();
  }

  async function open(forceContext) {
    if (overlay) return;

    // Show overlay immediately with loading state.
    var el = document.createElement("div");
    el.id = "gbn-overlay";
    el.innerHTML =
      '<div class="gbn-backdrop"></div>' +
      '<div class="gbn-modal">' +
        '<div class="gbn-search-wrap">' +
          '<input class="gbn-search" type="text" placeholder="Filter..." spellcheck="false">' +
        '</div>' +
        '<div class="gbn-list"><div class="gbn-loading">Loading\u2026</div></div>' +
        '<div class="gbn-hints">' +
          '<span class="gbn-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>' +
          '<span class="gbn-hint"><kbd>&crarr;</kbd> open</span>' +
          '<span class="gbn-hint"><kbd>&larr;</kbd> parent</span>' +
          '<span class="gbn-hint"><kbd>&rarr;</kbd> into</span>' +
          '<span class="gbn-hint"><kbd>PgUp</kbd><kbd>PgDn</kbd> section</span>' +
          '<span class="gbn-hint"><kbd>Esc</kbd> close</span>' +
        '</div>' +
      '</div>';

    el.querySelector(".gbn-backdrop").addEventListener("click", close);

    var input = el.querySelector(".gbn-search");
    input.addEventListener("input", function () {
      renderList(input.value.trim());
    });

    document.body.appendChild(el);
    overlay = el;
    input.focus();

    // Fetch data based on context (can be overridden to force "top" mode).
    var parsed = parseGitHubUrl();
    var context = forceContext || parsed.context;
    rawSections = [];

    try {
      if (context === "top") {
        var repos = await fetchRepos();
        if (repos.length) rawSections.push({ label: "Repositories", items: repos });
      } else {
        var branch = parsed.branch;
        if (!branch) {
          branch = await fetchDefaultBranch(parsed.owner, parsed.repo);
        }

        // Path section: "My Repositories" and, if in a subdirectory, the immediate parent.
        var parents = [];
        parents.push({ type: "repos-root", title: "My Repositories" });

        if (parsed.dirPath) {
          var pathParts = parsed.dirPath.split("/");
          var parentPath = pathParts.slice(0, -1).join("/");
          parents.push({
            type: "parent",
            title: pathParts.length > 1 ? pathParts[pathParts.length - 2] : parsed.owner + "/" + parsed.repo,
            href: parentPath
              ? "/" + parsed.owner + "/" + parsed.repo + "/tree/" + branch + "/" + parentPath
              : "/" + parsed.owner + "/" + parsed.repo
          });
        }

        var contents = await fetchContents(parsed.owner, parsed.repo, branch, parsed.dirPath);
        var dirs = contents.filter(function (c) { return c.type === "directory"; });
        var files = contents.filter(function (c) { return c.type === "file"; });

        if (parents.length) rawSections.push({ label: "Path", items: parents });
        if (dirs.length) rawSections.push({ label: "Directories", items: dirs });
        if (files.length) rawSections.push({ label: "Files", items: files });
      }
    } catch (err) {
      // Silently handle — empty sections will trigger the "no items" message.
    }

    if (!overlay) return; // User closed while loading.

    if (!rawSections.length) {
      var msg = lastError
        ? "Error: " + escapeHtml(lastError)
        : "No items found. Set your GitHub token in extension options.";
      overlay.querySelector(".gbn-list").innerHTML =
        '<div class="gbn-empty">' + msg + '</div>';
      lastError = "";
      return;
    }

    renderList("");
  }

  function renderList(filter) {
    if (!overlay) return;

    allItems = [];
    sectionRanges = [];

    var lowerFilter = filter.toLowerCase();
    var html = "";
    var globalIdx = 0;
    var lastParentIdx = -1;

    for (var s = 0; s < rawSections.length; s++) {
      var section = rawSections[s];
      var filtered = lowerFilter
        ? section.items.filter(function (it) {
            return it.title.toLowerCase().includes(lowerFilter);
          })
        : section.items;

      if (!filtered.length) continue;

      var start = globalIdx;
      html += '<div class="gbn-section-label">' + section.label + "</div>";

      for (var i = 0; i < filtered.length; i++) {
        var item = filtered[i];
        allItems.push(item);
        var icon = itemIcon(item);
        html +=
          '<div class="gbn-item" data-index="' + globalIdx + '">' +
          '<span class="gbn-item-icon">' + icon + "</span>" +
          '<span class="gbn-item-title">' + escapeHtml(item.title) + "</span>" +
          "</div>";
        globalIdx++;
      }

      sectionRanges.push({ start: start, end: globalIdx - 1, label: section.label });
      if (section.label === "Path") lastParentIdx = globalIdx - 1;
    }

    if (!allItems.length) {
      html = '<div class="gbn-empty">No matches</div>';
    }

    var list = overlay.querySelector(".gbn-list");
    list.innerHTML = html;

    // Default selection: closest parent (last in Path section), or first item.
    if (!filter && lastParentIdx >= 0) {
      selectedIndex = lastParentIdx;
    } else {
      selectedIndex = 0;
    }

    list.querySelectorAll(".gbn-item").forEach(function (node) {
      node.addEventListener("click", function () {
        activateIndex(parseInt(node.dataset.index));
      });
      node.addEventListener("mouseenter", function () {
        selectedIndex = parseInt(node.dataset.index);
        updateSelection();
      });
    });

    updateSelection();
    scrollSelectedIntoView();
  }

  function close() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      selectedIndex = 0;
      allItems = [];
      sectionRanges = [];
      rawSections = [];
    }
  }

  function moveSelection(delta) {
    if (!overlay || !allItems.length) return;
    selectedIndex = (selectedIndex + delta + allItems.length) % allItems.length;
    updateSelection();
    scrollSelectedIntoView();
  }

  function updateSelection() {
    if (!overlay) return;
    overlay.querySelectorAll(".gbn-item").forEach(function (el) {
      el.classList.toggle(
        "gbn-selected",
        parseInt(el.dataset.index) === selectedIndex
      );
    });
  }

  function jumpSection(delta) {
    if (!overlay || !sectionRanges.length) return;
    var curSection = 0;
    for (var i = 0; i < sectionRanges.length; i++) {
      if (selectedIndex >= sectionRanges[i].start && selectedIndex <= sectionRanges[i].end) {
        curSection = i;
        break;
      }
    }
    var next = curSection + delta;
    if (next < 0) next = sectionRanges.length - 1;
    if (next >= sectionRanges.length) next = 0;
    selectedIndex = sectionRanges[next].start;
    updateSelection();
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    if (!overlay) return;
    var sel = overlay.querySelector(".gbn-item.gbn-selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function activateSelection() {
    activateIndex(selectedIndex);
  }

  function activateIndex(index) {
    var item = allItems[index];
    if (item) navigate(item);
  }

  function itemIcon(item) {
    if (item.type === "repos-root") return "&#8592;"; // ←
    if (item.type === "parent") return "&#8592;";     // ←
    if (item.type === "repo") return "&#8594;";       // →
    if (item.type === "directory") return "&#8594;";   // →
    if (item.type === "file") return "&#183;";        // ·
    return "";
  }

  function escapeHtml(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }
})();
