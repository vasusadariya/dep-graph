/** Self-contained HTML visualization of a dependency graph (graph data inlined, d3 from CDN). */
interface G {
  nodes: Array<{ id: string; service?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

export function renderHtml(g: G): string {
  const data = JSON.stringify(g).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tool dependency graph</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;font:13px system-ui,sans-serif;background:#0f1218;color:#d8dee9}
  #bar{position:fixed;top:0;left:0;right:0;display:flex;gap:12px;align-items:center;padding:8px 12px;background:#161b24;border-bottom:1px solid #2a3140;z-index:2;flex-wrap:wrap}
  input,select{background:#0f1218;color:inherit;border:1px solid #2a3140;border-radius:4px;padding:4px 6px}
  #info{position:fixed;right:12px;bottom:12px;max-width:380px;max-height:45vh;overflow:auto;background:#161b24;border:1px solid #2a3140;border-radius:6px;padding:10px;font-size:12px}
  #info b{color:#fff} svg{position:fixed;top:44px;left:0;width:100%;height:calc(100% - 44px)}
  .link{stroke:#4c566a;stroke-opacity:.5;fill:none} .link.hl{stroke:#ebcb8b;stroke-opacity:1;stroke-width:2}
  .dim{opacity:.08} text{pointer-events:none;fill:#d8dee9;font-size:9px}
  .elabel{fill:#ebcb8b;font-size:10px}
</style></head><body>
<div id="bar">
  <b>Tool dependency graph</b><span id="stats"></span>
  <input id="q" placeholder="search tool…" size="26">
  <select id="svc"><option value="">all services</option></select>
  <label><input type="checkbox" id="iso"> show isolated tools</label>
  <label><input type="checkbox" id="scope"> show owner/repo edges</label>
  <span style="opacity:.6">producer → consumer; click a node to highlight; scroll to zoom, drag to pan</span>
</div>
<svg id="v"><defs><marker id="arr" viewBox="0 -4 8 8" refX="14" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,-4L8,0L0,4" fill="#81a1c1"/></marker></defs><g id="root"></g></svg>
<div id="info">Click a node to see what it needs and what it unlocks.</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script>
const G = ${data};
const info = document.getElementById("info");
if (typeof d3 === "undefined") { info.textContent = "d3 failed to load (needs internet). Graph data: " + G.nodes.length + " nodes, " + G.edges.length + " edges."; throw new Error("d3 missing"); }
const color = d3.scaleOrdinal(d3.schemeTableau10.concat(d3.schemeSet3));
const services = [...new Set(G.nodes.map(n => n.service || "misc"))].sort();
const svcSel = document.getElementById("svc");
services.forEach(s => svcSel.add(new Option(s, s)));
const short = id => id.replace(/^[A-Z0-9]+?_/, "");
const svg = d3.select("#v"), root = d3.select("#root");
const zoomer = d3.zoom().scaleExtent([0.1, 8]).on("zoom", e => root.attr("transform", e.transform));
svg.call(zoomer);
let sim, selected = null;

function draw() {
  root.selectAll("*").remove(); if (sim) sim.stop();
  const showIso = document.getElementById("iso").checked, showScope = document.getElementById("scope").checked;
  const svc = svcSel.value, q = document.getElementById("q").value.trim().toLowerCase();
  let edges = G.edges.filter(e => showScope || (e.label !== "owner" && e.label !== "repo")).map(e => ({...e, source: e.from, target: e.to}));
  const linked = new Set(edges.flatMap(e => [e.from, e.to]));
  let nodes = G.nodes.filter(n => (showIso || linked.has(n.id)) && (!svc || n.service === svc) && (!q || n.id.toLowerCase().includes(q))).map(n => ({...n}));
  const keep = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => keep.has(e.from) && keep.has(e.to));
  document.getElementById("stats").textContent = nodes.length + " nodes · " + edges.length + " edges";
  const link = root.append("g").selectAll("path").data(edges).join("path").attr("class", "link").attr("marker-end", "url(#arr)");
  link.append("title").text(e => short(e.from) + " → " + short(e.to) + "  [" + e.label + "]");
  const node = root.append("g").selectAll("g").data(nodes).join("g").style("cursor", "pointer")
    .call(d3.drag().on("start", (e, d) => { if (!e.active) sim.alphaTarget(.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; }).on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = d.fy = null; }));
  node.append("circle").attr("r", 5).attr("fill", d => color(d.service || "misc"));
  node.append("title").text(d => d.id + " (" + d.service + ")");
  const label = node.append("text").attr("x", 8).attr("y", 3).text(d => nodes.length < 160 ? short(d.id) : "");
  const elabels = root.append("g").selectAll("text").data(edges).join("text").attr("class", "elabel").text("").attr("text-anchor", "middle");
  sim = d3.forceSimulation(nodes).force("link", d3.forceLink(edges).id(d => d.id).distance(60).strength(.5))
    .force("charge", d3.forceManyBody().strength(-70).distanceMax(300))
    .force("x", d3.forceX(innerWidth / 2).strength(.07)).force("y", d3.forceY(innerHeight / 2).strength(.09))
    .force("collide", d3.forceCollide(7)).on("tick", () => {
      link.attr("d", e => "M" + e.source.x + "," + e.source.y + "L" + e.target.x + "," + e.target.y);
      node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
      elabels.attr("x", e => (e.source.x + e.target.x) / 2).attr("y", e => (e.source.y + e.target.y) / 2);
    });
  sim.on("end", () => { // fit the settled layout into the viewport
    const b = root.node().getBBox(); if (!b.width || !b.height) return;
    const k = Math.min(innerWidth / (b.width + 80), (innerHeight - 44) / (b.height + 80), 1.5);
    svg.transition().duration(400).call(zoomer.transform, d3.zoomIdentity.translate(innerWidth / 2 - k * (b.x + b.width / 2), (innerHeight - 44) / 2 - k * (b.y + b.height / 2)).scale(k));
  });
  node.on("click", (ev, d) => {
    selected = d.id;
    const ins = edges.filter(e => e.to.id === d.id), outs = edges.filter(e => e.from.id === d.id);
    const near = new Set([d.id, ...ins.map(e => e.from.id), ...outs.map(e => e.to.id)]);
    node.classed("dim", n => !near.has(n.id)); link.classed("hl", e => e.from.id === d.id || e.to.id === d.id).classed("dim", e => !(e.from.id === d.id || e.to.id === d.id));
    elabels.text(e => (e.from.id === d.id || e.to.id === d.id) ? e.label : "");
    label.text(n => near.has(n.id) || nodes.length < 160 ? short(n.id) : "");
    info.innerHTML = "<b>" + d.id + "</b> <i>(" + d.service + ")</i><br><br><b>needs (producers):</b><br>" +
      (ins.map(e => "← " + short(e.from.id) + " <i>[" + e.label + "]</i>").join("<br>") || "none") +
      "<br><br><b>unlocks (consumers):</b><br>" + (outs.map(e => "→ " + short(e.to.id) + " <i>[" + e.label + "]</i>").join("<br>") || "none");
    ev.stopPropagation();
  });
  svg.on("click", () => { node.classed("dim", false); link.classed("hl", false).classed("dim", false); elabels.text(""); });
}
["q", "svc", "iso", "scope"].forEach(id => document.getElementById(id).addEventListener("input", draw));
draw();
</script></body></html>`;
}
