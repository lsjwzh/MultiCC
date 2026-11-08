// Existing login markup, kept byte-identical during the host migration.
pub const PARTS: [&str; 3] = [
    r###"<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MultiCC — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;
    padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
  .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
    width:min(340px,100%);text-align:center}
  .box h1{font-size:20px;margin-bottom:8px;color:#f0f6fc}
  .box .logo{font-size:24px;font-weight:700;color:#f78166;margin-bottom:24px}
  .box .logo span{color:#79c0ff}
  input[type=password]{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:#c9d1d9;font-size:16px;min-height:48px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#58a6ff}
  button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;
    color:#fff;font-size:16px;font-weight:600;min-height:48px;cursor:pointer}
  button:hover{background:#2ea043}
  @media(max-width:380px){.box{padding:24px 20px}.box .logo{font-size:22px;margin-bottom:20px}}
</style></head><body>
<div class="box">
  <div class="logo">Multi<span>CC</span></div>
  "###,
    r###"
  <form method="POST" action="/login">
    <input type="hidden" name="redirect" value=""###,
    r###"">
    <input type="password" name="password" placeholder="输入访问密码" autofocus>
    <button type="submit">登录</button>
  </form>
</div></body></html>"###,
];
