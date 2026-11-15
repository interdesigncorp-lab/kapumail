<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>KapuMail csatlakoztatása</title>
<style>
:root{--ink:#1a1733;--soft:#4a4666;--line:rgba(40,30,90,.14);--accent:#4a36e0;--red:#b42318}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Figtree,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:linear-gradient(135deg,#f6dbe9,#e6dbf7 40%,#dcd8fa 65%,#f7e4dc);padding:16px}
.card{width:100%;max-width:480px;background:rgba(255,255,255,.92);border:1px solid #fff;border-radius:28px;padding:36px clamp(20px,5vw,40px);box-shadow:0 30px 80px -30px rgba(60,35,120,.4)}
h1{font-size:26px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px}
p,li{color:var(--soft);font-size:15px;line-height:1.55}
ol{padding-left:20px}
input{font:inherit;font-size:24px;letter-spacing:.2em;text-align:center;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:#fff;color:var(--ink);width:100%}
button{font:inherit;cursor:pointer;width:100%;margin-top:14px;padding:14px;border:0;border-radius:999px;background:#15131c;color:#fff;font-weight:600;font-size:16px}
button:hover{background:var(--accent)}
:focus-visible{outline:2.5px solid var(--accent);outline-offset:2px}
.err{color:var(--red);font-weight:600}
</style></head>
<body><main class="card">
@if(!empty($done))
  <h1>Kész</h1>
  <p>A KapuMail csatlakozott. Visszatérhetsz a ChatGPT-hez vagy a Claude-hoz.</p>
@else
  <h1>KapuMail csatlakoztatása</h1>
  <p>Egy AI-asszisztens (ChatGPT vagy Claude) szeretne csatlakozni a gépeden futó KapuMailhez.</p>
  <ol>
    <li>Nyisd meg a KapuMailt: Beállítások → AI-kapcsolat (MCP).</li>
    <li>A „ChatGPT / claude.ai a közvetítőn át” kártyán kérj <b>csatlakozási kódot</b>, és válaszd ki, hogy csak olvashat vagy dolgozhat is.</li>
    <li>Írd be ide a 8 jegyű kódot. 10 percig érvényes, egyszer használható.</li>
  </ol>
  <form method="post" action="{{ url('/mcp-connect') }}">
    @csrf
    <label for="code" style="font-weight:600;font-size:14px">Csatlakozási kód</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required autofocus placeholder="1234 5678">
    @if($error)<p class="err" role="alert">{{ $error }}</p>@endif
    <button type="submit">Tovább</button>
  </form>
@endif
</main></body></html>
