(function () {
  "use strict";

  var script = document.currentScript;
  var baseUrl = script ? new URL(".", script.src) : new URL("/vibe-research/", window.location.origin);
  var statusUrl = new URL("update-status.json", baseUrl);

  function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function shortSha(value) {
    return /^[0-9a-f]{40}$/.test(value || "") ? value.slice(0, 7) : "未知";
  }

  function versionLabel(value) {
    var clean = text(value, "未知");
    return clean === "未知" || clean.charAt(0) === "v" ? clean : "v" + clean;
  }

  function render(status) {
    if (!status || status.available !== true || !status.latest) return;

    var latestSha = text(status.latest.commit, "unknown");
    try {
      if (window.sessionStorage.getItem("vibe-update-dismissed") === latestSha) return;
    } catch (_) {
      // 存储不可用时仍显示提醒。
    }

    var style = document.createElement("style");
    style.id = "vibe-update-notice-style";
    style.textContent = [
      "#vibe-update-notice{box-sizing:border-box;width:100%;border:0;border-bottom:1px solid hsl(var(--warning)/.42);background:hsl(var(--warning)/.11);color:hsl(var(--foreground));font-family:inherit}",
      "#vibe-update-notice .vu-inner{box-sizing:border-box;min-height:44px;max-width:1440px;margin:0 auto;padding:8px 14px;display:flex;align-items:center;gap:10px}",
      "#vibe-update-notice .vu-mark{display:grid;width:24px;height:24px;flex:0 0 24px;place-items:center;border-radius:50%;background:hsl(var(--warning)/.18);color:hsl(var(--warning));font-size:15px;font-weight:800}",
      "#vibe-update-notice .vu-copy{min-width:0;display:flex;align-items:baseline;gap:8px;flex:1}",
      "#vibe-update-notice strong{font-size:13px;white-space:nowrap}",
      "#vibe-update-notice .vu-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:hsl(var(--muted-foreground));font-size:12px}",
      "#vibe-update-notice .vu-link{flex:0 0 auto;color:hsl(var(--warning));font-size:12px;font-weight:700;text-decoration:none}",
      "#vibe-update-notice .vu-link:hover{text-decoration:underline}",
      "#vibe-update-notice .vu-close{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;border:0;background:transparent;color:hsl(var(--muted-foreground));font:20px/1 sans-serif;cursor:pointer}",
      "#vibe-update-notice .vu-close:hover{color:hsl(var(--foreground))}",
      "body.vibe-update-visible #root>div{height:calc(100vh - var(--vibe-update-height,44px))!important}",
      "@media(max-width:720px){#vibe-update-notice .vu-inner{align-items:flex-start;gap:8px;padding:8px 10px}#vibe-update-notice .vu-copy{display:block}#vibe-update-notice .vu-detail{display:block;margin-top:2px;white-space:normal;line-height:1.35}#vibe-update-notice .vu-link{margin-top:4px;white-space:nowrap}}"
    ].join("");

    var banner = document.createElement("aside");
    banner.id = "vibe-update-notice";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");

    var inner = document.createElement("div");
    inner.className = "vu-inner";

    var mark = document.createElement("span");
    mark.className = "vu-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↑";

    var copy = document.createElement("div");
    copy.className = "vu-copy";
    var title = document.createElement("strong");
    title.textContent = "发现代码更新";
    var detail = document.createElement("span");
    detail.className = "vu-detail";
    var ahead = Number.isInteger(status.ahead_by) && status.ahead_by > 0 ? " · " + status.ahead_by + " 个提交" : "";
    detail.textContent = "当前 " + versionLabel(status.current && status.current.version) + "，最新 " +
      versionLabel(status.latest.version) + ahead + " · " + shortSha(latestSha) + " " + text(status.latest.message, "上游代码已变化");
    copy.appendChild(title);
    copy.appendChild(detail);

    var link = document.createElement("a");
    link.className = "vu-link";
    link.href = text(status.compare_url, "https://github.com/simonlin1212/Vibe-Research/commits/main");
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "查看变更 ↗";

    var close = document.createElement("button");
    close.className = "vu-close";
    close.type = "button";
    close.title = "本次打开期间暂时关闭";
    close.setAttribute("aria-label", "暂时关闭更新提醒");
    close.textContent = "×";
    close.addEventListener("click", function () {
      try { window.sessionStorage.setItem("vibe-update-dismissed", latestSha); } catch (_) {}
      document.body.classList.remove("vibe-update-visible");
      banner.remove();
      style.remove();
    });

    inner.appendChild(mark);
    inner.appendChild(copy);
    inner.appendChild(link);
    inner.appendChild(close);
    banner.appendChild(inner);
    document.head.appendChild(style);
    document.body.insertBefore(banner, document.body.firstChild);
    document.body.classList.add("vibe-update-visible");

    function updateHeight() {
      document.body.style.setProperty("--vibe-update-height", banner.getBoundingClientRect().height + "px");
    }
    updateHeight();
    if (typeof ResizeObserver === "function") new ResizeObserver(updateHeight).observe(banner);
  }

  fetch(statusUrl, { cache: "no-store", credentials: "same-origin" })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(render)
    .catch(function () {
      // 更新检查失败不能影响研究工作台本身。
    });
})();
