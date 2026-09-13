"""Compile an authored spatial plan into diagrams and an H3 prompt, offline."""
from __future__ import annotations

import argparse
import hashlib
import html
import itertools
import json
import math
from pathlib import Path


def require(ok, message):
    if not ok:
        raise ValueError(message)


def number(x):
    return type(x) in (int, float) and math.isfinite(x)


def vec(v):
    return isinstance(v, list) and len(v) == 3 and all(number(x) for x in v)


def sub(a, b):
    return [x - y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a)
    require(n > 1e-8, "zero camera direction")
    return [x / n for x in a]


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def at(entity, t):
    keys = entity["keys"]
    for a, b in zip(keys, keys[1:]):
        if t <= b["t"]:
            f = max(0, (t-a["t"])/(b["t"]-a["t"]))
            return [x+(y-x)*f for x, y in zip(a["position"], b["position"])]
    return keys[-1]["position"]


def segment_box(a, b, half):
    """Whether a segment enters the open, origin-centered AABB."""
    lo, hi = 0.0, 1.0
    for x, y, h in zip(a, b, half):
        h -= 1e-7  # boundary contact is not penetration
        d = y-x
        if abs(d) < 1e-12:
            if abs(x) >= h:
                return False
        else:
            u, v = sorted(((-h-x)/d, (h-x)/d))
            lo, hi = max(lo, u), min(hi, v)
            if lo >= hi:
                return False
    return hi > 0 and lo < 1


def corners(entity, t):
    p = at(entity, t)
    return [[p[i]+sign[i]*entity["size"][i]/2 for i in range(3)]
            for sign in itertools.product((-1, 1), repeat=3)]


def camera_basis(shot):
    forward = unit(sub(shot["target"], shot["position"]))
    right = unit(cross([0, 1, 0], forward))
    up = cross(forward, right)
    return right, up, forward


def camera_coords(p, shot):
    delta = sub(p, shot["position"])
    return [dot(delta, axis) for axis in camera_basis(shot)]


def may_be_visible(entity, t, shot):
    # Conservative bounding sphere vs frustum: occlusion is deliberately ignored.
    x, y, z = camera_coords(at(entity, t), shot)
    radius = norm(entity["size"])/2
    vfov = math.radians(shot["fov"])/2
    hfov = math.atan(math.tan(vfov)*16/9)
    if z+radius <= 0:
        return False
    return (abs(x)*math.cos(hfov)-z*math.sin(hfov) <= radius
            and abs(y)*math.cos(vfov)-z*math.sin(vfov) <= radius)


