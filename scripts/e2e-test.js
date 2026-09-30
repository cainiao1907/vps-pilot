process.env.VPSPILOT_SOFTWARE_RENDER = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
require(path.join(__dirname, '..', 'dist-electron', 'main', 'index.js'));

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) {
    console.log('FAIL: 无窗口');
    app.exit(1);
    return;
  }
  const run = (js) => w.webContents.executeJavaScript(js);
  let failed = 0;
  const check = (label, cond, detail) => {
    if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    else {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${label} → ${detail}`);
    }
  };

  try {
    // 1. 风险评估链路
    const safe = JSON.parse(await run(`window.vps.assess('df -h').then(r=>JSON.stringify(r.data))`));
    const danger = JSON.parse(await run(`window.vps.assess('rm -rf /etc').then(r=>JSON.stringify(r.data))`));
    const sudo = JSON.parse(await run(`window.vps.assess('sudo rm -rf /tmp/x').then(r=>JSON.stringify(r.data))`));
    const write = JSON.parse(await run(`window.vps.assess('mkdir -p /www/site').then(r=>JSON.stringify(r.data))`));

    console.log('\n[风险评估]');
    check('df -h 判定为只读安全', safe.readonly === true && safe.risk.level === 'safe', JSON.stringify(safe));
    check('rm -rf /etc 被硬拦截', danger.risk.blocked === true, JSON.stringify(danger.risk));
    check('sudo rm -rf /tmp/x 为高危', sudo.risk.level === 'high' && !sudo.risk.blocked, JSON.stringify(sudo.risk));
    check('mkdir 为写操作需确认', write.readonly === false, JSON.stringify(write));

    // 2. 主机保存（含凭据加密）
    const saved = JSON.parse(
      await run(
        `window.vps.saveHost({name:'测试机',host:'1.2.3.4',port:22,username:'root',authType:'password',password:'secret123',defaultCwd:'/www'}).then(r=>JSON.stringify({ok:r.ok,n:r.data.length,leak:JSON.stringify(r.data).includes('secret123'),enc:!!r.data[0].encryptedPassword}))`
      )
    );
    console.log('\n[主机管理]');
    check('保存主机成功', saved.ok === true && saved.n === 1, JSON.stringify(saved));
    check('明文密码未回传渲染进程', saved.leak === false, JSON.stringify(saved));
    check('密码已加密存储', saved.enc === true, JSON.stringify(saved));

    // 3. 模型保存
    const model = JSON.parse(
      await run(
        `window.vps.saveModel({label:'测试模型',providerId:'deepseek',baseUrl:'https://api.deepseek.com/v1',apiKey:'sk-testkey',model:'deepseek-chat'}).then(r=>JSON.stringify({ok:r.ok,n:r.data.length,hasKey:r.data[0].hasApiKey,leak:JSON.stringify(r.data).includes('sk-testkey')}))`
      )
    );
    console.log('\n[模型配置]');
    check('保存模型成功', model.ok === true && model.n === 1, JSON.stringify(model));
    check('API Key 不回传明文', model.leak === false, JSON.stringify(model));
    check('标记为已配置 Key', model.hasKey === true, JSON.stringify(model));

    // 4. 设置持久化
    const st = JSON.parse(await run(`window.vps.setSettings({maxOutputChars:12345}).then(r=>JSON.stringify(r.data))`));
    const st2 = JSON.parse(await run(`window.vps.getSettings().then(r=>JSON.stringify(r.data))`));
    console.log('\n[设置]');
    check('设置写入成功', st.maxOutputChars === 12345, JSON.stringify(st));
    check('设置读取一致', st2.maxOutputChars === 12345, JSON.stringify(st2));
    check('默认值保留', st2.defaultApprovalMode === 'auto_readonly', JSON.stringify(st2));

    // 5. 审计
    const audit = JSON.parse(await run(`window.vps.listAudit({limit:10}).then(r=>JSON.stringify({ok:r.ok,n:r.data.length}))`));
    console.log('\n[审计]');
    check('审计接口可用', audit.ok === true, JSON.stringify(audit));

    // 6. 应用信息
    const info = JSON.parse(
      await run(`window.vps.appInfo().then(r=>JSON.stringify({ok:r.ok,presets:r.data.presets.length,platform:r.data.platform}))`)
    );
    console.log('\n[应用信息]');
    check('应用信息正常', info.ok === true && info.presets >= 8, JSON.stringify(info));

    // 7. 删除主机
    const hostId = await run(`window.vps.listHosts().then(r=>r.data[0].id)`);
    const del = JSON.parse(
      await run(`window.vps.deleteHost(${JSON.stringify(hostId)}).then(r=>JSON.stringify({ok:r.ok,n:r.data.length}))`)
    );
    console.log('\n[删除]');
    check('删除主机成功', del.ok === true && del.n === 0, JSON.stringify(del));

    // 8. 前置校验：任务为空 / 主机不存在
    const emptyTask = JSON.parse(
      await run(`window.vps.agentRun({hostId:'nope',task:'  '}).then(r=>JSON.stringify({ok:r.ok,err:r.error}))`)
    );
    const noHost = JSON.parse(
      await run(`window.vps.agentRun({hostId:'nope',task:'看看磁盘'}).then(r=>JSON.stringify({ok:r.ok,err:r.error}))`)
    );
    console.log('\n[Agent 前置校验]');
    check('空任务被拒绝', emptyTask.ok === false && /描述/.test(emptyTask.err || ''), JSON.stringify(emptyTask));
    check('无效主机被拒绝', noHost.ok === false && /主机/.test(noHost.err || ''), JSON.stringify(noHost));

    console.log(`\n结果：${failed === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failed} 项失败\x1b[0m`}\n`);
    app.exit(failed === 0 ? 0 : 4);
  } catch (e) {
    console.log('EXEC ERROR:', e.message);
    app.exit(3);
  }
}, 4500);
