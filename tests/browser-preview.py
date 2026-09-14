"""Create an offline preview using the real view scripts and a small LuCI shim.

Run python tests/browser-preview.py, then open build/preview.html. Synthetic
data only; this checks browser rendering, not the OpenWrt RPC transport.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
resources = ROOT / 'htdocs/luci-static/resources'
shared = (resources / 'multikmwan.js').read_text(encoding='utf-8')
quality = (resources / 'view/multikmwan/quality.js').read_text(encoding='utf-8')
now = 1789142400
data = dict(now=now, hours=24, bucket_seconds=300, wans=[], events=[])
for index, name in enumerate(('Fiber', 'Cable', 'LTE backup')):
    points = []
    for i in range(288):
        if 90 <= i < 100:
            continue
        down = 300 if index == 1 and 180 <= i < 186 else 0
        degraded = 300 if index == 1 and 150 <= i < 180 else 0
        points.append([now-86400+i*300, 300-down-degraded, degraded, down,
                       None if down else (20+index*15+(i % 9)*2 if not degraded else 280+(i % 9)*4),
                       100 if down else (10 if degraded else 0), None if down else 2+index])
    data['wans'].append(dict(name=name, state='healthy', epoch=now-8, interval=20,
                            target='1.1.1.1', reason='probe_ok', coverage=96.5,
                            loss=3.2 if index == 1 else 0, points=points))
data['events'] = [[now-30600, 'Cable', 'recovery', now-32400, 1800, 'probe_recovered'],
                  [now-32400, 'Cable', 'outage', now-32400, 0, 'probe_failed']]
html = '''<!doctype html><meta charset="utf-8"><title>MultiKmwan preview</title>
<style>body{font-family:system-ui,sans-serif;background:#fafafa;color:#222;margin:32px auto;max-width:1060px;padding:0 24px}h2{font-size:26px}h3{margin:4px 0}select{padding:8px}.table{width:100%;font-size:13px;border-collapse:collapse}.table td,.table th{padding:10px;border-bottom:1px solid #ddd;text-align:left}</style>
<div id="app"></div><script>
window._=s=>s;
window.E=function(tag,attrs,kids){
 const n=document.createElement(tag);
 if(typeof attrs==='string'||Array.isArray(attrs)||attrs instanceof Node){kids=attrs;attrs={};}
 Object.entries(attrs||{}).forEach(([k,v])=>{if(typeof v==='function')n.addEventListener(k,v);else if(v!==false)n.setAttribute(k,v===true?'':v);});
 (Array.isArray(kids)?kids:[kids]).forEach(k=>{if(k!=null)n.append(k instanceof Node?k:document.createTextNode(k));});return n;
};
window.view={extend:x=>x}; window.baseclass={extend:x=>x}; window.poll={add:()=>{}};window.ui={};
const data=DATA;
window.rpc={declare:()=>()=>Promise.resolve(data)};
const shared=new Function(SHARED)();
const quality=new Function(QUALITY)();
document.getElementById('app').appendChild(quality.render(data));
document.getElementById('app').appendChild(E('h2',{},'Speed test attribution'));
document.getElementById('app').appendChild(shared.testTable([{epoch:String(data.now-600),wan:'Fiber',kind:'scheduled',label:'Cloudflare',download_host:'speed.cloudflare.com',upload_host:'speed.cloudflare.com',down:'340',up:'45',download_status:'ok',upload_status:'ok'}]));
document.body.dataset.rendered='true';
</script>'''.replace('DATA', json.dumps(data)).replace('SHARED', json.dumps(shared)).replace('QUALITY', json.dumps(quality))
(ROOT / 'build').mkdir(exist_ok=True)
(ROOT / 'build/preview.html').write_text(html, encoding='utf-8')
print(ROOT / 'build/preview.html')
