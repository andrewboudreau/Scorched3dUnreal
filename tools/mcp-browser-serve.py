#!/usr/bin/env python3
"""Live Unreal MCP browser.

Runs a tiny same-origin proxy in front of the UE MCP server (localhost:8000/mcp),
which itself sends no CORS headers and only speaks SSE. The browser page fetches
from this proxy and crawls the MCP live:

    python tools/mcp-browser-serve.py
    -> open http://localhost:8765

Endpoints:
    GET  /                 the browser page
    GET  /api/graph        crawl every toolset (parallel) -> full schema graph
    POST /api/call         {toolset, tool, arguments} -> invoke a tool live
"""
import http.client, http.server, json, os, socketserver, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

MCP_HOST, MCP_PORT = "localhost", 8000
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".mcp-graph-cache.json")
_session = {"id": None}
_lock = threading.Lock()


def _rpc(body, sid=None):
    """One JSON-RPC call. Reads the SSE stream line-by-line and returns the moment
    the response event arrives, instead of waiting for the server's 15s keep-alive."""
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if sid:
        h["Mcp-Session-Id"] = sid
    c = http.client.HTTPConnection(MCP_HOST, MCP_PORT, timeout=30)
    c.request("POST", "/mcp", json.dumps(body), h)
    r = c.getresponse()
    new_sid = r.getheader("Mcp-Session-Id")
    out = None
    if r.getheader("Content-Type", "").startswith("application/json"):
        out = json.loads(r.read().decode())
    else:
        while True:
            ln = r.readline()
            if not ln:
                break
            ln = ln.decode().strip()
            if ln.startswith("data:"):
                out = json.loads(ln[5:].strip())
                break
    c.close()
    return out, new_sid


def _ensure_session():
    with _lock:
        if _session["id"]:
            return _session["id"]
        init, sid = _rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                          "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "mcp-browser", "version": "1"}}})
        _rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        _session["id"] = sid
        return sid


def _call_tool(name, args=None, _retry=True):
    sid = _ensure_session()
    resp, _ = _rpc({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                    "params": {"name": name, "arguments": args or {}}}, sid)
    if resp is None or "error" in (resp or {}):
        if _retry:  # session may have expired; re-init once
            _session["id"] = None
            return _call_tool(name, args, _retry=False)
    return resp


def _text(resp):
    try:
        return resp["result"]["content"][0]["text"]
    except Exception:
        return ""


def crawl_graph():
    listing = _text(_call_tool("list_toolsets"))
    names = [l[2:].split(":", 1)[0].strip()
             for l in listing.splitlines() if l.strip().startswith("- ") and ":" in l]

    def describe(n):
        try:
            return json.loads(_text(_call_tool("describe_toolset", {"toolset_name": n})))
        except Exception as e:
            return {"name": n, "description": f"(failed to load: {e})", "tools": []}

    with ThreadPoolExecutor(max_workers=8) as ex:
        graph = list(ex.map(describe, names))
    return graph


