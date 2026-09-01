# AGENTS.md —— second-brain 个人知识系统

> 本文件是本工作区(E:\second-brain)的跨对话项目记忆。
> 前身项目:AI 狼人杀(E:\agentTest)——两项目现已完全分家,各占一处,互不依赖;方法论文档见狼人杀那边。

## 项目是什么

**个人知识系统,两条"入库腿"共用一个知识库**:
- **B 腿(先做)**:导入自有资料(MD/TXT/docx/网页 URL)→ 打标/摘要/关系 → 归纳问答(引用到段落)
- **A 腿(Deep Research,W3)**:联网研究 → 带引用报告 → 报告+来源快照一键沉淀进库
- 成品形态:**Electron 桌面客户端**(W1-W4 先做本机 Web,最后套壳,业务零返工);**绝不部署公网**,服务只绑 127.0.0.1

## 用户拍板的产品原则(改动前先确认)

1. **原文不可变**:任何"更新"只发生在派生层;URL 源入库即存内容寻址快照
2. **标签 1~5 个,不许硬凑**:受控词表(approved/pending),新标签必须经用户审批;泛词黑名单在 tagger.ts
3. **冲突裁决权在用户**:关系层只记录 similar/conflict/supplement,系统不自动"修正"旧知识
4. **待办不阻塞问答**:未裁决冲突按默认策略(时间新者优先)照常参与回答,界面标注"未裁决"
5. **区域=配置对象**(learning/work/…):词表、chunk 策略、抓取白名单、local_only 开关都挂在区域上
6. 知识星球抓取**暂不做**(用户后续再想方案);docx/PDF/URL 均在范围内
7. **入库询问只属于深度研究**:问答完成后不问"要不要入库"——回答本身源于库内检索,不该反哺询问;研究产出是外部新知识,才问沉淀(W5 后用户明确,推翻了早期"问答/研究都问"的口径)

## 数据模型(四层)

原文层 documents+chunks(快照 + sha256 指纹去重)→ 元数据层 tags/document_tags/summaries/relations → 流程层 inbox(待办收件箱)→ regions(配置)。FTS5 trigram 全文索引挂在 chunks 上。

## 常用命令

```bash
npm run cli -- import <文件|目录|URL> [--region work] [--no-tag] [--no-relations]
npm run cli -- search <词...>      # 找文档(零 token):≥3字走 FTS,2字词/gam 走 LIKE 兜底
npm run cli -- ask "<问题>"        # 归纳问答(编号引用);--save 直接入库,否则交互问 y/i/n
npm run cli -- research "<问题>"   # 深度研究:联网→带引用报告;--save 报告+来源入库,--no-sources 仅报告
npm run cli -- eval [评估集路径]   # 评估集跑分(引用命中/要点覆盖/可用率)
npm run cli -- doc <id>            # 标签/摘要/关系详情
npm run cli -- stats | inbox | taxo list|add|approve <region> [...] | reset --yes
npm run web                        # 本机 Web(127.0.0.1:8790)
npm run mcp                        # MCP stdio 服务(开发态;打包产物 build/mcp.mjs)
node scripts/test-mcp.mjs quick    # MCP 协议冒烟(full = 追加真实问答+研究,花 token)
npm run desktop                    # Electron 开发态(会复用 8790 已有服务)
npm run dist                       # 打包 exe:esbuild 捆 server(+createRequire banner,.env 随包)→ release/win-unpacked/second-brain.exe
npm run typecheck
```

- 库与快照在 `data/`(已 gitignore);.env 复用狼人杀的 LLM_*(DeepSeek),PORT=8790
- 用 `node:sqlite`(Node 24 内置,Windows 零编译);**打包版 Electron 必须 ≥39(自带 Node ≥24)**,否则没有 node:sqlite —— 当前 electron@44(Node 24.18)
- 桌面快捷方式 `second-brain.lnk` → release/win-unpacked/second-brain.exe,双击即用,零命令行

