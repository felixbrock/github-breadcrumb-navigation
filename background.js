// In-memory token cache so we don't hit storage on every API call.
var cachedToken = null;

// Load token into cache on startup.
chrome.storage.local.get("github_token", function (data) {
  cachedToken = data.github_token || null;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === "github-api") {
    githubFetch(msg.endpoint).then(sendResponse);
    return true;
  }
  if (msg.type === "save-token") {
    cachedToken = msg.token || null;
    chrome.storage.local.set({ github_token: msg.token }, function () {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "get-token") {
    sendResponse({ token: cachedToken || "" });
    return false;
  }
});

async function githubFetch(endpoint) {
  var token = cachedToken;
  var headers = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = "token " + token;

  try {
    var resp = await fetch("https://api.github.com" + endpoint, { headers: headers });
    if (!resp.ok) return { error: resp.status + " " + resp.statusText };
    var json = await resp.json();
    return { data: json };
  } catch (e) {
    return { error: e.message };
  }
}