def load_cache():
    try:
        with open(CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def get_graph(fresh=False):
    """Return {crawledAt, graph}. Serves the disk cache unless fresh is requested
    or no cache exists yet; a fresh crawl rewrites the cache."""
    if not fresh:
        cached = load_cache()
        if cached and cached.get("graph"):
            return cached
    payload = {"crawledAt": time.time(), "graph": crawl_graph()}
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass
    return payload


PAGE = r"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unreal MCP Browser (live)</title>
<style>
 :root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--txt:#c9d1d9;--muted:#8b949e;
   --accent:#58a6ff;--req:#f85149;--type:#7ee787;--hover:#1f2733;--ok:#3fb950;}
 *{box-sizing:border-box}
 body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);
   color:var(--txt);display:flex;height:100vh;overflow:hidden}
 code,.mono{font-family:"SF Mono",Consolas,Menlo,monospace}
 #side{width:360px;flex-shrink:0;border-right:1px solid var(--border);display:flex;
   flex-direction:column;background:var(--panel)}
 header{padding:14px 16px;border-bottom:1px solid var(--border)}
 header h1{margin:0 0 6px;font-size:15px;display:flex;align-items:center;gap:8px}
 .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
 .dot.live{background:var(--ok);box-shadow:0 0 6px var(--ok)}
 .stat{color:var(--muted);font-size:12px}
 #search{width:100%;margin-top:10px;padding:7px 10px;background:var(--bg);
   border:1px solid var(--border);border-radius:6px;color:var(--txt);font-size:13px}
 .btnrow{display:flex;gap:6px;margin-top:8px}
 .btnrow button{flex:1;padding:6px;background:var(--bg);color:var(--accent);
   border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px}
 .btnrow button:hover{background:var(--hover)}
 #collapseAll,#expandAll{flex:0 0 auto;color:var(--muted);min-width:48px}
 #list{overflow-y:auto;flex:1}
 .ts-head{padding:9px 16px 5px;font-weight:600;font-size:11px;text-transform:uppercase;
   letter-spacing:.05em;color:var(--muted);position:sticky;top:0;background:var(--panel);
   cursor:pointer;user-select:none}
 .ts-head:hover{color:var(--txt)}
 .ts-head .caret{display:inline-block;width:14px;color:var(--muted)}
 .tool-item{padding:5px 16px 5px 26px;cursor:pointer;border-left:2px solid transparent;
   white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
 .tool-item:hover{background:var(--hover)}
 .tool-item.active{background:var(--hover);border-left-color:var(--accent);color:var(--accent)}
 #main{flex:1;overflow-y:auto;padding:28px 40px}
 #main h2{margin:0 0 4px;font-size:21px;color:var(--accent)}
 .pill{display:inline-block;background:var(--bg);border:1px solid var(--border);border-radius:10px;
   padding:1px 8px;font-size:11px;color:var(--muted);margin-left:8px}
 .ts-label{color:var(--muted);font-size:12px;margin-bottom:18px}
 .desc{white-space:pre-wrap;margin-bottom:8px;max-width:72ch}
 .section-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
   margin:26px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}
 table{width:100%;border-collapse:collapse;font-size:13px;max-width:90ch}
 th{text-align:left;color:var(--muted);font-weight:600;padding:6px 10px;border-bottom:1px solid var(--border)}
 td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
 td.pname{color:var(--accent);font-family:Consolas,monospace;white-space:nowrap}
 td.ptype{color:var(--type);font-family:Consolas,monospace;white-space:nowrap}
 .req{color:var(--req);font-size:11px;margin-left:6px}
 .enum{color:var(--muted);font-size:12px}
 .empty{color:var(--muted);font-style:italic}
 details{margin-top:14px;max-width:90ch}summary{cursor:pointer;color:var(--muted);font-size:12px}
 pre{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px;
   overflow-x:auto;font-size:12px;white-space:pre-wrap}
 .runbar{margin-top:14px;max-width:90ch}
 .runbar textarea{width:100%;height:64px;background:var(--bg);color:var(--txt);
   border:1px solid var(--border);border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:12px}
 .runbar button{margin-top:8px;padding:6px 14px;background:var(--accent);color:#0d1117;border:0;
   border-radius:6px;cursor:pointer;font-weight:600}
 .placeholder{color:var(--muted);margin-top:40px;text-align:center}
</style></head><body>
<div id="side">
 <header>
  <h1><span id="dot" class="dot"></span>Unreal MCP <span style="color:var(--muted);font-weight:400">live</span></h1>
  <div class="stat" id="stat">connecting&hellip;</div>
  <input id="search" placeholder="Filter tools&hellip;" autocomplete="off" autofocus>
  <div class="btnrow">
   <button id="refresh" title="Re-crawl the MCP server live">&#x21bb; re-crawl</button>
   <button id="collapseAll" title="Collapse all groups">&minus; all</button>
   <button id="expandAll" title="Expand all groups">&plus; all</button>
  </div>
 </header>
 <div id="list"></div>
</div>
<div id="main"><div class="placeholder">Crawling the MCP server&hellip;</div></div>
<script>
let GRAPH=[],active=null,curTool=null;
const $=s=>document.querySelector(s), listEl=$("#list"), main=$("#main"),
 search=$("#search"), stat=$("#stat"), dot=$("#dot");
const shortTs=t=>t.name.split(".").pop(), shortTool=n=>n.split(".").pop();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const collapsed=new Set(JSON.parse(localStorage.getItem("mcpCollapsed")||"[]"));
const saveCollapsed=()=>localStorage.setItem("mcpCollapsed",JSON.stringify([...collapsed]));
function ago(ts){ if(!ts)return""; const s=Math.max(0,Date.now()/1000-ts);
 if(s<60)return"just now"; if(s<3600)return Math.floor(s/60)+"m ago";
 if(s<86400)return Math.floor(s/3600)+"h ago"; return Math.floor(s/86400)+"d ago"; }

