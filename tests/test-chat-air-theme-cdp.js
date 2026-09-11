'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('Air themes restored/live messages, expanded tools, diagnostics and artifacts', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public'), routes = {};
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(css|js)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: {
      'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css',
    } };
  }
  // Keep the real Chat DOM and every local stylesheet; isolate the renderer
  // from live sessions and network boot. Markup is a saved highlighter output.
  const scripts = ['error-envelope', 'status-presentation', 'chat-token-readout', 'chat-usage-readout',
    'chat-live-ui', 'chat-history-view', 'chat-user-input-card', 'task-artifacts', 'chat-air-toolbar'];
  const html = fs.readFileSync(path.join(publicDir, 'chat.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*https:\/\/cdn[^>]*>/g, '')
    .replace('<body', '<body class="air-chat"')
    .replace('</body>', `<script>window.t=k=>({'taskArtifactsTitle':'任务产物','taskArtifactsSearch':'搜索产物','taskArtifactsManage':'管理产物','taskArtifactsRefresh':'刷新','taskArtifactsCollapse':'收起','taskArtifactsNoTask':'当前任务','taskArtifactsPage':'网页','taskArtifactsCopy':'复制链接'}[k]||k)</script>${scripts.map(s => `<script src="/${s}.js"></script>`).join('')}</body>`);
  routes['/'] = { body: html };
  routes['/api/task-shell-tasks/theme/artifacts'] = { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'theme', title: 'Air 聊天配色验收', items: [
    { title: '聊天界面设计预览', url: '/artifacts/theme/index.html', kind: 'page', available: true },
  ] }) };
  const screenshotDir = path.join(os.tmpdir(), 'multicc-air-theme-qa');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1100, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor('window.MultiCCChatHistoryView && window.MultiCCTaskArtifacts'));
    await page.evaluate(String.raw`(() => {
      window.__errors=[];addEventListener('error',e=>__errors.push(e.message));
      const messages=document.getElementById('messages');messages.replaceChildren();MultiCCChatLiveUi.bindHeaderMoreMenu({document,window,button:document.getElementById('header-more-btn'),menu:document.getElementById('header-more-menu'),wrap:document.getElementById('header-more-wrap'),ids:[...document.querySelectorAll('#header > .hdr-btn, #header > .hdr-menu-wrap')].map(el=>el.id).filter(id=>id!=='header-more-wrap')});
      // These are representative classes emitted by highlight.js, including
      // nested meta/string and function titles with competing upstream rules.
      const markdown='<h2>Air · 清晰、轻盈的对话</h2><p>工具、代码与状态提示采用统一浅色。<strong>重要信息</strong>清楚可见，<a href="#">相关文档</a>可直接打开。</p><blockquote>展开后的内容也保持一致的阅读体验。</blockquote><pre><code class="hljs language-js"><span class="hljs-comment">// 恢复历史消息与实时输出使用同一配色</span>\n<span class="hljs-keyword">const</span> theme = <span class="hljs-string">"Air"</span>;\n<span class="hljs-title function_">render</span>({ <span class="hljs-attr">width</span>: <span class="hljs-number">1200</span>, <span class="hljs-literal">true</span> });\n<span class="hljs-meta">#include <span class="hljs-string">&lt;air.h&gt;</span></span></code></pre><table><tr><th>内容</th><th>状态</th></tr><tr><td>历史记录 / 实时消息</td><td>已统一配色</td></tr></table>';
      const separator=document.createElement('div');separator.className='run-separator';separator.textContent='本轮执行 · Air 配色验收';messages.append(separator);
      window.live=MultiCCChatLiveUi.createLiveUi({document,window,messagesEl:messages});
      const history=MultiCCChatHistoryView.createHistoryView({document,messagesEl:messages,safeMarkdown:{render:()=>markdown},buildUsageLine:live.buildUsageLine,buildTimingLine:live.buildTimingLine});
      messages.append(history.renderMessage({id:'user',role:'user',content:'把聊天记录中的旧黑底展示统一为 Air 风格。',bgToolUseIds:['bg-1']}));
      messages.append(history.renderMessage({id:'assistant',role:'assistant',content:'fixture',cancelled:true,ts:Date.now(),durationMs:3800,
        usage:{input_tokens:1200,output_tokens:450,cache_read_input_tokens:600},tools:[
        {id:'read',name:'Read',input:{file_path:'public/chat-air.css'},result:'读取完成 · Air 配色已加载',startedAt:1000,endedAt:1100},
        {id:'check',name:'Bash',input:{command:'npm run check'},result:'检查失败 · 保留可读的错误提示',is_error:true,startedAt:1100,endedAt:1350}]}));
      for(const h of document.querySelectorAll('.tool-header'))h.click();
      live.showThinking('正在检查展开后的显示效果…');
      live.showDisconnectBanner(3,{code:'NETWORK_UNAVAILABLE',message:'连接暂时中断，正在重试',detail:'Connection refused at localhost',source:'transport'});
      const details=document.querySelector('.mc-error-details');if(details)details.open=true;
      const usage=document.getElementById('cost-bar');window.usageView=MultiCCChatUsageReadout.createUsageReadout({bar:usage,panel:document.getElementById('usage-detail-pop'),document});usageView.render({contextWindow:100000,requestUsage:{input_tokens:65000},turnUsage:{input_tokens:1200,output_tokens:450},contextTrace:{traceId:'trace',currentTask:{taskId:'theme',taskName:'Air 配色'},sources:[{taskId:'source',taskName:'历史设计参考',mode:'refilled',messageCount:1,messages:[{role:'user',content:'统一采用浅色背景，保持文字清晰。'}]}]}});
      window.question=MultiCCChatUserInputCard.createController({document});
      question.render({requestId:'q1',question:'需要保留哪些展示？',reason:'展开内容与状态文字也使用 Air 配色。',options:['全部保留','仅保留摘要']});
      MultiCCTaskArtifacts.setScope({taskId:'theme'});
      messages.scrollTop=0;
    })()`);
    assert.ok(await page.waitFor('document.querySelector(".task-artifacts-link")'));
    const inspect = selectors => page.evaluate(`(() => {
      const rgb=s=>{const a=s.match(/[\\d.]+/g)?.map(Number)||[0,0,0,0];return [a[0],a[1],a[2],a[3]??1]};
      const blend=(a,b)=>a.slice(0,3).map((c,i)=>c*a[3]+b[i]*(1-a[3]));
      const lum=a=>a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      function bg(el){if(!el)return [255,255,255];return blend(rgb(getComputedStyle(el).backgroundColor),bg(el.parentElement));}
      return ${JSON.stringify(selectors)}.flatMap(selector=>{const elements=[...document.querySelectorAll(selector)];if(!elements.length)return [{selector,missing:true}];return elements.map(el=>{
        const style=getComputedStyle(el),background=bg(el),fg=blend(rgb(style.color),background),a=lum(fg),b=lum(background);
        return {selector,color:style.color,background:background.map(Math.round),lightness:b,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      })});
    })()`);
    await page.evaluate('document.getElementById("cost-bar").click();document.querySelector(".usage-context-details").open=true');
    const selectors=['.run-separator','.msg.user','.msg.user > div','.msg.assistant h2','.msg.assistant a','.msg.assistant blockquote','.msg.assistant th','.msg.assistant td',
      '.hljs','.hljs-comment','.hljs-keyword','.hljs-string','.hljs-title','.hljs-number','.hljs-meta','.hljs-attr','.hljs-literal',
      '.tool-header','.tool-name','.tool-desc','.tool-body pre','.tool-result-label','.tool-result-label.error',
      '.msg-usage .u-in','.msg-usage .u-out','.msg-usage .u-cache','.msg-timing','.msg.assistant .system-msg',
      '.thinking-bubble','.disconnect-banner','.mc-error-details pre','.mc-error-copy',
      '#pending-user-input-question','#pending-user-input-reason','.pending-input-option','#pending-user-input-text','.usage-ctx-text',
      '#task-artifacts-panel','.task-artifacts-link','.task-artifacts-task',
      '.usage-detail-pop','.usage-detail-title','.usage-detail-label','.usage-detail-value','.usage-context-source strong','.usage-context-details summary','.usage-context-message'];
    const checks=await inspect(selectors);
    assert.ok(await page.evaluate('document.querySelector(".run-separator").getBoundingClientRect().height>=20'), 'Run label remains visible in a long transcript');
    for(const x of checks){assert.ok(!x.missing,`Missing ${x.selector}`);assert.ok(x.lightness>.75,`Dark surface: ${JSON.stringify(x)}`);assert.ok(x.contrast>=4.5,`Low contrast: ${JSON.stringify(x)}`);}
    assert.equal(await page.evaluate('document.querySelector("#task-artifacts-panel").checkVisibility()'),false);
    await page.evaluate('usageView.close();question.clear();document.getElementById("task-artifacts-toggle").click();document.getElementById("messages").scrollTop=0');
    assert.equal(await page.evaluate('getComputedStyle(document.getElementById("task-artifacts-panel")).colorScheme'),'light');
    t.diagnostic(await page.screenshot('air-expanded-desktop'));
    await page.evaluate('document.getElementById("task-artifacts-close").click();void live.confirm("当前修改会保留，下一轮继续处理。",{title:"操作提示"});');
    for(const x of await inspect(['.chat-dialog-backdrop > div']))assert.ok(x.lightness>.75 && x.contrast>=4.5,JSON.stringify(x));
    await page.evaluate('document.querySelector(".chat-dialog-backdrop .btn").click();');
    for(const width of [390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});
      await page.evaluate('document.getElementById("messages").scrollTop=0');
      assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'No mobile page overflow');
      assert.ok(await page.evaluate('[...document.querySelectorAll(".tool-card")].every(e=>e.getBoundingClientRect().right<=innerWidth)'),'Tools fit mobile');
      t.diagnostic(await page.screenshot('air-expanded-mobile-'+width));
    }
    await page.evaluate(String.raw`(() => {
      const diff=document.createElement('div');document.getElementById('messages').append(diff);
      live.renderDiff(diff,'diff --git a/file b/file\n@@ -1 +1 @@\n-old line\n+new line\n<<<<<<< branch\nlocal change\n=======\nbase change\n>>>>>>> main');
      live.renderApiError({state:'retry_wait',provider:'demo',httpStatus:429,category:'quota',message:'稍后自动重试'});
    })()`);
    for(const x of await inspect(['.diff-add','.diff-del','.diff-hunk','.diff-conflict','#api-error-bar']))assert.ok(x.lightness>.75 && x.contrast>=4.5,JSON.stringify(x));
    // Theme removal verifies fallback colors still work on legacy Chat.
    await page.evaluate('document.body.classList.remove("air-chat")');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".tool-body")).backgroundColor'),'rgb(13, 17, 23)');
    assert.deepEqual(await page.evaluate('__errors'),[]);
  });
});