def validate(plan):
    require(plan.get("version") == 1, "version must be 1")
    require(number(plan.get("duration")) and 0 < plan["duration"] <= 60, "invalid duration")
    duration = plan["duration"]
    if "ending_title" in plan:
        require(plan["ending_title"] in ("TRUE END", "NORMAL END", "BAD END"), "invalid ending_title")
        require(number(plan.get("title_at")) and 0 <= plan["title_at"] < duration - .6, "invalid title_at")
        require(plan["title_at"] > plan["reveal"]["at"], "title must follow outcome reveal")
    require(vec(plan.get("room")) and min(plan["room"]) > 0, "invalid room")
    require(number(plan.get("max_speed")) and plan["max_speed"] > 0, "invalid max_speed")
    for key in ("continuity", "outcome"):
        require(isinstance(plan.get(key), str) and plan[key].strip(), f"missing {key}")
    require(isinstance(plan.get("assumptions"), list) and all(isinstance(v, str) for v in plan["assumptions"]), "invalid assumptions")
    entities = plan.get("entities")
    require(isinstance(entities, list) and entities, "entities required")
    ids = [e["id"] for e in entities]
    require(all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids), "duplicate/invalid entity id")
    for e in entities:
        for key in ("name", "description", "support"):
            require(isinstance(e.get(key), str) and e[key].strip(), f"{e['id']}: missing {key}")
        require(type(e.get("solid")) is bool, "solid must be boolean")
        require(vec(e.get("size")) and min(e["size"]) > 0, "invalid size")
        keys = e.get("keys")
        require(isinstance(keys, list) and len(keys) >= 2, "two endpoint keys required")
        require(all(number(k.get("t")) and vec(k.get("position")) for k in keys), "invalid key")
        require(keys[0]["t"] == 0 and keys[-1]["t"] == duration, "keys must cover full duration")
        for k in keys:
            require(all(s/2 <= p <= r-s/2 for p, s, r in zip(k["position"], e["size"], plan["room"])), f"{e['id']}: outside room")
        for a, b in zip(keys, keys[1:]):
            require(b["t"] > a["t"], "keys must increase")
            speed = norm(sub(b["position"], a["position"]))/ (b["t"]-a["t"])
            require(speed <= plan["max_speed"], f"{e['id']}: speed exceeds limit")
    contacts = plan.get("allow_contact", [])
    require(isinstance(contacts, list), "invalid allow_contact")
    for pair in contacts:
        require(isinstance(pair, list) and len(pair) == 2 and pair[0] != pair[1] and all(i in ids for i in pair), "invalid contact pair")
    allowed = {frozenset(pair) for pair in contacts}
    for a, b in itertools.combinations([e for e in entities if e["solid"]], 2):
        if frozenset((a["id"], b["id"])) in allowed:
            continue
        times = sorted({k["t"] for e in (a,b) for k in e["keys"]})
        half = [(x+y)/2 for x,y in zip(a["size"], b["size"])]
        for t0, t1 in zip(times, times[1:]):
            require(not segment_box(sub(at(a,t0),at(b,t0)), sub(at(a,t1),at(b,t1)), half), f"collision: {a['id']} / {b['id']}")
    shots = plan.get("shots")
    require(isinstance(shots, list) and shots, "shots required")
    last = 0
    for shot in shots:
        require(number(shot.get("from")) and number(shot.get("to")) and shot["from"] == last and shot["to"] > last, "shots must be contiguous")
        require(vec(shot.get("position")) and vec(shot.get("target")), "invalid camera")
        require(number(shot.get("fov")) and 10 <= shot["fov"] <= 100, "invalid FOV")
        require(all(0 < x < r for x,r in zip(shot["position"], plan["room"])), "camera outside room")
        for key in ("action", "sound"):
            require(isinstance(shot.get(key), str) and shot[key].strip(), f"missing shot {key}")
        camera_basis(shot)
        for e in entities:
            if not e["solid"]:
                continue
            times = sorted({shot["from"], shot["to"]} | {k["t"] for k in e["keys"] if shot["from"] < k["t"] < shot["to"]})
            for t0,t1 in zip(times,times[1:]):
                require(not segment_box(sub(shot["position"],at(e,t0)), sub(shot["position"],at(e,t1)), [s/2 for s in e["size"]]), f"camera intersects {e['id']}")
        last = shot["to"]
    require(last == duration, "shots must cover duration")
    reveal = plan.get("reveal", {})
    require(number(reveal.get("at")) and 0 < reveal["at"] < duration, "invalid reveal time")
    require(isinstance(reveal.get("entities"), list) and reveal["entities"] and all(i in ids for i in reveal["entities"]), "invalid reveal entities")
    for e in entities:
        if e["id"] not in reveal["entities"]:
            continue
        # Reveal objects must be static so constant shot frustum tests cover all time.
        require(all(k["position"] == e["keys"][0]["position"] for k in e["keys"]), "reveal devices must be static")
        for shot in shots:
            if shot["from"] < reveal["at"]:
                require(not may_be_visible(e, shot["from"], shot), f"early reveal risk: {e['id']}")
        require(may_be_visible(e, duration, shots[-1]), f"final device out of frame: {e['id']}")
    return {"geometry_checks": "passed", "method": "continuous swept AABBs; conservative static-device frustum bounds",
            "limits": ["No anatomy, articulation, grip, support-force or light simulation", "Occlusion ignored in reveal test", "Final in-frame test does not prove unobstructed readability", "No generated-video or audience review"],
            "design_review": "required separately", "generated_video_review": "human"}


def xyz(p):
    return "("+", ".join(f"{x:.2f}" for x in p)+") m"


