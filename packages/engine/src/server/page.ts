// Single-page dashboard (no build step). Polls /api/apps; row click expands editable answers.
export const page = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Apply Agent</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262a33; --text:#e6e8eb; --dim:#8b919c; --accent:#4f8cff; --warn:#f59e0b; --ok:#22c55e; --bad:#ef4444; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif; }
  main { max-width:1200px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:var(--dim); margin-bottom:20px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:8px; overflow:hidden; }
  th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase; }
  tr.row { cursor:pointer; } tr.row:hover { background:#1c2029; }
  .pill { padding:2px 8px; border-radius:99px; font-size:12px; background:var(--line); white-space:nowrap; }
  .prepared { background:#1e3a8a; } .filling { background:#854d0e; } .submitted { background:#14532d; }
  .error, .skip-fit, .closed { background:#7f1d1d; } .manual, .blocked { background:#4c1d95; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--line); }
  a { color:var(--accent); } .need { color:var(--warn); } .note { color:var(--dim); font-size:12px; }
  .detail td { background:#12151b; } .field { margin:0 0 12px; } .field label { display:block; color:var(--dim); margin-bottom:4px; }
  .field.unsure label { color:var(--warn); }
  textarea { width:100%; box-sizing:border-box; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
</style></head>
<body><main>
  <h1>Apply Agent</h1>
  <div class="sub">Review → Apply opens a tab in your Chrome and fills it. You submit. Orange = needs you.</div>
  <table><thead><tr><th>Company</th><th>Role</th><th>Fit</th><th>ATS</th><th>Fields</th><th>Resume</th><th>Status</th><th></th></tr></thead>
  <tbody id="rows"></tbody></table>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[c]);
const post = (url, body) => fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body ?? {}) });
let apps = [], open = null;

const needCount = (a) => a.fields.filter((f) => !a.answers[f.id]?.value || !a.answers[f.id]?.confident).length;

const row = (a) => \`
  <tr class="row" data-id="\${a.id}">
    <td>\${esc(a.company)}</td>
    <td><a href="\${esc(a.url)}" target="_blank" onclick="event.stopPropagation()">\${esc(a.title)}</a></td>
    <td>\${esc(a.fit ?? "—")}</td><td>\${a.atsScore ?? "—"}</td>
    <td>\${a.fields.length} \${needCount(a) ? \`<span class="need">(\${needCount(a)} need you)</span>\` : ""}</td>
    <td>\${a.resumePath ? \`<a href="/resume/\${a.id}" onclick="event.stopPropagation()">docx</a>\` : "—"}</td>
    <td><span class="pill \${a.status}">\${a.status}</span>\${a.note ? \`<div class="note">\${esc(a.note)}</div>\` : ""}</td>
    <td onclick="event.stopPropagation()">\${actions(a)}</td>
  </tr>\${open === a.id ? detail(a) : ""}\`;

const skipBtn = (a) => \`<button class="ghost" onclick="setStatus('\${a.id}','skipped')">Skip</button>\`;
const actions = (a) =>
  ["prepared","manual","blocked","error","skipped"].includes(a.status) ? \`<button onclick="apply('\${a.id}')">Apply</button> \${skipBtn(a)}\`
  : a.status === "filling" ? \`<button class="ghost" onclick="setStatus('\${a.id}','submitted')">Mark submitted</button> \${skipBtn(a)}\`
  : "";

const detail = (a) => \`<tr class="detail"><td colspan="8">
  \${a.fields.filter((f) => f.type !== "file").map((f) => {
    const ans = a.answers[f.id] ?? {};
    return \`<div class="field \${ans.confident ? "" : "unsure"}"><label>\${esc(f.label)}\${f.required ? " *" : ""}\${f.options ? \` — \${esc(f.options.join(" / "))}\` : ""}</label>
      <textarea data-field="\${esc(f.id)}" rows="\${f.type === "textarea" ? 4 : 1}">\${esc(ans.value)}</textarea></div>\`;
  }).join("") || '<div class="note">No form fields.</div>'}
  <button onclick="save('\${a.id}')">Save answers</button> <span class="note">Saved answers are remembered for future jobs.</span>
</td></tr>\`;

const render = () => {
  $("#rows").innerHTML = apps.map(row).join("") || '<tr><td colspan="8" class="note">Nothing prepared yet — run npm run prepare-jobs</td></tr>';
  document.querySelectorAll("tr.row").forEach((tr) => tr.onclick = () => { open = open === tr.dataset.id ? null : tr.dataset.id; render(); });
};

const refresh = async () => {
  if (open && document.activeElement?.tagName === "TEXTAREA") return; // don't clobber typing
  apps = await (await fetch("/api/apps")).json();
  render();
};

async function apply(id) { await post("/api/apply/" + id); refresh(); }
async function setStatus(id, status) { await post("/api/status/" + id, { status }); refresh(); }
async function save(id) {
  const answers = {};
  document.querySelectorAll("tr.detail textarea").forEach((t) => answers[t.dataset.field] = t.value);
  await post("/api/answers/" + id, { answers });
  open = null; refresh();
}

refresh(); setInterval(refresh, 3000);
</script></body></html>`;