## 当前状态(2026-09-01,W7.1 回答反思自检完成)

- ✅ **W7.1 回答反思自检**:回答生成后一次便宜的 callJson,把每个 [n] 论断对照所引 chunk **原文**(不是 500 字摘录 —— 摘录截断外的合法支撑会误报,实测首日就抓到)逐条校验"张冠李戴/无中生有",只报问题不报通过;发现不自洽把问题清单带回去**重答一次**,修订稿须保住 ≥1 个合法引用才采纳(全删引用的"修订"不如保留原稿亮出问题);校验链路故障则原答案照常(降级不阻塞);
-   三张皮同步透出:CLI 打印自检行;Web 回答卡下标注"已修正重答"(通过时零噪音);MCP ask_knowledge 注明是第二稿;流式路径重试=重流(前端 delta 本就整段替换,自然覆盖),SSE done 事件带 reflection 字段;QA_REFLECT=off 可关(评估同受控);
-   验证:单测 scripts/test-reflect.ts 双路(误引必须抓到/正确引用零误报)+ CLI 与 8791 端口流式 SSE 实测 —— 真实问答首稿 8 条引用被抓出 5 处误标,重试稿删掉无据论断、收紧引用;
-   **自检器精度坑(打包版首日实测抓到)**:校验提示词若只列"矛盾/对不上/没有该内容"三种判定,模型会过度严格,把同义改写(片段"质量会直线下降" vs 论断"质量下降")也报成不自洽 —— 误报清单污染重试提示,修订稿把引用删光而被拒收。修法:提示词明确"同义改写一律放行 + 拿不准不报",同题复测 5 引用零误报;
-   ✅ **问答/深研输入框 Enter 直发(用户反馈的反直觉点)**:原先只绑 Ctrl+Enter,改成聊天软件惯例 `@keydown.enter.exact.prevent`(Enter 发送、Shift+Enter 换行、Ctrl+Enter 备用发送),placeholder 同步;两处 textarea(问答/深研)都改,与页面单行输入框的 enter 直发保持一致。浏览器实机验证全链路通过(IAB 自动化的 locator.press/cua.keypress 派发键会落在 body 上 —— 测试前必须先 click 聚焦目标元素,否则探针收不到 keydown,这是自动化环境坑不是产品 bug);
- ✅ **W7 MCP Server(stdio,4 工具)**:`@modelcontextprotocol/sdk 1.30 + zod 4`,src/mcp/server.ts 复用 retriever/answer/research/topics 模块零重写("同一套业务的第三张皮")——`search_knowledge`(混合检索,零 token)/ `ask_knowledge`(带 [n] 引用问答,支持 history 多轮)/ `run_research`(长任务,阶段进度走 notifications/progress,只返回不自动入库——沉淀裁决权在用户)/ `list_topics`(列表 + topicId 取全文);实测 11 项全过(scripts/test-mcp.mjs quick/full,full 含真实 LLM 问答与研究 26s 出报告 + 20 条进度通知);
-   **stdio 纪律**:stdout 是 JSON-RPC 协议通道,入口第一件事把 console.log/warn 重定向 stderr(拦 transformers.js 等第三方杂音),否则客户端解析失败断连;
-   **与桌面端并行安全**:WAL 多进程读写;向量缓存是进程内存,别处新入库重启 MCP 会话可见;启动照常 requestBackfill(已齐时只查一次库,不加载嵌入模型);
-   **接入坑**:数据目录必须 SB_DATA_DIR 显式指定(默认会落到项目内空库,启动 stderr 会打印实际数据目录与文档数);打包 build/mcp.mjs 已随 build/** 分发,esbuild 双入口(server/mcp)同脚本生成;
- ✅ W1-W4:导入管线/检索器/归纳问答/Deep Research/整理台(详见周报)
- ✅ W5:评估集跑分(引用命中 100%/要点覆盖 92%/可用 100%/平均 2.3s,评估首日抓出 LIKE 层行序偏置真 bug)+ 周报 docs/周报.md + 截图 docs/screenshots/
- ✅ 打包:`npm run dist` → **双击版 exe**(release/win-unpacked,asar 关闭——data/ 快照要可写);服务 esbuild 捆单文件在主进程内直跑;.env 由 dist 脚本暂存进 build/ 随包;桌面快捷方式已建
- ✅ **全 GUI 化(客户端零命令行)**:文档库页新增导入卡片 —— 拖拽文件/文件夹(Electron preload 暴露 webUtils.getPathForFile 拿绝对路径;纯浏览器自动降级为内容上传)+ 点击选择文件/文件夹 + URL 粘贴行;导入做成后台任务(与深研同款 job 轮询,逐篇进度/结果行:成功带标签、重复跳过、失败原因);整理台词表卡可手动加词;危险操作卡(输入"重置"解锁 + confirm 双保险,/api/reset 与 CLI 共用 resetAll)
- ✅ **W6(文档驱动的编译层迭代)**:按库内文档 06/08/09 的思想补齐后两层存储 ——
-   **编译层**:同标签文档 ≥2 篇 → 整理台"建议编译" → LLM 综合摘要成主题结论页(冲突并列、引用回来源),同 slug 重编译=更新(派生数据可重算);新资料入库命中已编译标签 → 主题页标"有新资料";
-   **索引层**:文档库加"文档/主题"双视图;问答材料注入编译结论("先看索引再读知识页");
-   **选题层改造为行动层**:原"选题"形态对开发者无用已裁掉,精髓(结论→动作)融入回顾卡(本周新增+待重编译+下一步建议,手动触发);
-   **规则层**:settings 表存个人画像,注入问答/摘要/编译 prompt;摘要新增 value_note("对我的价值"有立场字段,老库 ALTER 迁移);
-   **能存补全**:文档删除(级联+快照文件)、原文快照查看(exe 放行同源 window.open)、随手记(想法直进库,标题取首行);
-   场景模板:问答页"选型对比/方案评估"chip(源自文档 09 的选型模板);
-   实测:随手记/建议/编译/主题视图/回顾/规则/快照/删除全链路通过;曾误从空壳目录起 npm 向上解析到狼人杀项目 package.json(教训:会话工作目录可能停在空壳,任何 npm 命令必须显式 cd 项目根);
- - ✅ **W6.3 向量混合召回(求职方向的核心增量)**:@huggingface/transformers v4 + onnxruntime-node,本地 bge-small-zh-v1.5(512 维,模型缓存 data/models,hf-mirror 下载);EmbeddingProvider auto/local/api/off 四态(auto=本地失败退 API,API 走硅基流动 bge-m3 等兼容接口);embeddings 表存 BLOB,启动/导入后自动回填(批量 16);混合召回 = FTS 词面 + 向量语义两路 RRF(K=60)融合,引用出处带 via 标注(词面/语义/词面+语义);
-   **评估对比(同一评估集 16 例,含 4 例语义用例)**:纯词面 → 引用命中 63%/要点 69%;混合 → 引用命中 75%/要点 75%;剩余未命中为评估期望漂移(用户新导入的重叠主题文档),评估集需随库内容定期重校准;
-   **打包坑**:transformers v4 是 ESM,require 报 ERR_AMBIGUOUS_MODULE_SYNTAX → 动态 import;Tensor 是 Proxy,.map 回调里 .data 为 undefined → 按 dims 切平铺;esbuild external:@huggingface/transformers + builder files 显式收 node_modules/@huggingface、onnxruntime-node/common、sharp、@img;esbuild 长参数在 npm script 里 cmd 转义不稳 → 改 scripts/build-server.mjs 用 JS API;
- ✅ **W6.5 求职门面**:README.md(编译型定位/四层架构图/混合召回/评估对比表/成本模型/踩坑实录/刻意不做边界;截图 6 张全部相对路径校验存在);项目尚未 git init,推 GitHub 前需初始化(注意 .env 与 data/ 已在 .gitignore);
- ✅ **W6.4 评估集自动校准(拍板制)**:runEvalCore 从 CLI 拆出(服务端复用);docMustInclude 数组化(任一命中即算);跑评估后对每条未命中,AI 对照实际引用判定"期望过时(stale,附应加入的文档)/真失败(real-miss)/不确定",建议持久化 eval/pending-calibration.json,整理台卡片拍板(按建议更新=追加期望 / 忽略);eval/ 目录随包分发(exe 内评估可用);
- ✅ **W6.2 数据目录可自定义 + 已迁至 E:\second-brain-data**:main.cjs 启动时读指针文件(%APPDATA%/second-brain-data-dir.txt(与文件夹平级 —— 指针曾放文件夹内,用户删文件夹时连指针一起删导致"数据又丢了"假象,已修))决定 SB_DATA_DIR,无指针用默认用户目录;整理台新增"数据存储"卡(占用统计 db/快照/备份 + 迁移按钮:系统目录选择框 → VACUUM INTO 一致性副本 + 逐文件拷快照 → 写指针 → app.relaunch 自动重启);迁移后重打包/升级永不影响数据,且 C 盘占用封顶;
- ✅ **W6.1 数据安全修复(用户文档丢失事故)**:打包版 data 原先住在应用目录内,electron-builder 重打包整个重建 win-unpacked → 用户已导入的文档随重打包被清空。修复三件套:
-   **数据出应用目录**:打包版注入 SB_DATA_DIR=%APPDATA%/Roaming/second-brain/data,config 的 DATA_DIR 优先读它 —— 重打包/升级永远不再触碰用户数据;
-   **启动滚动备份**:server 启动时 VACUUM INTO 一致性快照到 data/backups/(WAL 下直接拷 db 文件会漏数据),保留最近 7 份,兜"不会塌"的底;
-   **教训入册**:①数据与代码必须物理分离,"打包进包里"的一切都会在下次打包时蒸发;②对用户数据的任何破坏性操作(含"间接的"重打包)必须先确认或备份;③本会话 npm 命令必须显式 cd E:\second-brain(空壳目录会向上解析到狼人杀 package.json);
- ✅ 录屏交付:docs/second-brain-全流程演示.mp4(11 分 42 秒,另有桌面副本)—— 用 ffmpeg gdigrab 区域捕获 + PowerShell 系统级点击驱动真实窗口录制;录制过程实测抓出**打包版首跑真 bug:服务启动不调 ensureRegions,全新数据目录没有区域种子,导入全被"区域不存在"挡住**(开发态从未暴露,库总是 CLI 先建好的)→ 服务启动补 ensureRegions() 已修
- 导入任务端点:POST /api/import{mode:paths|url} + POST /api/import/upload(原始字节体,**必须在 JSON 解析之前接走**)+ GET /api/import/:id;上传临时文件由 OS 清理,不产生库内痕迹
- 打包踩坑:esbuild ESM 输出里 CJS 依赖(mammoth)require 炸 → createRequire banner;import 路径相对 main.cjs 所在 electron/ 目录;electron-builder files 通配不收 .env → 显式暂存;win-unpacked 被残留进程 cwd 锁住 EBUSY → 换输出目录 release/;**Electron 必须 ≥39(自带 Node ≥24)否则没有 node:sqlite** → 用 electron@44
- **exe 是独立自包含一份**(数据在 resources/app/data,与开发态 data/ 分离);拖拽真实路径链路(webUtils)依赖桌面端人工试一把,浏览器态上传链路已实测
- 测试数据已清库,正式数据由用户在客户端导入

## 下一步(可选方向)

- LangGraph 暂缓(second-brain 保持零框架);electron-builder 打 NSIS 安装包(现是免安装目录版);评估集重跑看反思自检对引用命中率的增益(W7.1 改动后未重跑,当前指标是混合召回版的)

## 沟通偏好

- 全程中文;解释带教学性(用户在学 agent 开发);改动先 typecheck,UI 改动要实机验证