def prompt(plan):
    lines = [f"{plan['duration']}-second realistic cinematic 3D mystery ending.", plan["continuity"],
             "SPATIAL CONTRACT: meters; x right, y up, z deeper into room. Room dimensions "+xyz(plan["room"])+". Coordinates describe one fixed world, never relocate its walls or devices between shots.",
             "Only environmental ambience and physical sound effects. NO speech, dialogue, narration, whispering words, singing or music. No explanatory subtitles or UI. Only the explicitly specified ending title may appear as added text.",
             "FIXED OUTCOME (internal direction, do not display as text): "+plan["outcome"],
             f"Reveal the outcome devices only from {plan['reveal']['at']:.1f}s in the final scene; never earlier."]
    for e in plan["entities"]:
        lines.append(f"{e['id']} — {e['description']}; size {xyz(e['size'])}; support: {e['support']}.")
        if all(k["position"] == e["keys"][0]["position"] for k in e["keys"]):
            lines.append("Stays fixed at "+xyz(e["keys"][0]["position"])+" throughout. No translation.")
        else:
            for a,b in zip(e["keys"],e["keys"][1:]):
                distance = norm(sub(b["position"],a["position"]))
                lines.append(f"{a['t']:g}-{b['t']:g}s: {xyz(a['position'])} to {xyz(b['position'])}; straight segment {distance:.2f} m at {distance/(b['t']-a['t']):.2f} m/s. "+("Hold still." if distance == 0 else "No overshoot or sudden change of side."))
    for i,s in enumerate(plan["shots"]):
        lines.append(f"SHOT {i+1}, {s['from']:g}-{s['to']:g}s: "+("Start at reference frame. " if i == 0 else "Explicit editorial hard cut, not object teleportation. ")+f"Camera fixed at {xyz(s['position'])}, looking at {xyz(s['target'])}, vertical field of view {s['fov']} degrees. {s['action']} SOUND: {s['sound']}")
    lines.append("Preserve continuous object positions across cuts. No wall penetration, duplicated tools, support changes, new gameplay action, extra cleared obstacle or human face reveal. Match start and end references at their respective times, not by morphing the room.")
    if "ending_title" in plan:
        lines.append(f'At {plan["title_at"]:g}s, introduce exactly "{plan["ending_title"]}" as a single-line screen-space title in reserved negative space, clear of the person and outcome evidence. Bold off-white sans-serif, a narrow amber edge, one short scale overshoot and light sweep; settle within 0.6 seconds and hold crisp through the end. Cast no light onto the room or devices. No earlier title or additional text. Use only the established physical sound, no synthetic title sting.')
    return "\n\n".join(lines)+"\n"


COLORS = ["#60a5fa", "#fbbf24", "#34d399", "#c084fc", "#fb7185", "#22d3ee", "#a3e635", "#f97316"]


def frame_svg(plan, shot, t):
    """Perspective blocking diagram, explicitly not a generated film still."""
    focal = 270/math.tan(math.radians(shot["fov"])/2)
    faces = []
    for idx,e in enumerate(plan["entities"]):
        pts = [camera_coords(p,shot) for p in corners(e,t)]
        for face in ((0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)):
            ps = [pts[i] for i in face]
            if min(p[2] for p in ps) <= .05:
                continue
            xy = " ".join(f"{480+focal*p[0]/p[2]:.1f},{270-focal*p[1]/p[2]:.1f}" for p in ps)
            faces.append((sum(p[2] for p in ps), f'<polygon points="{xy}" fill="{COLORS[idx%len(COLORS)]}" fill-opacity=".5" stroke="#cbd5e1"/>'))
    drawing = "".join(f[1] for f in sorted(faces, key=lambda f:-f[0]))
    labels=[]
    for e in plan["entities"]:
        x,y,z = camera_coords(at(e,t),shot)
        if z>.05:
            px,py = 480+focal*x/z,270-focal*y/z
            if 0 < px < 960 and 0 < py < 540:
                labels.append(f'<text x="{px:.1f}" y="{py:.1f}" fill="white" font-size="18">{html.escape(e["id"])}</text>')
    return '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#111827"/>'+drawing+"".join(labels)+'</svg>'


