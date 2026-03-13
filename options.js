document.getElementById("save").addEventListener("click", function () {
  var token = document.getElementById("token").value.trim();
  // Route through background script to ensure storage is written in the right context.
  chrome.runtime.sendMessage({ type: "save-token", token: token }, function (resp) {
    var status = document.getElementById("status");
    if (resp && resp.ok) {
      status.textContent = "Saved!";
    } else {
      status.textContent = "Error saving token.";
    }
    setTimeout(function () { status.textContent = ""; }, 2000);
  });
});

// Load existing token from background script.
chrome.runtime.sendMessage({ type: "get-token" }, function (resp) {
  if (resp && resp.token) {
    document.getElementById("token").value = resp.token;
  }
});
