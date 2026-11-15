<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI-kapcsolat engedélyezése – KapuMail</title>
<style>
:root{--ink:#1a1733;--soft:#4a4666;--line:rgba(40,30,90,.14);--accent:#4a36e0}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Figtree,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:linear-gradient(135deg,#f6dbe9,#e6dbf7 40%,#dcd8fa 65%,#f7e4dc);padding:16px}
.card{width:100%;max-width:520px;background:rgba(255,255,255,.92);border:1px solid #fff;border-radius:28px;padding:36px clamp(20px,5vw,40px);box-shadow:0 30px 80px -30px rgba(60,35,120,.4)}
h1{font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px}
p,li{color:var(--soft);font-size:15px;line-height:1.55}
ul{padding-left:20px;margin:8px 0 20px}
.who{font-weight:600;color:var(--ink)}
.row{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
button{font:inherit;cursor:pointer;flex:1;min-width:140px;padding:14px;border-radius:999px;font-weight:600;font-size:15px}
.ok{border:0;background:#15131c;color:#fff}.ok:hover{background:var(--accent)}
.no{border:1px solid var(--line);background:#fff;color:var(--ink)}
:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px}
form{flex:1;display:flex}
</style></head>
<body><main class="card">
<h1>Csatlakozhat-e „{{ $client->name }}” a KapuMailhez?</h1>
<p>Bejelentkezve: <span class="who">{{ $user->name }}</span>. Ha engedélyezed, az AI-asszisztens a te nevedben, a te jogosultságoddal éri el az iroda adatait:</p>
<ul>
  <li>az ügyfeleket, iratokat és azok szövegét, a határidőket és a naplót – csak amit te is látsz;</li>
  <li>kezdetben <b>csak olvasási</b> szinten. Munka vagy admin szintet egy admin adhat a Beállítások → AI-kapcsolat lapon;</li>
  <li>állami oldal felé (átvétel, letöltés, NAV) semmit nem indíthat.</li>
</ul>
<p>Minden hívás bekerül a naplóba. A kapcsolatot bármikor visszavonhatod a Beállításokban.</p>
<div class="row">
  <form method="post" action="{{ route('passport.authorizations.approve') }}">
    @csrf
    <input type="hidden" name="state" value="{{ $request->state }}">
    <input type="hidden" name="client_id" value="{{ $client->getKey() }}">
    <input type="hidden" name="auth_token" value="{{ $authToken }}">
    <button class="ok" type="submit">Engedélyezem</button>
  </form>
  <form method="post" action="{{ route('passport.authorizations.deny') }}">
    @csrf
    @method('DELETE')
    <input type="hidden" name="state" value="{{ $request->state }}">
    <input type="hidden" name="client_id" value="{{ $client->getKey() }}">
    <input type="hidden" name="auth_token" value="{{ $authToken }}">
    <button class="no" type="submit">Mégse</button>
  </form>
</div>
</main></body></html>
