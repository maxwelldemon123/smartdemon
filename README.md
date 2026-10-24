# SmartDemon 配音台

SillyTavern 前端扩展：给聊天消息配音，**可以点任意一句单独播放**。
合成由 Demon 引擎完成（默认 `http://127.0.0.1:8790`），声线档案、角色绑定、权重切换全部在 Demon 里管理。

## 功能

- 每条 AI 消息两个按钮：
  - 🔊 整条朗读（Shift+点 = 换声线，Alt+点 / 右键 = 标注）
  - ☰ 句子列表：点第 N 句只播第 N 句
- 自动朗读（可选，默认关）
- 声线列表从 Demon 自动同步
- 角色没绑定声线时，回退 Demon 默认声线
- 播放缓存 / 打断 / 进度显示

## 安装

把整个目录放到：

```
<SillyTavern>/public/scripts/extensions/third-party/smartdemon/
```

刷新酒馆页面（Ctrl+F5）。

## 前置条件

1. Demon 已启动，`http://127.0.0.1:8790/healthz` 返回 ok
2. Demon 的「语音」页至少有 1 条声线档案
3. GPT-SoVITS 的 api_v2 已启动（可在 Demon 「启动」页一键拉起）

## 设置

面板里可改：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| Demon 地址 | `http://127.0.0.1:8790` | 引擎监听地址 |
| 自动朗读 | 关 | 新消息到达后整条朗读 |
| 去掉动作描写 | 开 | 不朗读 `*微笑*` 这类 |
| 只读引号内 | 关 | 只朗读对话部分 |
| 单条最大字数 | 200 | 超出截断 |

## 开发

- `lib/tts-text.js` 是纯函数（分句、语种判定、缓存键），可以单独在 Node 里测
- 主逻辑在 `index.js`，通过 `SillyTavern.getContext()` 取上下文

## 与旧插件的关系

从 `st-gptsovits5-voice` 改造而来：后端由直连 GPT-SoVITS(9880) 改为调用 Demon(8790)，并新增逐句播放菜单。

## 许可

见 LICENSE。
