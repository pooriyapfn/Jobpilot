import http from "http";
import { existsSync, readFileSync } from "fs";
import { initDb } from "./db.ts";
import { OUTPUT_DIR } from "./paths.ts";

const DB_PATH = process.env["DB_PATH"] ?? `${OUTPUT_DIR}jobs.db`;
const STATS_PATH = `${OUTPUT_DIR}stats.json`;
const PORT = parseInt(process.env["DASHBOARD_PORT"] ?? "3000", 10);

interface DbRow {
  id: string;
  canonical_url: string;
  title: string | null;
  company: string | null;
  fit_score: number | null;
  date_posted: string | null;
  location_eligibility: string | null;
  llm_status: string | null;
  llm_evidence: string | null;
  fit_highlights: string | null;
  fit_summary: string | null;
  first_seen_at: string;
  last_seen_at: string;
  notified: number;
  freshness: string | null;
}

function scoreColor(score: number | null): string {
  if (score === null) return "#888";
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#facc15";
  return "#94a3b8";
}

function eligibilityBadge(status: string | null, llmStatus: string | null): string {
  const s = status ?? llmStatus ?? "unknown";
  const colors: Record<string, string> = {
    "turkey-ok": "#22c55e",
    "eligible": "#86efac",
    "uncertain": "#fb923c",
    "restricted": "#f87171",
    "unknown": "#64748b",
  };
  const bg = colors[s] ?? "#64748b";
  return `<span style="background:${bg};color:#0f172a;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${s}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

function renderHighlights(json: string | null): string {
  if (!json) return "";
  try {
    const items = JSON.parse(json) as string[];
    if (!items.length) return "";
    return `<ul style="margin:4px 0 0 0;padding-left:16px;font-size:11px;color:#94a3b8;">${items.slice(0, 3).map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`;
  } catch {
    return "";
  }
}

function renderRow(job: DbRow): string {
  const score = job.fit_score;
  const isNew = job.notified === 0;
  const urlSafe = escapeHtml(job.canonical_url);
  const title = escapeHtml(job.title ?? "Untitled");
  const company = escapeHtml(job.company ?? "—");
  const summary = job.fit_summary ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escapeHtml(job.fit_summary)}</div>` : "";
  const evidence = job.llm_evidence ? `<div style="font-size:11px;color:#94a3b8;font-style:italic;">${escapeHtml(job.llm_evidence.slice(0, 120))}</div>` : "";

  return `
  <tr class="job-row" data-score="${score ?? 0}" data-new="${isNew ? 1 : 0}">
    <td style="text-align:center;font-weight:700;font-size:15px;color:${scoreColor(score)};white-space:nowrap;">
      ${score !== null ? score : "—"}
    </td>
    <td>${company}${isNew ? ' <span style="background:#6366f1;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:4px;">NEW</span>' : ""}</td>
    <td>
      <a href="${urlSafe}" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:none;">${title}</a>
      ${summary}
    </td>
    <td style="white-space:nowrap;">${fmtDate(job.date_posted)}</td>
    <td>${eligibilityBadge(job.location_eligibility, job.llm_status)}${evidence}</td>
    <td>${renderHighlights(job.fit_highlights)}</td>
    <td style="white-space:nowrap;font-size:11px;color:#64748b;">${fmtDate(job.first_seen_at)}</td>
  </tr>`;
}

function renderHtml(jobs: DbRow[], stats: { total: number; newCount: number; avgScore: string; lastRun: string }): string {
  const rows = jobs.map(renderRow).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="300">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: 'Courier New', monospace; font-size: 13px; }
  header { background: #1e293b; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #334155; }
  header h1 { font-size: 18px; font-weight: 700; color: #f1f5f9; }
  header .meta { font-size: 11px; color: #64748b; }
  .stats { display: flex; gap: 16px; padding: 16px 24px; background: #1e293b; border-bottom: 1px solid #334155; }
  .stat-card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 20px; min-width: 140px; }
  .stat-card .label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-card .value { font-size: 22px; font-weight: 700; color: #f1f5f9; margin-top: 4px; }
  .filters { padding: 12px 24px; display: flex; gap: 8px; background: #0f172a; border-bottom: 1px solid #1e293b; }
  .filter-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 5px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .filter-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  .table-wrap { overflow-x: auto; padding: 16px 24px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1px solid #334155; white-space: nowrap; }
  td { padding: 10px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
  tr:hover td { background: #1e293b22; }
  a:hover { text-decoration: underline; }
  .hidden { display: none; }
</style>
</head>
<body>

<header>
  <h1>Job Dashboard</h1>
  <div class="meta">Last run: ${escapeHtml(stats.lastRun)} &nbsp;|&nbsp; Auto-refresh every 5 min</div>
</header>

<div class="stats">
  <div class="stat-card"><div class="label">Total in DB</div><div class="value">${stats.total}</div></div>
  <div class="stat-card"><div class="label">New (unseen)</div><div class="value" style="color:#6366f1;">${stats.newCount}</div></div>
  <div class="stat-card"><div class="label">Avg Fit Score</div><div class="value">${stats.avgScore}</div></div>
</div>

<div class="filters">
  <button class="filter-btn active" onclick="filter('all')">All (${jobs.length})</button>
  <button class="filter-btn" onclick="filter('new')">New only</button>
  <button class="filter-btn" onclick="filter('80')">Score ≥ 80</button>
  <button class="filter-btn" onclick="filter('60')">Score ≥ 60</button>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Score</th>
        <th>Company</th>
        <th>Title</th>
        <th>Posted</th>
        <th>Eligibility</th>
        <th>Highlights</th>
        <th>First Seen</th>
      </tr>
    </thead>
    <tbody id="job-tbody">
${rows}
    </tbody>
  </table>
  ${jobs.length === 0 ? '<p style="color:#64748b;padding:32px 0;text-align:center;">No jobs in database yet. Run <code>npm run enrich</code> first.</p>' : ""}
</div>

<script>
  let current = 'all';
  function filter(mode) {
    current = mode;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    document.querySelectorAll('.job-row').forEach(row => {
      const score = parseInt(row.dataset.score) || 0;
      const isNew = row.dataset.new === '1';
      let show = true;
      if (mode === 'new') show = isNew;
      else if (mode === '80') show = score >= 80;
      else if (mode === '60') show = score >= 60;
      row.classList.toggle('hidden', !show);
    });
  }
</script>
</body>
</html>`;
}

const server = http.createServer((_req, res) => {
  try {
    let jobs: DbRow[] = [];
    let total = 0;
    let newCount = 0;
    let avgScore = "—";

    if (existsSync(DB_PATH)) {
      const db = initDb(DB_PATH);
      jobs = db.prepare("SELECT * FROM jobs ORDER BY fit_score DESC").all() as unknown as DbRow[];
      total = jobs.length;
      newCount = jobs.filter((j) => j.notified === 0).length;
      const scored = jobs.filter((j) => j.fit_score !== null);
      if (scored.length > 0) {
        const sum = scored.reduce((acc, j) => acc + (j.fit_score ?? 0), 0);
        avgScore = (sum / scored.length).toFixed(1);
      }
      db.close();
    }

    let lastRun = "never";
    if (existsSync(STATS_PATH)) {
      try {
        const s = JSON.parse(readFileSync(STATS_PATH, "utf8")) as { runAt?: string };
        if (s.runAt) lastRun = new Date(s.runAt).toLocaleString();
      } catch {
        // ignore
      }
    }

    const html = renderHtml(jobs, { total, newCount, avgScore, lastRun });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
