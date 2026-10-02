/* ------------------------------------------------------------------
   静态只读版的适配层（由 _tools/build_github_pages.py 生成，别手改）

   这个网站原本靠本机 Python 程序提供 /api/* 接口。放到 GitHub Pages 上
   没有程序可跑，所以这里把 /api/* 的请求改接到**构建时抓下来的快照**。

   三条纪律：
     1. 只改 /api/* 的请求，其它请求一律原样放行（教材图、三维模型照常加载）
     2. 写操作**明确拒绝**并说明原因——不能让用户以为存上了其实没存
     3. 快照是死的，所以只读版永远看不到「你自己录的资料」
------------------------------------------------------------------ */
(function () {
  var MAP = {
    '/api/parts': 'api/parts.json',
    '/api/refs': 'api/refs.json',
    '/api/info': 'api/info.json'
  };

  function jsonResp(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  var orig = window.fetch ? window.fetch.bind(window) : null;
  if (!orig) return;

  window.fetch = function (input, opts) {
    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
    var method = (((opts && opts.method) || 'GET') + '').toUpperCase();
    var path = url.split('?')[0];
    // 去掉可能的仓库子路径前缀，取出 /api/... 那一段
    var i = path.indexOf('/api/');
    if (i >= 0) path = path.slice(i);
    if (path.indexOf('/api/') !== 0) return orig(input, opts);

    // 写操作：明确拒绝。绝不能默默失败，否则用户以为资料存上了。
    if (method !== 'GET' && method !== 'HEAD') {
      return Promise.resolve(jsonResp({
        ok: false,
        error: '这是只读的在线版，不能新增或修改资料。'
             + '要录入资料、记维修，请用电脑版或手机版 App。'
      }, 403));
    }
    if (path === '/api/docs') {
      return Promise.resolve(jsonResp({ ok: true, serverTime: Date.now(), docs: [] }));
    }
    if (MAP[path]) return orig(MAP[path], opts);
    return Promise.resolve(jsonResp({
      ok: false, error: '只读的在线版没有这个功能（' + path + '）'
    }, 404));
  };
})();

/* 页面上加一条常驻说明。不加的话用户会以为「功能坏了」，
   其实是静态版本来就没有这些功能。 */
(function () {
  function banner() {
    if (document.getElementById('roBanner')) return;
    var d = document.createElement('div');
    d.id = 'roBanner';
    d.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
      'background:#1d4d33', 'color:#eaf5ee', 'font-size:12px',
      'padding:6px 12px', 'text-align:center', 'line-height:1.5',
      'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif'
    ].join(';');
    d.innerHTML = '<b>只读在线版</b>：可以查部件、出厂参考、两本教材、三维模型；'
      + '但不能录资料、记维修、同步。那些要用电脑版或手机版 App。'
      + '<span id="roBannerX" style="margin-left:10px;cursor:pointer;'
      + 'text-decoration:underline">知道了</span>';
    document.body.appendChild(d);
    document.getElementById('roBannerX').onclick = function () { d.remove(); };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', banner);
  } else { banner(); }
})();