def preview(plan):
    data = json.dumps(plan,ensure_ascii=False).replace("<", "\\u003c")
    # Self-contained playback, no libraries or network. Same linear interpolation as compiler.
    return '''<!doctype html><html lang="ja"><meta charset="utf-8"><title>空間と動線</title>
<style>body{background:#101827;color:#e5e7eb;font:16px system-ui;margin:24px auto;max-width:1000px;padding:0 18px}svg{background:#172338;width:100%;border-radius:12px}button,input{accent-color:#38bdf8}button{padding:8px 18px}input{width:65%}.views{display:grid;grid-template-columns:1fr 1fr;gap:20px}p{line-height:1.6}#legend{display:flex;flex-wrap:wrap;gap:12px}small{color:#b0bed0}@media(max-width:650px){.views{grid-template-columns:1fr}}</style>
<h1>空間と動線</h1><p>配置図とカメラの切り替え。寸法は映像制作のための仮定です。</p>
<button id="play">再生</button> <input id="time" type="range" min="0" step="0.05" value="0" aria-label="時刻"><output id="clock"></output>
<div class="views"><section><h2>上から（x・z）</h2><svg id="top" viewBox="0 0 500 600" role="img" aria-label="平面図"></svg></section><section><h2>横から（z・高さ）</h2><svg id="side" viewBox="0 0 600 340" role="img" aria-label="側面図"></svg><p id="shot"></p><small id="note"></small></section></div><p id="legend"></p>
<script>const p=__DATA__,colors=__COLORS__,slider=document.getElementById('time');slider.max=p.duration;
const pos=(e,t)=>{let a=e.keys[0];for(let b of e.keys.slice(1)){if(t<=b.t){const f=Math.max(0,(t-a.t)/(b.t-a.t));return a.position.map((x,i)=>x+(b.position[i]-x)*f)}a=b}return a.position};
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function draw(){const t=+slider.value,s=p.shots.find(s=>t>=s.from&&t<s.to)||p.shots.at(-1),sx=440/p.room[0],sz=540/p.room[2],dz=540/p.room[2],dy=270/p.room[1];let top='<rect x="30" y="30" width="440" height="540" fill="none" stroke="#64748b"/>',side='<rect x="30" y="30" width="540" height="270" fill="none" stroke="#64748b"/>';
p.entities.forEach((e,i)=>{const [x,y,z]=pos(e,t),[w,h,d]=e.size,c=colors[i%colors.length];top+=`<polyline points="${e.keys.map(k=>`${30+k.position[0]*sx},${570-k.position[2]*sz}`).join(' ')}" fill="none" stroke="${c}" stroke-dasharray="5 4"/><rect x="${30+(x-w/2)*sx}" y="${570-(z+d/2)*sz}" width="${w*sx}" height="${d*sz}" fill="${c}" fill-opacity=".6"/><text x="${30+x*sx}" y="${562-z*sz}" fill="white" font-size="12">${esc(e.id)}</text>`;side+=`<rect x="${30+(z-d/2)*dz}" y="${300-(y+h/2)*dy}" width="${d*dz}" height="${h*dy}" fill="${c}" fill-opacity=".6"/>`});
const cx=30+s.position[0]*sx,cz=570-s.position[2]*sz,tx=30+s.target[0]*sx,tz=570-s.target[2]*sz;top+=`<circle cx="${cx}" cy="${cz}" r="7" fill="white"/><path d="M${cx},${cz} L${tx},${tz}" stroke="white" stroke-width="2"/><text x="${cx+10}" y="${cz}" fill="white">camera</text>`;side+=`<circle cx="${30+s.position[2]*dz}" cy="${300-s.position[1]*dy}" r="6" fill="white"/><path d="M${30+s.position[2]*dz},${300-s.position[1]*dy} L${30+s.target[2]*dz},${300-s.target[1]*dy}" stroke="white"/>`;
document.getElementById('top').innerHTML=top;document.getElementById('side').innerHTML=side;document.getElementById('clock').textContent=t.toFixed(1)+' 秒';document.getElementById('shot').textContent=`カット ${p.shots.indexOf(s)+1} · ${s.from}〜${s.to}秒`;document.getElementById('note').textContent=s.action;}
document.getElementById('legend').innerHTML=p.entities.map((e,i)=>`<span style="color:${colors[i%colors.length]}">${esc(e.id)}: ${esc(e.name)}</span>`).join('');let running=false,stamp=0,playTime=0;const button=document.getElementById('play');button.onclick=()=>{running=!running;button.textContent=running?'一時停止':'再生';if(+slider.value>=p.duration)slider.value=0;playTime=+slider.value;stamp=performance.now();};slider.oninput=()=>{playTime=+slider.value;draw()};function tick(now){if(running){playTime=Math.min(p.duration,playTime+(now-stamp)/1000);slider.value=playTime;draw();if(+slider.value>=p.duration){running=false;button.textContent='再生'}}stamp=now;requestAnimationFrame(tick)}draw();requestAnimationFrame(tick);</script></html>'''.replace("__DATA__", data).replace("__COLORS__", json.dumps(COLORS))


def compile_plan(source, output):
    raw = source.read_bytes()
    plan = json.loads(raw.decode("utf-8-sig"))
    checks = validate(plan)
    checks["source_sha256"] = hashlib.sha256(raw).hexdigest()
    output.mkdir(parents=True, exist_ok=False)
    (output/"staging.json").write_bytes(raw)
    (output/"checks.json").write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding="utf-8")
    (output/"video-prompt.txt").write_text(prompt(plan),encoding="utf-8")
    (output/"preview.html").write_text(preview(plan),encoding="utf-8")
    for i,s in enumerate(plan["shots"]):
        for label,t in (("start",s["from"]),("end",s["to"])):
            (output/f"shot-{i+1}-{label}.svg").write_text(frame_svg(plan,s,t),encoding="utf-8")
    return checks


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(compile_plan(args.input,args.output),ensure_ascii=False,indent=2))
    except (ValueError,KeyError,TypeError,OSError) as exc:
        parser.exit(1,f"staging failed: {exc}\n")
