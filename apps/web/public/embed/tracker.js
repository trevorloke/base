/*
 * Imagine Surrey promise tracker widget. No dependencies, no cookies.
 *
 *   <div id="imagine-surrey-tracker"></div>
 *   <script src="https://imaginesurrey.ca/embed/tracker.js"
 *           data-target="imagine-surrey-tracker"
 *           data-site="https://imaginesurrey.ca" defer></script>
 *
 * The script reads /api/promises/summary from data-site (or the site it was
 * loaded from) and draws a small scoreboard card inside the target element.
 * window.ImagineSurreyTracker.render(element, site) draws one on demand.
 */
(function () {
  "use strict";

  var NAVY = "#003979";
  var YELLOW = "#FFF100";
  var INK = "#0F1E33";
  var FONT = "Montserrat, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

  function el(tag, styles, text) {
    var node = document.createElement(tag);
    if (styles) node.setAttribute("style", styles);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatDate(iso) {
    if (!iso) return null;
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12));
    try {
      return d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    } catch (e) {
      return iso;
    }
  }

  function draw(target, data, site) {
    var trackerUrl = data.trackerUrl || site + "/tracker";
    var card = el(
      "section",
      "box-sizing:border-box;max-width:420px;padding:18px 20px;border:1px solid #E3E7EF;border-top:8px solid " +
        YELLOW +
        ";border-radius:10px;background:#fff;color:" +
        INK +
        ";font-family:" +
        FONT +
        ";font-size:15px;line-height:1.4;text-align:left",
    );
    card.setAttribute("data-tracker-card", "");
    card.setAttribute("aria-label", "Safe Surrey promise tracker scoreboard");

    var eyebrow = el("p", "margin:0 0 4px;font-size:12px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:" + NAVY, "Safe Surrey promise tracker");
    var heading = el("h2", "margin:0 0 12px;font-size:22px;line-height:1.2;font-weight:900;color:" + NAVY, data.total + " promises, scored against the record");
    card.appendChild(eyebrow);
    card.appendChild(heading);

    var bar = el("div", "display:flex;height:14px;border-radius:7px;overflow:hidden;background:#E3E7EF;margin:0 0 12px");
    bar.setAttribute("aria-hidden", "true");
    var statuses = data.statuses || [];
    for (var i = 0; i < statuses.length; i++) {
      if (statuses[i].count > 0) bar.appendChild(el("span", "flex:" + statuses[i].count + " 1 0;background:" + statuses[i].color));
    }
    card.appendChild(bar);

    var list = el("ul", "list-style:none;margin:0 0 12px;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px");
    for (var j = 0; j < statuses.length; j++) {
      var item = el("li", "display:inline-flex;align-items:center;gap:6px;font-weight:700");
      var dot = el("span", "display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid rgba(0,0,0,0.15);background:" + statuses[j].color);
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);
      item.appendChild(el("span", "", statuses[j].count + " " + statuses[j].label.toLowerCase()));
      list.appendChild(item);
    }
    card.appendChild(list);

    var updated = formatDate(data.lastUpdated);
    card.appendChild(el("p", "margin:0 0 12px;font-size:13px;color:#4A5872", updated ? "Last updated " + updated + "." : "No scores changed yet."));

    var link = el("a", "display:inline-block;padding:10px 16px;border-radius:6px;background:" + NAVY + ";color:#fff;font-weight:700;text-decoration:none", "See every promise");
    link.href = trackerUrl;
    link.target = "_blank";
    link.rel = "noopener";
    card.appendChild(link);

    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(card);
  }

  function render(target, site) {
    if (!target) return;
    var base = (site || window.ImagineSurreyTracker.site || "").replace(/\/$/, "");
    var url = base + "/api/promises/summary";
    target.setAttribute("data-tracker-state", "loading");
    fetch(url, { headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        draw(target, data, base);
        target.setAttribute("data-tracker-state", "ready");
      })
      .catch(function () {
        while (target.firstChild) target.removeChild(target.firstChild);
        var fallback = el("a", "font-family:" + FONT + ";color:" + NAVY + ";font-weight:700", "See the Safe Surrey promise tracker");
        fallback.href = base + "/tracker";
        target.appendChild(fallback);
        target.setAttribute("data-tracker-state", "error");
      });
  }

  var script = document.currentScript;
  var origin = "";
  if (script && script.src) {
    try {
      origin = new URL(script.src, window.location.href).origin;
    } catch (e) {
      origin = "";
    }
  }
  var api = (window.ImagineSurreyTracker = window.ImagineSurreyTracker || {});
  api.render = render;
  api.site = (script && script.getAttribute("data-site")) || origin || "";

  if (script) {
    var targetId = script.getAttribute("data-target");
    var target = targetId ? document.getElementById(targetId) : null;
    if (!target) {
      target = document.createElement("div");
      if (targetId) target.id = targetId;
      script.parentNode.insertBefore(target, script);
    }
    render(target, api.site);
  }
})();