async function crawl(fresh){
 if(fresh){ stat.textContent="crawling…"; dot.classList.remove("live");
  main.innerHTML='<div class="placeholder">Crawling the MCP server…</div>'; }
 try{
  const r=await fetch("/api/graph"+(fresh?"?fresh=1":"")); const data=await r.json();
  GRAPH=data.graph||[]; const tools=GRAPH.reduce((a,t)=>a+(t.tools||[]).length,0);
  stat.innerHTML=GRAPH.length+" toolsets · "+tools+" tools · <span title=\""+
   (data.crawledAt?new Date(data.crawledAt*1000).toLocaleString():"")+"\">cached "+ago(data.crawledAt)+"</span>";
  dot.classList.add("live"); render(search.value);
 }catch(e){ stat.textContent="error: "+e; main.innerHTML='<div class="placeholder">Could not reach proxy. Is it running?</div>'; }
}
function render(f){
 f=(f||"").toLowerCase(); listEl.innerHTML="";
 GRAPH.forEach(ts=>{
  const tools=(ts.tools||[]).filter(t=>!f||t.name.toLowerCase().includes(f)||(t.description||"").toLowerCase().includes(f));
  if(!tools.length)return;
  const isOpen = f ? true : !collapsed.has(ts.name);   // filtering forces groups open
  const h=document.createElement("div");h.className="ts-head"+(isOpen?"":" closed");
  h.innerHTML='<span class="caret">'+(isOpen?"▾":"▸")+'</span>'+esc(shortTs(ts))+" ("+tools.length+")";
  h.title=ts.name;
  h.onclick=()=>{ if(collapsed.has(ts.name))collapsed.delete(ts.name); else collapsed.add(ts.name);
   saveCollapsed(); render(search.value); };
  listEl.appendChild(h);
  if(!isOpen)return;
  tools.forEach(t=>{const it=document.createElement("div");it.className="tool-item";it.textContent=shortTool(t.name);it.title=t.name;
   if(active&&active._tool===t.name)it.classList.add("active");
   it.onclick=e=>{e.stopPropagation();show(ts,t,it);};listEl.appendChild(it);});
 });
}
function schemaTable(s){
 if(!s||!s.properties||!Object.keys(s.properties).length)return '<div class="empty">No parameters.</div>';
 const req=new Set(s.required||[]);let rows="";
 for(const[k,v]of Object.entries(s.properties)){
  const ty=v.type||(v.enum?"enum":"")||(v.title||"object");
  const en=v.enum?'<div class="enum mono">['+v.enum.join(", ")+"]</div>":"";
  rows+='<tr><td class="pname">'+esc(k)+(req.has(k)?'<span class="req">req</span>':"")+'</td><td class="ptype">'+esc(ty)+'</td><td>'+esc(v.description||"")+en+"</td></tr>";
 }
 return '<table><thead><tr><th>Param</th><th>Type</th><th>Description</th></tr></thead><tbody>'+rows+"</tbody></table>";
}
function show(ts,t,el){
 if(active)active.classList.remove("active"); if(el){el.classList.add("active");el._tool=t.name;active=el;}
 curTool={toolset:ts.name,tool:t.name};
 main.innerHTML='<h2>'+esc(shortTool(t.name))+'<span class="pill">'+esc(shortTs(ts))+'</span></h2>'+
  '<div class="ts-label mono">'+esc(t.name)+'</div><div class="desc">'+esc(t.description||"")+'</div>'+
  '<div class="section-title">Input parameters</div>'+schemaTable(t.inputSchema)+
  '<div class="section-title">Output</div>'+schemaTable(t.outputSchema)+
  '<div class="section-title">Run live</div><div class="runbar"><textarea id="args">{}</textarea><br>'+
  '<button id="run">&#9654; call '+esc(shortTool(t.name))+'</button><pre id="result" style="display:none"></pre></div>'+
  '<details><summary>Raw JSON schema</summary><pre>'+esc(JSON.stringify(t,null,2))+'</pre></details>';
 main.scrollTop=0;
 $("#run").onclick=runTool;
}
async function runTool(){
 const out=$("#result"),btn=$("#run");let args;
 try{args=JSON.parse($("#args").value||"{}");}catch(e){out.style.display="block";out.textContent="Invalid JSON args: "+e;return;}
 btn.disabled=true;btn.textContent="…running";out.style.display="block";out.textContent="calling…";
 try{
  const r=await fetch("/api/call",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({toolset:curTool.toolset,tool:shortTool(curTool.tool),arguments:args})});
  out.textContent=JSON.stringify(await r.json(),null,2);
 }catch(e){out.textContent="error: "+e;}
 btn.disabled=false;btn.textContent="▶ call";
}
search.oninput=()=>render(search.value);
$("#refresh").onclick=()=>crawl(true);
$("#collapseAll").onclick=()=>{ GRAPH.forEach(ts=>collapsed.add(ts.name)); saveCollapsed(); render(search.value); };
$("#expandAll").onclick=()=>{ collapsed.clear(); saveCollapsed(); render(search.value); };
crawl(false);
</script></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif self.path.startswith("/api/graph"):
            fresh = "fresh=1" in self.path
            try:
                self._send(200, json.dumps(get_graph(fresh)))
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path == "/api/call":
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            try:
                # Editor tools are reached *through* the gateway's call_tool:
                # bare tool name + its toolset are passed as arguments.
                resp = _call_tool("call_tool", {"tool_name": req["tool"],
                                                "toolset_name": req["toolset"],
                                                "arguments": req.get("arguments") or {}})
                self._send(200, json.dumps(resp))
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"Unreal MCP browser:  http://localhost:{LISTEN_PORT}")
    print(f"Proxying ->          http://{MCP_HOST}:{MCP_PORT}/mcp")
    Server(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
