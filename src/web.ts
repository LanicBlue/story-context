import { resolve, join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { TYPE_PRESETS, SCENARIO_PRESETS } from "./inner-turn.js";

// ── CSS ──────────────────────────────────────────────────────────

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1a1a2e;--surface:#16213e;--surface2:#0f3460;--text:#e0e0e0;--text2:#a0a0b0;--accent:#e94560;--border:#2a2a4a;--active:#00b894;--inactive:#636e72;--tag-bg:#2d3436;--tag-text:#dfe6e9;--hover:#233554}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column}
#header{padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px;flex-shrink:0}
#header h1{font-size:14px;font-weight:600;color:var(--accent)}
#header .meta{font-size:12px;color:var(--text2)}
#tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.tab-btn{padding:8px 20px;font-size:13px;background:none;border:none;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent}
.tab-btn:hover{color:var(--text);background:var(--hover)}
.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}
#main{display:flex;flex:1;overflow:hidden}
#sidebar{width:280px;min-width:200px;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
#detail{flex:1;overflow-y:auto;padding:16px}
.group-header{padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text2);background:var(--surface2);letter-spacing:1px;position:sticky;top:0;z-index:1}
.list-item{padding:6px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px}
.list-item:hover{background:var(--hover)}
.list-item.selected{background:var(--surface2);border-left:3px solid var(--accent)}
.list-item .item-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-item .item-sub{font-size:11px;color:var(--text2);margin-top:2px}
.status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}
.status-active{background:var(--active)}.status-inactive{background:var(--inactive)}
.detail-empty{color:var(--text2);font-size:14px;margin-top:40px;text-align:center}
.detail-title{font-size:18px;font-weight:600;margin-bottom:12px}
.detail-meta{font-size:12px;color:var(--text2);margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap}
.detail-narrative{font-size:14px;line-height:1.7;white-space:pre-wrap;background:var(--surface);padding:16px;border-radius:6px;border:1px solid var(--border)}
.dim-tag{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;background:var(--tag-bg);color:var(--tag-text);cursor:pointer;user-select:none}
.dim-tag:hover{background:var(--accent);color:#fff}
.dim-label{font-size:11px;color:var(--text2);margin-right:4px}
.story-link{color:var(--accent);cursor:pointer;font-size:13px}
.story-link:hover{text-decoration:underline}
.msg-role{font-size:11px;font-weight:600;padding:1px 6px;border-radius:3px;margin-right:8px}
.msg-user{background:#0984e3;color:#fff}
.msg-assistant{background:#6c5ce7;color:#fff}
.msg-toolResult{background:#00b894;color:#fff}
.msg-unknown{background:var(--inactive);color:#fff}
input.dirty,select.dirty{border-color:var(--accent)!important}
.btn{padding:6px 14px;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px;background:var(--surface2);color:var(--text)}
.btn:hover{opacity:.85}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:disabled{opacity:.4;cursor:default}
.btn-danger{background:#d63031;color:#fff;border-color:#d63031;padding:2px 8px;font-size:11px}
`;

// ── JS ───────────────────────────────────────────────────────────

const JS = `
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
let curTab='context',selId=null;
const D=DATA;
function save(){try{localStorage.setItem('sc-tab',curTab);if(selId)localStorage.setItem('sc-sel',selId);else localStorage.removeItem('sc-sel');}catch{}}
function load(){try{curTab=localStorage.getItem('sc-tab')||'context';selId=localStorage.getItem('sc-sel')||null;}catch{}}
load();
$$('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
function switchTab(t,id){curTab=t;selId=id||null;$$('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));renderSidebar();if(t==='settings')settingsDetail($('#detail'));else if(id)selectItem(id);else $('#detail').innerHTML='<div class="detail-empty">Select an item</div>';save();}
function selectItem(id){selId=id;$$('.list-item').forEach(el=>el.classList.toggle('selected',el.dataset.id===id));renderDetail(id);save();}
$('#sidebar').addEventListener('click',e=>{const i=e.target.closest('.list-item');if(i)selectItem(i.dataset.id);});
$('#sidebar').addEventListener('dblclick',e=>{const t=e.target.closest('.dim-tag');if(t){e.stopPropagation();navDim(t.dataset.dim,t.dataset.name);}});
$('#detail').addEventListener('dblclick',e=>{const t=e.target.closest('.dim-tag');if(t){e.stopPropagation();navDim(t.dataset.dim,t.dataset.name);}const l=e.target.closest('.story-link');if(l){e.stopPropagation();switchTab('stories',l.dataset.id);}});
function navDim(d,n){switchTab({subject:'subjects',type:'types',scenario:'scenarios'}[d]||d,n);}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function renderSidebar(){const sb=$('#sidebar');if(curTab==='context')ctxSidebar(sb);else if(curTab==='stories')storiesSidebar(sb);else if(curTab==='settings')settingsSidebar(sb);else dimSidebar(sb,curTab);}
function getMessages(){const w=parseInt(localStorage.getItem('sc-msgWindow')||'30',10);return(D.allMessages||[]).slice(-w);}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts);return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');}
function ctxSidebar(sb){const S=D.stories||[],M=getMessages();let h='<div class="group-header">Stories ('+S.length+')</div>';for(const s of S){const a=s.activeUntilTurn>=D.state.turn;h+=si(s.id,a,s);}h+='<div class="group-header">Messages ('+M.length+'/'+D.totalMessages+')</div>';M.forEach((m,i)=>{const id='msg-'+i;h+=mi(id,m);});sb.innerHTML=h;}
function settingsSidebar(sb){sb.innerHTML='<div class="group-header">Thresholds</div><div class="list-item'+(selId==='thresholds'?' selected':'')+'" data-id="thresholds"><div class="item-title">Engine Thresholds</div></div><div class="group-header">Filter Rules</div><div class="list-item'+(selId==='filters'?' selected':'')+'" data-id="filters"><div class="item-title">Content Filters</div></div>';}
function storiesSidebar(sb){const S=D.stories;let h='';for(const s of S){const a=s.activeUntilTurn>=D.state.turn;h+=\`<div class="list-item \${selId===s.id?'selected':''}" data-id="\${s.id}"><div class="item-title"><span class="status-dot \${a?'status-active':'status-inactive'}"></span>\${esc(s.title)}</div><div class="item-sub">\${esc(s.attributes.subject)} · \${esc(s.attributes.scenario)}</div></div>\`;}if(!S.length)h='<div class="detail-empty">No stories</div>';sb.innerHTML=h;}
function dimSidebar(sb,tab){const E=D.dimensions[tab]||[];let h='';for(const e of E){h+=\`<div class="list-item \${selId===e.name?'selected':''}" data-id="\${esc(e.name)}"><div class="item-title">\${esc(e.name)}</div><div class="item-sub">\${e.stories.length} stories</div></div>\`;}if(!E.length)h='<div class="detail-empty">No entries</div>';sb.innerHTML=h;}
function si(id,a,s){const t=s.lastUpdated?new Date(s.lastUpdated).toLocaleString():'';return\`<div class="list-item \${selId===id?'selected':''}" data-id="\${id}"><div class="item-title"><span class="status-dot \${a?'status-active':'status-inactive'}"></span>\${esc(s.title)}</div><div class="item-sub"><span class="dim-tag" data-dim="subject" data-name="\${esc(s.attributes.subject)}">\${esc(s.attributes.subject)}</span> <span class="dim-tag" data-dim="type" data-name="\${esc(s.attributes.type)}">\${esc(s.attributes.type)}</span> <span class="dim-tag" data-dim="scenario" data-name="\${esc(s.attributes.scenario)}">\${esc(s.attributes.scenario)}</span></div><div class="item-sub">\${t?'\u{1F551} '+t+' · ':''}\${s.tokens||0} tokens</div></div>\`;}
function mi(id,m){const t=fmtTime(m.ts);const badge=m.persisted?'<span style="background:#fdcb6e;color:#2d3436;padding:1px 5px;border-radius:3px;font-size:10px;margin-right:4px">persisted</span>':'';return\`<div class="list-item \${selId===id?'selected':''}" data-id="\${id}"><div class="item-title"><span class="msg-role msg-\${m.role}">\${m.role}</span>\${badge}\${esc(m.content.slice(0,60))}</div><div class="item-sub">\${t?'\u{1F551} '+t+' · ':''}\${m.tokens||0} tokens</div></div>\`;}
function renderDetail(id){const d=$('#detail');if(curTab==='context'){id.startsWith('msg-')?msgDetail(d,id):storyDetail(d,id);}else if(curTab==='stories')storyDetail(d,id);else if(curTab==='settings')settingsDetail(d);else dimDetail(d,id);}
let _filters=null;
function getFilters(){if(_filters)return _filters;try{_filters=JSON.parse(localStorage.getItem('sc-contentFilters'));}catch{}if(!_filters||!_filters.length)_filters=[...(D.contentFilters||[])];return _filters;}
function settingsDetail(d){
  if(selId==='filters'){filterDetail(d);return;}
  const params=[
    {key:'sc-msgWindow',label:'messageWindowSize',def:30,desc:'Number of recent messages in context'},
    {key:'sc-maxStories',label:'maxActiveStories',def:13,desc:'Max active stories before eviction'},
    {key:'sc-fullCount',label:'fullStoryCount',def:3,desc:'Top N stories with full narrative (rest get summary)'},
    {key:'sc-innerTurnInterval',label:'innerTurnInterval',def:20,desc:'Trigger inner turn every N turns'},
    {key:'sc-activeStoryTTL',label:'activeStoryTTL',def:40,desc:'Turns before a story expires'},
    {key:'sc-maxHistoryTokens',label:'maxHistoryTokens',def:120000,desc:'Token budget for compact'},
    {key:'sc-largeTextThreshold',label:'largeTextThreshold',def:2000,desc:'Char threshold for large text persistence'},
  ];
  let h='<div class="detail-title">Engine Thresholds</div><div class="detail-meta">Unsaved changes are highlighted.</div>';
  for(const p of params){
    const v=localStorage.getItem(p.key)||String(p.def);
    h+='<div style="margin-bottom:16px"><label style="display:block;font-size:13px;color:var(--text);margin-bottom:2px">'+p.label+'</label><div style="font-size:11px;color:var(--text2);margin-bottom:4px">'+p.desc+'</div><input type="number" data-key="'+p.key+'" data-def="'+p.def+'" value="'+v+'" class="param-input" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:6px 10px;border-radius:4px;font-size:14px;width:160px"></div>';
  }
  h+='<div style="display:flex;gap:8px;margin-top:16px"><button id="save-th-btn" class="btn btn-primary" disabled>Save</button><button id="reset-th-btn" class="btn">Reset Defaults</button></div>';
  d.innerHTML=h;
  function checkThDirty(){
    let dirty=false;
    d.querySelectorAll('.param-input').forEach(function(inp){
      const saved=localStorage.getItem(inp.dataset.key)||inp.dataset.def;
      if(inp.value!==saved){inp.classList.add('dirty');dirty=true;}
      else inp.classList.remove('dirty');
    });
    const btn=$('#save-th-btn');if(btn)btn.disabled=!dirty;
  }
  d.querySelectorAll('.param-input').forEach(function(inp){inp.addEventListener('input',checkThDirty);});
  checkThDirty();
  $('#save-th-btn').addEventListener('click',function(){
    d.querySelectorAll('.param-input').forEach(function(inp){localStorage.setItem(inp.dataset.key,inp.value);});
    checkThDirty();
    if(curTab==='context')renderSidebar();
  });
  $('#reset-th-btn').addEventListener('click',function(){
    d.querySelectorAll('.param-input').forEach(function(inp){inp.value=inp.dataset.def;});
    checkThDirty();
  });
}
function filterDetail(d){
  const filters=getFilters();
  let h='<div class="detail-title">Content Filters</div><div class="detail-meta">'+filters.length+' filter rules</div>';
  h+='<table id="ftable" style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:var(--text2);text-align:left;border-bottom:1px solid var(--border)"><th style="padding:8px">Match</th><th style="padding:8px">Pattern</th><th style="padding:8px">Granularity</th><th style="padding:8px">Case</th><th style="padding:8px;width:40px"></th></tr>';
  for(let i=0;i<filters.length;i++){
    const f=filters[i];
    h+='<tr data-idx="'+i+'" style="border-bottom:1px solid var(--border)">';
    h+='<td style="padding:8px"><select data-field="match" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px;border-radius:3px"><option value="contains"'+(f.match==='contains'?' selected':'')+'>contains</option><option value="regex"'+(f.match==='regex'?' selected':'')+'>regex</option></select></td>';
    h+='<td style="padding:8px"><input data-field="pattern" value="'+esc(f.pattern)+'" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:3px;font-family:monospace;width:100%"></td>';
    h+='<td style="padding:8px"><select data-field="granularity" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px;border-radius:3px"><option value="message"'+(f.granularity==='message'?' selected':'')+'>message</option><option value="block"'+(f.granularity==='block'?' selected':'')+'>block</option><option value="line"'+(f.granularity==='line'?' selected':'')+'>line</option></select></td>';
    h+='<td style="padding:8px"><input type="checkbox" data-field="caseSensitive"'+(f.caseSensitive?' checked':'')+'></td>';
    h+='<td style="padding:8px"><button class="btn btn-danger fdel" data-idx="'+i+'">\\u2715</button></td>';
    h+='</tr>';
  }
  h+='</table>';
  h+='<div style="display:flex;gap:8px;margin-top:16px"><button id="add-f-btn" class="btn">+ Add Filter</button><button id="save-f-btn" class="btn btn-primary">Save</button></div>';
  d.innerHTML=h;
  d.querySelectorAll('#ftable input, #ftable select').forEach(function(el){
    el.addEventListener('change',function(){
      const row=el.closest('tr');const idx=parseInt(row.dataset.idx);const field=el.dataset.field;
      if(el.type==='checkbox')_filters[idx][field]=el.checked;
      else _filters[idx][field]=el.value;
    });
  });
  d.querySelectorAll('.fdel').forEach(function(btn){
    btn.addEventListener('click',function(){
      _filters.splice(parseInt(btn.dataset.idx),1);filterDetail(d);
    });
  });
  $('#add-f-btn').addEventListener('click',function(){
    _filters.push({match:'contains',pattern:'',granularity:'message',caseSensitive:false});filterDetail(d);
  });
  $('#save-f-btn').addEventListener('click',function(){
    localStorage.setItem('sc-contentFilters',JSON.stringify(_filters));
    filterDetail(d);
  });
}
function storyDetail(d,id){const s=D.stories.find(x=>x.id===id);if(!s){d.innerHTML='<div class="detail-empty">Not found</div>';return;}const a=s.activeUntilTurn>=D.state.turn;d.innerHTML=\`<div class="detail-title">\${esc(s.title)}</div><div class="detail-meta"><span><span class="status-dot \${a?'status-active':'status-inactive'}"></span>\${a?'Active':'Inactive'} (until turn \${s.activeUntilTurn})</span><span>Edited: turn \${s.lastEditedTurn}</span><span>Created: \${new Date(s.createdAt).toLocaleString()}</span></div><div class="detail-meta" style="margin-bottom:16px"><span><span class="dim-label">Subject:</span> <span class="dim-tag" data-dim="subject" data-name="\${esc(s.attributes.subject)}">\${esc(s.attributes.subject)}</span></span> <span><span class="dim-label">Type:</span> <span class="dim-tag" data-dim="type" data-name="\${esc(s.attributes.type)}">\${esc(s.attributes.type)}</span></span> <span><span class="dim-label">Scenario:</span> <span class="dim-tag" data-dim="scenario" data-name="\${esc(s.attributes.scenario)}">\${esc(s.attributes.scenario)}</span></span></div><div class="detail-narrative">\${esc(s.narrative)}</div>\`;}
function msgDetail(d,id){const i=parseInt(id.replace('msg-','')),m=getMessages()[i];if(!m){d.innerHTML='<div class="detail-empty">Not found</div>';return;}let h=\`<div class="detail-title"><span class="msg-role msg-\${m.role}">\${m.role}</span> Message #\${i+1}</div>\`;h+=\`<div class="detail-meta">\${m.tokens||0} tokens\${m.persisted?' · <span style="color:#fdcb6e">content persisted to file</span>':''}</div>\`;h+=\`<div class="detail-narrative">\${esc(m.content)}</div>\`;d.innerHTML=h;}
function dimDetail(d,name){const E=D.dimensions[curTab]||[],e=E.find(x=>x.name===name);if(!e){d.innerHTML='<div class="detail-empty">Not found</div>';return;}let h=\`<div class="detail-title">\${esc(name)}</div><div class="detail-meta">\${e.stories.length} associated stories</div>\`;if(e.stories.length){h+='<div style="margin-top:12px">';for(const s of e.stories)h+=\`<div style="margin-bottom:8px"><span class="story-link" data-id="\${s.id}">\${esc(s.title)}</span> <span style="color:var(--text2);font-size:12px">\${s.id}</span></div>\`;h+='</div>';}h+='<div style="margin-top:24px;color:var(--text2);font-size:12px;font-style:italic">Entity understanding \\u2014 coming soon</div>';d.innerHTML=h;}
$('#status-bar').textContent='turn '+D.state.turn+' | stories '+D.state.activeStories.length+' | msgs '+D.totalMessages;
$$('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===curTab));
renderSidebar();
if(selId){selectItem(selId);}
`;

// ── Types ────────────────────────────────────────────────────────

type StoryRow = {
  id: string; title: string; subject: string; type: string; scenario: string;
  status: string; narrative: string; active_until_turn: number; last_edited_turn: number;
  created_at: number; last_updated: number;
};

type DimEntry = { name: string; stories: Array<{ id: string; title: string }> };

// ── Data Extraction ──────────────────────────────────────────────

function readDb(dbPath: string) {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });

  const stories = (db.prepare("SELECT * FROM stories ORDER BY last_edited_turn DESC").all() as StoryRow[]).map(r => ({
    id: r.id, title: r.title,
    attributes: { subject: r.subject, type: r.type, scenario: r.scenario },
    narrative: r.narrative, activeUntilTurn: r.active_until_turn,
    lastEditedTurn: r.last_edited_turn, createdAt: r.created_at, lastUpdated: r.last_updated,
    tokens: Math.ceil(r.narrative.length / 4),
  }));

  const get = (key: string): string | null =>
    (db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;

  const state = {
    turn: parseInt(get("lastProcessedIdx") ?? "0", 10),
    activeStories: JSON.parse(get("activeStories") || "[]") as string[],
  };

  const msgRows = db.prepare("SELECT role, content, meta FROM messages ORDER BY seq").all() as Array<{ role: string; content: string; meta: string | null }>;
  const allMsgs: Array<{ role: string; content: string; ts?: number; tokens: number; persisted?: boolean }> = [];
  for (const row of msgRows) {
    let dropped = false;
    let ts: number | undefined;
    if (row.meta) {
      try {
        const m = JSON.parse(row.meta);
        dropped = m._dropped === true;
        if (typeof m.timestamp === "number") ts = m.timestamp;
      } catch { /* */ }
    }
    if (!dropped && row.content) {
      allMsgs.push({
        role: row.role || "unknown",
        content: row.content.slice(0, 2000),
        ts,
        tokens: Math.ceil(row.content.length / 4),
        persisted: row.content.startsWith("<persisted-output>"),
      });
    }
  }
  const adjWindow = get("adjustedMessageWindowSize");
  const adjMaxStories = get("adjustedMaxActiveStories");
  const contentFilters = JSON.parse(get("contentFilters") || "[]");

  const subjects = buildDimEntries(db, "subject");
  const types = buildDimEntries(db, "type");
  const scenarios = buildDimEntries(db, "scenario");

  db.close();
  return {
    stories, state,
    allMessages: allMsgs,
    totalMessages: allMsgs.length,
    adjustedMessageWindowSize: adjWindow ? parseInt(adjWindow, 10) : null,
    adjustedMaxActiveStories: adjMaxStories ? parseInt(adjMaxStories, 10) : null,
    dimensions: { subjects, types, scenarios },
    contentFilters,
  };
}

function buildDimEntries(db: Database.Database, dimension: string): DimEntry[] {
  const names = new Set<string>();
  if (dimension === "type") TYPE_PRESETS.forEach(n => names.add(n));
  if (dimension === "scenario") SCENARIO_PRESETS.forEach(n => names.add(n));
  const rows = db.prepare(`SELECT DISTINCT ${dimension} FROM stories`).all() as Array<Record<string, string>>;
  for (const r of rows) if (r[dimension]) names.add(r[dimension]);

  return [...names].map(name => {
    let storyRows = db.prepare(`
      SELECT s.id, s.title FROM stories s JOIN story_entities se ON s.id = se.story_id
      WHERE se.dimension = ? AND se.entity_name = ? ORDER BY s.last_edited_turn DESC
    `).all(dimension, name) as Array<{ id: string; title: string }>;
    if (!storyRows.length) {
      storyRows = (db.prepare(`SELECT id, title FROM stories WHERE ${dimension} = ? ORDER BY last_edited_turn DESC`).all(name) as Array<{ id: string; title: string }>);
    }
    return { name, stories: storyRows };
  });
}

// ── HTML Generation ──────────────────────────────────────────────

function generateHTML(data: ReturnType<typeof readDb>): string {
  const d = data ?? { stories: [], state: { turn: 0, activeStories: [] as string[] }, allMessages: [], totalMessages: 0, adjustedMessageWindowSize: null, adjustedMaxActiveStories: null, dimensions: { subjects: [], types: [], scenarios: [] }, contentFilters: [] };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>story-context</title>
<style>${CSS}</style>
</head>
<body>
<div id="header"><h1>story-context</h1><span class="meta" id="status-bar"></span></div>
<div id="tabs">
  <button class="tab-btn active" data-tab="context">Context</button>
  <button class="tab-btn" data-tab="stories">Stories</button>
  <button class="tab-btn" data-tab="subjects">Subjects</button>
  <button class="tab-btn" data-tab="types">Types</button>
  <button class="tab-btn" data-tab="scenarios">Scenarios</button>
  <button class="tab-btn" data-tab="settings">Settings</button>
</div>
<div id="main"><div id="sidebar"></div><div id="detail"></div></div>
<script>const DATA=${JSON.stringify(d)};\n${JS}</script>
</body>
</html>`;
}

// ── File Discovery ───────────────────────────────────────────────

function findSessionDir(storageDir: string): string | null {
  if (!existsSync(storageDir)) return null;
  const entries = readdirSync(storageDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(storageDir, e.name, "session.db"))) {
      return join(storageDir, e.name);
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────

export function generateInspector(storageDir: string, outputPath?: string): string {
  const sessionDir = findSessionDir(storageDir);
  const data = sessionDir ? readDb(join(sessionDir, "session.db")) : null;
  const html = generateHTML(data);
  const outPath = resolve(outputPath ?? join(storageDir, "inspect.html"));
  writeFileSync(outPath, html, "utf-8");
  return outPath;
}

// ── CLI: watch mode ──────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith("web.ts") || process.argv[1].endsWith("web.js"))) {
  const storageDir = resolve(process.argv[2] || "./data/test-output/smoke");
  const interval = Number(process.argv[3]) || 3000;
  console.log(`Watching: ${storageDir}`);
  console.log(`Interval: ${interval}ms`);

  function tick() {
    try {
      const out = generateInspector(storageDir);
      const sessionDir = findSessionDir(storageDir);
      const data = sessionDir ? readDb(join(sessionDir, "session.db")) : null;
      console.log(`[${new Date().toLocaleTimeString()}] turn=${data?.state.turn ?? 0}, stories=${data?.stories.length ?? 0}, msgs=${data?.totalMessages ?? 0} -> ${out}`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Error:`, e instanceof Error ? e.message : e);
    }
  }

  tick();
  setInterval(tick, interval);
}
