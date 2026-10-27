# SmartDemon 配音台 2.1.0

SillyTavern 语音扩展：把角色的台词交给 **Demon** 引擎合成语音，并把朗读进度回传给 Demon 做 Live2D 口型同步。

## 安装（二选一）

### 方式 A：git clone（推荐，可直接更新）

```bat
cd <你的 SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/<你的账号>/smartdemon-plugin.git smartdemon
```

### 方式 B：下载 ZIP

1. 在本仓库页点 `Code → Download ZIP`
2. 解压后把 `index.js / manifest.json / style.css` 放到：
   `SillyTavern/public/scripts/extensions/third-party/smartdemon/`

装好后刷新酒馆（F5），在「扩展」里启用 **SmartDemon 配音台**。

## 依赖

- Demon 引擎（另一仓库）：默认监听 `http://127.0.0.1:8790`
- SillyTavern：已验证 `release` 分支（commit `8172dcd0e` 附近版本）

## 本版本改动（2.1.0）

- 请求体新增 `original` 字段：把**未清洗的原文**（含 `（动作描写）` 括号）发给 Demon，用于情绪/动作判定
- 新增播放事件上报：`POST /voice/playback`（`start` / `tick` / `stop`），让 Live2D 口型跟着真实播放进度走
- 翻译增加 429 退避重试（3 次，600ms→1560ms），失败自动回退原文合成

## 协议说明

| 接口 | 方向 | 说明 |
|---|---|---|
| `POST /voice/speak` | 插件 → Demon | `{ text, original, profile, lang, speed }`，返回 WAV |
| `POST /voice/playback` | 插件 → Demon | `{ phase: start｜tick｜stop, t? }`，`t` 为 `audio.currentTime` |
| `GET /voice/status` | 插件 → Demon | 服务状态 |
