<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Belépés – KapuMail</title>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--ink:#1a1733;--soft:#4a4666;--mute:#6b6786;--line:rgba(40,30,90,.14);--accent:#4a36e0;--night:#17112e}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Figtree,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:linear-gradient(135deg,#f6dbe9,#e6dbf7 40%,#dcd8fa 65%,#f7e4dc);padding:24px}
.shell{width:100%;max-width:1180px;display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1fr);background:rgba(255,255,255,.86);backdrop-filter:blur(24px);border:1px solid #fff;border-radius:36px;padding:12px;box-shadow:0 30px 80px -30px rgba(60,35,120,.4)}

.scene{position:relative;border-radius:26px;overflow:hidden;min-height:700px;background:var(--night);color:#fff}
.slide{position:absolute;inset:0;margin:0;display:flex;align-items:flex-end;opacity:0;visibility:hidden;transition:opacity .7s ease,visibility 0s .7s}
.slide.on{opacity:1;visibility:visible;transition:opacity .7s ease}
.slide img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 12%}
.slide::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(23,17,46,0) 36%,rgba(23,17,46,.72) 58%,var(--night) 80%)}
.slide figcaption{position:relative;z-index:1;padding:40px 40px 118px}
.ctrl{position:absolute;z-index:2;left:40px;right:40px;bottom:32px;display:flex;align-items:center;gap:10px}
.dots{display:flex;margin-right:auto;margin-left:-7px}
.dots button{flex:none;width:20px;height:24px;padding:0;border:0;background:none;display:grid;place-items:center}
.dots button::before{content:"";width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.35);transition:transform .25s,background .25s}
.dots button[aria-current]::before{background:#fff;transform:scale(1.5)}
.nav{flex:none;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.06);color:#fff;display:grid;place-items:center;padding:0}
.nav:hover{background:rgba(255,255,255,.18)}
.nav svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.scene :focus-visible{outline-color:#fff}
.scene strong{display:block;font-size:clamp(30px,3.3vw,44px);font-weight:700;line-height:1.08;letter-spacing:-.03em;text-wrap:balance}
.scene span{display:block;margin-top:14px;max-width:34ch;font-size:16px;line-height:1.5;color:rgba(255,255,255,.82)}

.side{display:flex;flex-direction:column;justify-content:center;padding:40px clamp(24px,6vw,88px)}
.form{width:100%;max-width:420px;margin:0 auto}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:19px;letter-spacing:-.01em}
.brand img{width:54px;height:auto}
h1{font-size:clamp(34px,3.4vw,44px);line-height:1.05;letter-spacing:-.035em;font-weight:800;margin:28px 0 10px}
.lead{color:var(--soft);font-size:16px;line-height:1.5;margin:0 0 28px}
label{display:grid;gap:7px;font-size:14px;font-weight:600;margin-bottom:16px}
input{font:inherit;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:#fff;color:var(--ink);width:100%}
input:hover{border-color:rgba(40,30,90,.3)}
button{font:inherit;cursor:pointer;color:inherit}
:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px}
.go{width:100%;margin-top:8px;padding:15px;border:0;border-radius:999px;background:#15131c;color:#fff;font-weight:600;font-size:16px;transition:background .15s}
.go:hover{background:var(--accent)}
.alt{margin:18px 0 0;text-align:center;font-size:14.5px;color:var(--soft)}.alt a{color:var(--accent);font-weight:600;text-decoration:none}.alt a:hover{text-decoration:underline}
.err{background:#ffe1e7;color:#a3193a;border-radius:14px;padding:12px 14px;margin-bottom:16px;font-weight:500}

.demo{margin-top:28px;padding-top:22px;border-top:1px solid var(--line)}
.demo b{font-size:14px}
.demo p{font-size:13px;color:var(--mute);margin:2px 0 12px}
.users{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.users button{display:grid;gap:1px;text-align:left;padding:10px 14px;border-radius:14px;border:1px solid var(--line);background:#fff;font-weight:600;font-size:14px;min-width:0}
.users button:hover{border-color:var(--accent);background:#f5f3ff}
.users small{font-weight:400;font-size:12.5px;color:var(--mute)}

@media (max-width:860px){
  body{padding:12px;place-items:start center}
  .shell{grid-template-columns:1fr;border-radius:28px;padding:8px}
  .scene{min-height:0;height:320px;border-radius:21px}
  .slide::after{background:linear-gradient(180deg,rgba(23,17,46,0) 30%,rgba(23,17,46,.92) 88%)}
  .slide figcaption{padding:20px 22px 50px}
  .scene strong{font-size:23px}.scene span{display:none}
  .ctrl{left:22px;right:22px;bottom:12px}
  .nav{display:none}
  .side{padding:28px 18px 26px}
  h1{margin-top:22px}
}
@media (max-width:400px){.users{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.go,.slide,.slide.on,.dots button::before{transition:none}}
/* Asztali app: saját húzósáv, különben az indítóképernyő teljes ablakos húzóterülete ráragad az oldalra, és semmi sem kattintható. */
.winbar{position:fixed;top:0;left:0;right:0;height:28px;z-index:60;-webkit-app-region:drag}
</style></head><body><div class="winbar" aria-hidden="true"></div><div class="shell">
@php($slides=[
 ['konyvelo','Könyvelő a laptopjánál, a plüssfigura egy iratot nyújt felé','A hivatalos posta már rendezve vár.','Az Ügyfélkapu és a Cégkapu küldeményei ügyfelenként, egy helyen – nem kell tárhelyről tárhelyre járnod.'],
 ['idos','Idősebb könyvelő mosolyog a plüssfigurára, amely iratot tart felé','Szól, ha egy hitelesítés lejárt.','Az újrahitelesítés pár lépés, és megy tovább a letöltés.'],
 ['reggel','Könyvelő kávéval érkezik, az asztalon szétválogatott iratkupacok','Reggelre minden a helyén.','Ügyfelenként szétválogatva találod, ami a tárhelyekre érkezett.'],
 ['junior','Fiatal könyvelő a monitor előtt, a plüssfigura a képernyőre mutat','Egy lista az iroda összes tárhelyéről.','Ügyfélkapu, Cégkapu és NAV – nem kell egyenként belépned.'],
 ['ugyfel','Könyvelő tabletet mutat az ügyfelének, a plüssfigura mappát tart','Az ügyfél kérdez, az irat már előtted van.','Minden küldemény ügyfelenként visszakereshető.'],
 ['vezeto','Irodavezető tablettel, a plüssfigura borítékot nyújt felé','A vezető lát mindent, és jóváhagy.','Mindenki a saját szerepe szerint fér hozzá az iratokhoz.'],
 ['csapat','Két kolléga nevet az asztalnál, köztük a plüssfigura','Az egész iroda ugyanazt látja.','Nincs több továbbított e-mail és elveszett csatolmány.'],
 ['este','Könyvelő becsukja a laptopot, és ököllel koccint a plüssfigurával','A nap végén semmi sem marad a kapukban.','Amit letöltött, az megvan – nyugodtan zárhatod a gépet.'],
])
<section class="scene" aria-roledescription="diavetítés" aria-label="Mire jó a KapuMail">
@foreach($slides as $k=>$s)
<figure class="slide{{ $k===0?' on':'' }}" @if($k) aria-hidden="true" @endif>
<img @if($k===0) src="/login-{{ $s[0] }}.jpg" @else data-src="/login-{{ $s[0] }}.jpg" @endif alt="{{ $s[1] }}" width="1024" height="1536">
<figcaption><strong>{{ $s[2] }}</strong><span>{{ $s[3] }}</span></figcaption>
</figure>
@endforeach
<div class="ctrl">
<div class="dots">@foreach($slides as $k=>$s)<button type="button" data-go="{{ $k }}" aria-label="{{ $k+1 }}. kép" @if($k===0) aria-current="true" @endif></button>@endforeach</div>
<button type="button" class="nav" data-step="-1" aria-label="Előző kép"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg></button>
<button type="button" class="nav" data-step="1" aria-label="Következő kép"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg></button>
<button type="button" class="nav" id="play" aria-label="Szünet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7v10M14.5 7v10"/></svg></button>
</div>
</section>
<script>(()=>{const S=[...document.querySelectorAll('.slide')],D=[...document.querySelectorAll('[data-go]')],P=document.getElementById('play'),icon=P.querySelector('path');let i=0,t=null;
const load=n=>{const m=S[(n+S.length)%S.length].querySelector('img');if(m.dataset.src){m.src=m.dataset.src;delete m.dataset.src}};
const show=n=>{i=(n+S.length)%S.length;load(i);S.forEach((s,k)=>{s.classList.toggle('on',k===i);k===i?s.removeAttribute('aria-hidden'):s.setAttribute('aria-hidden','true')});D.forEach((d,k)=>k===i?d.setAttribute('aria-current','true'):d.removeAttribute('aria-current'));load(i+1)};
const run=on=>{clearInterval(t);t=on?setInterval(()=>show(i+1),6000):null;P.setAttribute('aria-label',on?'Szünet':'Lejátszás');icon.setAttribute('d',on?'M9.5 7v10M14.5 7v10':'M9 6.5v11l9-5.5z')};
D.forEach(d=>d.onclick=()=>{show(+d.dataset.go);if(t)run(true)});
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{show(i+ +b.dataset.step);if(t)run(true)});
P.onclick=()=>run(!t);load(1);run(!matchMedia('(prefers-reduced-motion: reduce)').matches)})()</script>
<main class="side"><div class="form">
<div class="brand"><img src="/iratkapu-logo.png" alt="" width="44" height="41">KapuMail</div>
<h1>Belépés</h1>
<p class="lead">Ez az iroda saját fiókja. Nem azonos az Ügyfélkapu vagy a Cégkapu azonosításával.</p>
@if($errors->any())<div class="err" role="alert">{{ $errors->first() }}</div>@endif
<form method="post" action="/login">@csrf
<label>E-mail-cím<input id="email" name="email" type="email" value="{{ old('email') }}" placeholder="te@iroda.hu" required autofocus autocomplete="username"></label>
<label>Jelszó<input id="password" name="password" type="password" required autocomplete="current-password"></label>
<button class="go">Belépés</button></form>
@if($demo)
<div class="demo"><b>Demó mód – mintafelhasználók</b><p>Kattints egy névre a kitöltéshez. Minden adat kitalált.</p>
<div class="users">
@foreach($users as $u)<button type="button" data-e="{{ $u->email }}">{{ $u->name }}<small>{{ ['admin'=>'admin','vezeto'=>'vezető – jóváhagyhat','konyvelo'=>'könyvelő'][$u->role] ?? $u->role }}</small></button>@endforeach
</div></div>
<script>document.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>{email.value=b.dataset.e;password.value=@json(\Database\Seeders\DatabaseSeeder::DEMO_PASSWORD);password.focus()})</script>
@endif
</div></main>
</div></body></html>
