/**
 * SmartDemon 配音台 —— SillyTavern 前端扩展 v2.0（后端为 Demon 引擎）
 *
 * 与 IndexTTS 版的区别：
 *  - 一个音色 = GPT 权重 + SoVITS 权重 + 参考音频 + 参考文本（"音色档案"）
 *  - 切换音色要真的换权重，所以做了「已加载权重缓存 + 全程串行队列」
 *  - 参考音频是日文、朗读文本是中文时，text_lang 用 zh、prompt_lang 用 ja（跨语种）
 *
 * 只通过 SillyTavern.getContext() 取功能；纯逻辑在 lib/tts-text.js（可单测）。
 */

import {
    SLOT_EXT_KEYS,
    DEFAULT_SLOT_ID,
    LANGUAGES,
    extractSpeakableText,
    splitSentences,
    detectLang,
    readCardSlots,
    cardDefaultSlot,
    annotatedSlot,
    resolveSlotId,
    nextSlotId,
    normalizeBinding,
    parseSlotSpec,
    normalizeProfile,
    sameWeights,
    cacheKey,
    findProfile,
    slugId,
    clampSpeed,
    clampNum,
} from './lib/tts-text.js';

const MODULE = 'smartdemon';
const CARD_KEY = 'gptsovits5';
const DRAWER_ID = 'g5-drawer';
const PANEL_ID = 'g5-panel';

const DEFAULTS = Object.freeze({
    enabled: true,
    serverUrl: 'http://127.0.0.1:8790',
    autoPlay: false,
    stripActions: true,
    readQuotedOnly: false,
    maxChars: 200,
    /** 输出语言：auto = 跟随文本，其余为 GPT-SoVITS 支持的语种 */
    outputLang: 'auto',
    /** 输出语言与文本语言不一致时，先用酒馆当前模型翻译再合成 */
    translate: false,
    splitMethod: 'cut5',
    timeoutMs: 180000,
    fallbackProfileId: '',
    /** @type {any[]} */
    profiles: [],
    /** @type {Record<string, any>} */
    bindings: {},
    adv: { topK: 15, topP: 1, temperature: 1, repetitionPenalty: 1.35, sampleSteps: '' },
});

let settings = null;
let voicesCacheLoaded = false;
let session = null;
let sessionSeq = 0;
let drawerOpen = false;
let booted = false;
let editingProfileId = '';

/** 已加载到服务端的权重（避免重复切换） */
let loadedWeights = { gpt: '', sovits: '' };
/** 合成/切权重的串行队列 */
let queue = Promise.resolve();
/** 音频缓存（profile+lang+speed+text → Blob），简单的 LRU */
const audioCache = new Map();
const CACHE_LIMIT = 64;

/* ------------------------------------------------------------------ 基础 */

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function toast(kind, message) {
    const fn = globalThis.toastr?.[kind];
    if (typeof fn === 'function') fn.call(globalThis.toastr, message, 'SmartDemon');
    else console[kind === 'error' ? 'error' : 'log'](`[GPTSoVITS5] ${message}`);
}

function save() {
    try { ctx()?.saveSettingsDebounced?.(); } catch (err) { console.warn('[GPTSoVITS5] 保存失败', err); }
}

function getSettings() {
    const c = ctx();
    if (!c) return structuredClone(DEFAULTS);
    const store = c.extensionSettings;
    if (!store[MODULE] || typeof store[MODULE] !== 'object') store[MODULE] = structuredClone(DEFAULTS);
    const s = store[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(DEFAULTS[key]);
    }
    // 旧版字段迁移：textLang → outputLang
    if (typeof s.textLang === 'string' && s.textLang !== 'auto' && s.outputLang === 'auto') {
        s.outputLang = s.textLang;
    }
    if (!Array.isArray(s.profiles)) s.profiles = [];
    if (!s.bindings || typeof s.bindings !== 'object') s.bindings = {};
    if (!s.adv || typeof s.adv !== 'object') s.adv = structuredClone(DEFAULTS.adv);
    return s;
}

function baseUrl() {
    return String(settings?.serverUrl || '').trim().replace(/\/+$/, '');
}

/** 串行执行，避免切权重和合成交错 */
function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

/* -------------------------------------------------------------- 服务端 */

/**
 * 探活：/control 不带 command 会返回 400 JSON —— 只要有响应就说明通。
 * （注意：绝对不能带 command=restart，那会重启服务端）
 */
async function probeServer() {
    const base = baseUrl();
    if (!base) throw new Error('未填写 Demon 地址');
    const res = await fetch(`${base}/healthz`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try { return (await res.json())?.status === 'ok'; } catch { return true; }
}

/** 从 Demon 拉声线列表（声线由 Demon 管理，插件只引用 id/name） */
async function syncProfilesFromDemon() {
    const base = baseUrl();
    if (!base) return;
    const res = await fetch(`${base}/voice/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = Array.isArray(data?.voice?.profiles) ? data.voice.profiles : [];
    const old = new Map(settings.profiles.map(p => [p.id, p]));
    settings.profiles = ids.map((id) => {
        const prev = old.get(id);
        return {
            id,
            name: prev?.name || id,
            gptWeights: '', sovitsWeights: '', refAudio: '', promptText: '',
            promptLang: prev?.promptLang || 'ja',
        };
    });
    if (data?.voice?.profile) settings.demonDefaultProfile = data.voice.profile;
    save();
    renderProfiles(); renderProfileForm(); renderCharRows(); refreshCurrentCard();
}

/** 翻译缓存：同语言 + 同文本只翻一次 */
const translateCache = new Map();

function langLabel(id) {
    return LANGUAGES.find(l => l.id === id)?.label ?? id;
}

/**
 * 决定这次合成用哪种语言。
 * @param {string} setting auto | zh | ja | en | ko | yue
 * @param {string} text
 * @returns {string}
 */
function resolveOutputLang(setting, text) {
    return !setting || setting === 'auto' ? detectLang(text) : setting;
}

/**
 * 用酒馆当前的模型把台词翻译成目标语言（只输出译文）。
 * 注意：GPT-SoVITS 的 text_lang 是"文本的语言"，不翻译就不可能真的念成另一种语言。
 * @param {string} text
 * @param {string} target
 * @returns {Promise<string>}
 */
async function translateText(text, target) {
    const key = `${target}\u0001${text}`;
    if (translateCache.has(key)) return translateCache.get(key);

    const c = ctx();
    const fn = c?.generateQuietPrompt;
    if (typeof fn !== 'function') {
        throw new Error('当前酒馆没有 generateQuietPrompt，无法翻译；把输出语言改回「跟随文本」');
    }

    const prompt = `Translate the following line into ${langLabel(target)} (${target}). `
        + 'Keep the tone and emotion. Output ONLY the translated line, no quotes, no notes.\n\n'
        + text;

    let out;
    try {
        out = await fn({ quietPrompt: prompt, quietName: 'translate', responseLength: Math.max(64, Math.min(1024, text.length * 3)) });
    } catch (err) {
        // 老版本签名：generateQuietPrompt(prompt, skipWIAN, responseLength)
        out = await fn(prompt, true);
    }

    const cleaned = String(out ?? '')
        .trim()
        .replace(/^["“”「『]+|["“”」』]+$/g, '')
        .trim();
    if (!cleaned) throw new Error('翻译返回空内容');

    translateCache.set(key, cleaned);
    while (translateCache.size > 64) translateCache.delete(translateCache.keys().next().value);
    return cleaned;
}

/**
 * 合成一段文本（走队列 + 缓存）。
 * @param {string} text
 * @param {any} profile
 * @param {{speed:number, textLang:string}} opts
 * @param {AbortSignal} signal
 * @returns {Promise<Blob>}
 */
async function synthesize(text, profile, opts, signal) {
    const target = resolveOutputLang(opts.textLang, text);
    const speed = clampSpeed(opts.speed);

    // 目标语言 ≠ 文本语言：要么翻译，要么如实按原文念（不是"换语言"）
    let speakText = text;
    if (target !== detectLang(text)) {
        if (settings.translate) {
            speakText = await translateText(text, target);
        } else {
            console.info(`[GPTSoVITS5] 输出语言=${target} 与文本不一致，未开翻译，按原文合成`);
        }
    }

    const key = cacheKey(profile, { text: speakText, textLang: target, speed });

    const hit = audioCache.get(key);
    if (hit) {
        audioCache.delete(key);
        audioCache.set(key, hit);
        return hit;
    }

    return enqueue(async () => {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

        // 交给 Demon：只有 text / profile / lang / speed
        const body = {
            text: speakText,
            profile: profile.id,
            lang: target,
            speed,
        };

        const res = await fetch(`${baseUrl()}/voice/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });

        if (!res.ok) {
            let detail = '';
            try {
                const data = await res.json();
                detail = data?.error?.message || data?.message || '';
            } catch { /* ignore */ }
            throw new Error(`合成失败 HTTP ${res.status}${detail ? '：' + detail : ''}`);
        }

        const blob = await res.blob();
        if (!blob.size) throw new Error('服务端返回了空音频');

        audioCache.set(key, blob);
        while (audioCache.size > CACHE_LIMIT) {
            audioCache.delete(audioCache.keys().next().value);
        }
        return blob;
    });
}

/* -------------------------------------------------------------- 播放 */

function stopSession() {
    if (!session) return;
    session.aborted = true;
    try { session.controller.abort(); } catch { /* ignore */ }
    if (session.timer) clearTimeout(session.timer);
    if (session.audio) {
        try { session.audio.pause(); session.audio.src = ''; } catch { /* ignore */ }
    }
    session = null;
    setBusy(false);
    updateProgress(0, 0);
}

function newSession() {
    stopSession();
    sessionSeq += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(settings.timeoutMs) || 180000));
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    session = { id: sessionSeq, aborted: false, controller, timer, audio: null };
    return session;
}

function guard(p) { p.catch(() => {}); return p; }

function playBlob(blob, s) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        s.audio = audio;
        const cleanup = () => { URL.revokeObjectURL(url); if (s.audio === audio) s.audio = null; };
        audio.onended = () => { cleanup(); resolve(); };
        audio.onerror = () => { cleanup(); reject(new Error('音频播放失败')); };
        audio.play().catch((err) => { cleanup(); reject(err); });
    });
}

/**
 * 朗读文本：清洗 → 断句 → 逐段合成播放（播当前段时预取下一段）。
 * @param {string} rawText
 * @param {{profile:any, speed:number, textLang:string}|null} cfg
 * @param {string} label
 */
function defaultProfile() {
    if (!settings) return null;
    const id = settings.demonDefaultProfile;
    return settings.profiles.find(p => p.id === id) || settings.profiles[0] || null;
}

async function speak(rawText, cfg, label) {
    if (!settings.enabled) return;

    // 角色没绑定时，用 Demon 的默认声线兜底
    let useCfg = cfg;
    if (!useCfg?.profile) {
        const fallback = defaultProfile();
        if (fallback) {
            useCfg = { ...(useCfg || {}), profile: fallback, speed: useCfg?.speed ?? 1, textLang: useCfg?.textLang ?? 'auto' };
        }
    }
    if (!useCfg?.profile) {
        toast('info', `「${label || '该角色'}」还没绑定音色档案，先在面板里选一个`);
        return;
    }

    const clean = extractSpeakableText(rawText, {
        stripActions: settings.stripActions,
        readQuotedOnly: settings.readQuotedOnly,
    });
    const chunks = splitSentences(clean, { maxLen: Math.max(40, Number(settings.maxChars) || 200) });
    if (!chunks.length) {
        toast('info', '这条消息里没有可朗读的文字');
        return;
    }

    const s = newSession();
    setBusy(true);
    try {
        let pending = guard(synthesize(chunks[0], useCfg.profile, useCfg, s.controller.signal));
        for (let i = 0; i < chunks.length; i++) {
            if (s.aborted) break;
            const blob = await pending;
            if (s.aborted) break;
            if (i + 1 < chunks.length) {
                pending = guard(synthesize(chunks[i + 1], useCfg.profile, useCfg, s.controller.signal));
            }
            updateProgress(i + 1, chunks.length);
            await playBlob(blob, s);
        }
    } catch (err) {
        if (s.aborted) return;
        const msg = String(err?.message || err);
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
            toast('error', '连不上 Demon 引擎（127.0.0.1:8790）。请先启动 Demon，确认「状态」页显示监听正常。');
            setStatus('连不上服务端（可能是 CORS）', 'bad');
        } else {
            toast('error', msg);
        }
    } finally {
        if (session === s) {
            if (s.timer) clearTimeout(s.timer);
            session = null;
            setBusy(false);
            updateProgress(0, 0);
        }
    }
}

/* ---------------------------------------------------------- 角色 / 声线 */

function keyForCharacter(character, fallbackName = '') {
    if (character?.avatar) return `avatar:${character.avatar}`;
    if (character?.name) return `name:${character.name}`;
    return fallbackName ? `name:${fallbackName}` : '';
}

function characterForMessage(message) {
    const list = ctx()?.characters ?? [];
    return list.find(c => c.name === message?.name) ?? null;
}

function rawBinding(key) {
    if (!key) return null;
    const raw = settings.bindings[key];
    const normalized = normalizeBinding(raw);
    if (!normalized) return null;
    if (raw !== normalized) {
        settings.bindings[key] = { slots: normalized.slots, activeSlot: normalized.activeSlot };
        save();
    }
    return normalized;
}

function ensureBinding(key) {
    const existing = rawBinding(key);
    if (existing) return existing;
    const created = { slots: {}, activeSlot: '' };
    if (key) settings.bindings[key] = created;
    return created;
}

function ensureSlot(binding, slotId) {
    if (!binding.slots[slotId] || typeof binding.slots[slotId] !== 'object') {
        binding.slots[slotId] = { profileId: '', speed: 1, textLang: 'auto' };
        save();
    }
    return binding.slots[slotId];
}

/**
 * 把「槽位配置」解析成可直接合成的对象。
 * @param {any} binding
 * @param {string} slotId
 */
function slotConfig(binding, slotId) {
    const cfg = binding?.slots?.[slotId] ?? {};
    const profile = findProfile(settings.profiles, cfg.profileId)
        || findProfile(settings.profiles, settings.fallbackProfileId);
    return {
        profile,
        speed: clampSpeed(cfg.speed ?? 1),
        textLang: cfg.textLang || settings.outputLang || 'auto',
    };
}

function resolveForMessage(message) {
    const character = characterForMessage(message);
    const slots = readCardSlots(character);
    const key = keyForCharacter(character, message?.name);
    const binding = rawBinding(key);
    const slotId = resolveSlotId({
        message,
        binding,
        slots,
        defaultSlot: cardDefaultSlot(character),
    });
    return { character, slots, binding, key, slotId, cfg: slotConfig(binding, slotId) };
}

function slotLabel(slots, slotId) {
    return slots.find(s => s.id === slotId)?.label ?? slotId;
}

function speakMessage(mesId, options = {}) {
    const message = ctx()?.chat?.[mesId];
    if (!message) return;
    const resolved = resolveForMessage(message);
    let slotId = resolved.slotId;
    if (options.slotOverride && resolved.slots.some(s => s.id === options.slotOverride)) {
        slotId = options.slotOverride;
    }
    const cfg = slotConfig(resolved.binding, slotId);
    const label = `${message.name}（${slotLabel(resolved.slots, slotId)}）`;
    speak(message.mes, cfg, label);
}

/* ---- 选句播放 ---- */

let sentMenu = null;

function closeSentMenu() {
    if (sentMenu) { sentMenu.remove(); sentMenu = null; }
}

function chunksForMessage(message) {
    const clean = extractSpeakableText(message?.mes ?? '', {
        stripActions: settings.stripActions,
        readQuotedOnly: settings.readQuotedOnly,
    });
    return splitSentences(clean, { maxLen: Math.max(40, Number(settings.maxChars) || 200) });
}

function openSentenceMenu(mesId, anchorEl) {
    closeSentMenu();
    const message = ctx()?.chat?.[mesId];
    if (!message) return;
    const chunks = chunksForMessage(message);
    if (!chunks.length) { toast('info', '这条消息里没有可朗读的文字'); return; }

    const menu = h('div', { class: 'g5-sent-menu' });
    chunks.forEach((chunk, i) => {
        const item = h('div', {
            class: 'g5-sent-item',
            title: '点这一句只播这一句',
            onclick: (e) => {
                e.stopPropagation();
                const resolved = resolveForMessage(message);
                const cfg = slotConfig(resolved.binding, resolved.slotId);
                const label = `${message.name}（第 ${i + 1} 句）`;
                closeSentMenu();
                speak(chunk, cfg, label);
            },
        }, [
            h('span', { class: 'g5-sent-no', text: String(i + 1) }),
            h('span', { class: 'g5-sent-text', text: chunk.length > 42 ? chunk.slice(0, 42) + '…' : chunk }),
        ]);
        menu.append(item);
    });

    document.body.append(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - 300, rect.left)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    sentMenu = menu;

    setTimeout(() => {
        document.addEventListener('click', closeSentMenu, { once: true });
    }, 0);
}

function speakLast() {
    const chat = ctx()?.chat ?? [];
    if (!chat.length) { toast('info', '当前聊天是空的'); return; }
    speakMessage(chat.length - 1);
}

function nextSlotForMessage(mesId) {
    const message = ctx()?.chat?.[mesId];
    if (!message) return '';
    const resolved = resolveForMessage(message);
    return nextSlotId(resolved.slots, resolved.slotId);
}

async function cycleAnnotation(mesId) {
    const c = ctx();
    const message = c?.chat?.[mesId];
    if (!message) return;
    const resolved = resolveForMessage(message);
    const ids = resolved.slots.map(s => s.id);
    if (ids.length < 2) {
        toast('info', '这个角色只有一条声线，先去角色卡加第二条');
        return;
    }
    const current = annotatedSlot(message);
    let next;
    if (!current || !ids.includes(current)) {
        next = nextSlotId(resolved.slots, resolved.slotId);
    } else {
        const index = ids.indexOf(current);
        next = index + 1 < ids.length ? ids[index + 1] : '';
    }

    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    if (next) {
        message.extra[CARD_KEY] = { ...(message.extra[CARD_KEY] || {}), slot: next };
        // 顺手清掉旧插件的同名标注，避免两个键说法不一致
        if (message.extra[SLOT_EXT_KEYS[1]]?.slot) {
            delete message.extra[SLOT_EXT_KEYS[1]].slot;
            if (!Object.keys(message.extra[SLOT_EXT_KEYS[1]]).length) delete message.extra[SLOT_EXT_KEYS[1]];
        }
    } else {
        delete message.extra[CARD_KEY];
    }

    try {
        await c.saveChat?.();
    } catch (err) {
        toast('error', `写回聊天失败：${err.message}`);
        return;
    }
    decorateMessages();
    toast('info', next ? `#${mesId} 标注为「${slotLabel(resolved.slots, next)}」` : `#${mesId} 已取消标注`);
}

/* ------------------------------------------------------------------ UI */

function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === false || v === null || v === undefined) continue;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
    }
    for (const child of [].concat(children)) if (child) el.append(child);
    return el;
}

function currentCharacter() {
    const c = ctx();
    if (!c) return null;
    const id = c.characterId;
    if (id === undefined || id === null) return null;
    return c.characters?.[Number(id)] ?? null;
}

function profileOptions(selected) {
    const opts = [h('option', { value: '', text: '（未绑定）' })];
    for (const p of settings.profiles) {
        opts.push(h('option', { value: p.id, text: p.name || p.id, selected: p.id === selected }));
    }
    return opts;
}

function langOptions(selected, allowAuto = true) {
    const opts = allowAuto ? [h('option', { value: 'auto', text: '自动', selected: selected === 'auto' })] : [];
    for (const lang of LANGUAGES) {
        opts.push(h('option', { value: lang.id, text: lang.label, selected: lang.id === selected }));
    }
    return opts;
}

function setStatus(text, kind = '') {
    const el = document.getElementById('g5-status');
    if (!el) return;
    el.textContent = text;
    el.className = `g5-status ${kind}`;
}
function setBusy(busy) {
    const el = document.getElementById('g5-busy');
    if (el) el.classList.toggle('g5-spin', Boolean(busy));
}
function updateProgress(done, total) {
    const el = document.getElementById('g5-progress');
    if (el) el.textContent = total ? `第 ${done}/${total} 段` : '';
}

/* ---- 音色档案 ---- */

function renderProfiles() {
    const list = document.getElementById('g5-profiles');
    if (!list) return;
    list.replaceChildren();

    if (!settings.profiles.length) {
        list.append(h('div', { class: 'g5-empty', text: '还没有音色档案。下面是表单，填好点「保存为新档案」。' }));
    }

    for (const p of settings.profiles) {
        const { missing } = normalizeProfile(p);
        const row = h('div', { class: `g5-profile${p.id === editingProfileId ? ' g5-profile-active' : ''}` });
        row.append(h('span', { class: 'g5-profile-name', text: p.name || p.id, title: p.id }));
        row.append(h('span', {
            class: `g5-badge${missing.length ? ' g5-badge-warn' : ''}`,
            text: missing.length ? `缺 ${missing.join('/')}` : '就绪',
        }));
        row.append(h('div', { class: 'g5-row-actions' }, [
            h('i', { class: 'g5-icon fa-solid fa-pen', title: '编辑', onclick: () => { editingProfileId = p.id; renderProfiles(); renderProfileForm(); } }),
            h('i', {
                class: 'g5-icon fa-solid fa-play', title: '试听（合成一句固定台词）',
                onclick: () => previewProfile(p),
            }),
            h('i', {
                class: 'g5-icon fa-solid fa-trash', title: '删除',
                onclick: () => {
                    if (!confirm(`删除音色档案「${p.name || p.id}」？绑定会被清空。`)) return;
                    settings.profiles = settings.profiles.filter(x => x.id !== p.id);
                    for (const b of Object.values(settings.bindings)) {
                        for (const slot of Object.values(b.slots || {})) {
                            if (slot?.profileId === p.id) slot.profileId = '';
                        }
                    }
                    if (editingProfileId === p.id) editingProfileId = '';
                    save();
                    renderProfiles(); renderProfileForm(); renderCharRows(); refreshCurrentCard();
                },
            }),
        ]));
        list.append(row);
    }
}

function renderProfileForm() {
    const box = document.getElementById('g5-profile-form');
    if (!box) return;
    const editing = settings.profiles.find(p => p.id === editingProfileId);

    const field = (label, key, placeholder, hint) => {
        const input = h('input', {
            type: 'text', class: 'g5-input', value: editing?.[key] ?? '',
            placeholder: placeholder || '',
            title: hint || '',
        });
        input.dataset.key = key;
        return h('label', { class: 'g5-field' }, [h('span', { text: label }), input]);
    };

    const promptLang = h('select', { class: 'g5-select g5-select-narrow' },
        langOptions(editing?.promptLang || 'ja', false));
    promptLang.dataset.key = 'promptLang';

    box.replaceChildren(
        h('div', { class: 'g5-form-title' }, [
            h('span', { text: editing ? `声线：${editing.name || editing.id}` : '声线由 Demon 管理' }),
        ]),
        h('div', { class: 'g5-hint', text: '声线档案（参考音频、权重、提示文本）现在全部放在 Demon 的「语音」页里管理。这里只显示 Demon 提供的声线。' }),
        h('div', { class: 'g5-row-inline' }, [
            h('button', {
                class: 'g5-btn g5-btn-primary', text: '从 Demon 同步声线',
                onclick: () => { syncProfilesFromDemon().catch(e => toast('error', e.message)); },
            }),
            h('button', {
                class: 'g5-btn', text: '试听这条',
                onclick: () => { const p = settings.profiles.find(x => x.id === editingProfileId); if (p) previewProfile(p); },
            }),
        ]),
        );
}

function collectProfileInputs(panel) {
    const data = {};
    panel.querySelectorAll('#g5-profile-form [data-key]').forEach(el => {
        data[el.dataset.key] = el.value.trim();
    });
    const { profile, missing } = normalizeProfile(data);
    return { profile, missing };
}

function saveProfile() {
    // 声线由 Demon 管理，插件端不再保存档案
    toast('info', '声线请在 Demon 的「语音」页维护，这里点「从 Demon 同步声线」即可');
}

async function previewProfile(profile) {
    const cfg = { profile, speed: 1, textLang: 'auto' };
    await speak('你好，我是小d。今天也请多关照。', cfg, `试听：${profile.name}`);
}

/* ---- 当前角色 / 槽位 ---- */

function renderCharRows() {
    const list = document.getElementById('g5-charlist');
    if (!list) return;
    list.replaceChildren();
    const characters = ctx()?.characters ?? [];
    if (!characters.length) {
        list.append(h('div', { class: 'g5-empty', text: '还没有角色卡。' }));
        return;
    }
    const currentId = ctx()?.characterId;
    characters.forEach((character, i) => {
        const key = keyForCharacter(character);
        const binding = rawBinding(key);
        const bound = binding ? Object.values(binding.slots || {}).filter(s => s?.profileId).length : 0;
        const row = h('div', { class: `g5-row${i === Number(currentId) ? ' g5-row-current' : ''}` });
        row.append(h('span', { class: 'g5-row-name', text: character.name || '(无名)', title: key }));
        row.append(h('span', { class: 'g5-badge', text: bound ? `${bound} 已绑` : '未绑定' }));
        row.append(h('div', { class: 'g5-row-actions' }, [
            h('i', {
                class: 'g5-icon fa-solid fa-volume-high', title: '用这个角色的音色念最后一条',
                onclick: () => {
                    const chat = ctx()?.chat ?? [];
                    if (!chat.length) return;
                    const slots = readCardSlots(character);
                    const slotId = resolveSlotId({
                        message: chat[chat.length - 1], binding,
                        slots, defaultSlot: cardDefaultSlot(character),
                    });
                    speak(chat[chat.length - 1].mes, slotConfig(binding, slotId), character.name);
                },
            }),
            h('i', {
                class: 'g5-icon fa-solid fa-link-slash', title: '解绑',
                onclick: () => {
                    delete settings.bindings[key];
                    save(); renderCharRows(); refreshCurrentCard();
                },
            }),
        ]));
        list.append(row);
    });
}

function refreshCurrentCard() {
    const box = document.getElementById('g5-current');
    if (!box) return;
    const character = currentCharacter();
    if (!character) {
        box.replaceChildren(h('div', { class: 'g5-empty', text: '群聊或未选中角色；先选中角色再来绑定。' }));
        return;
    }

    const key = keyForCharacter(character);
    const slots = readCardSlots(character);
    const defaultSlot = cardDefaultSlot(character);
    const binding = rawBinding(key);
    const view = binding ?? { slots: {}, activeSlot: '' };

    box.replaceChildren(h('div', { class: 'g5-current-title' }, [
        h('b', { text: character.name }),
        h('span', { class: 'g5-muted', text: ` ${slots.length} 条声线` }),
    ]));

    const slotInput = h('input', {
        type: 'text', class: 'g5-input',
        value: slots.map(s => (s.label === s.id ? s.id : `${s.id}:${s.label}`)).join(', '),
        title: '声线 id:显示名，逗号分隔；会写进角色卡的 extensions',
    });
    box.append(h('label', { class: 'g5-field' }, [
        h('span', { text: '声线接口' }), slotInput,
        h('button', { class: 'g5-btn', text: '写入角色卡', onclick: () => writeSlotsToCard(slotInput.value) }),
    ]));

    const autoRadio = h('input', { type: 'radio', name: 'g5-active', value: '' });
    autoRadio.checked = !view.activeSlot;
    autoRadio.addEventListener('change', () => {
        const b = ensureBinding(key); b.activeSlot = ''; save(); renderCharRows();
    });
    box.append(h('label', { class: 'g5-check' }, [
        autoRadio,
        h('span', { text: `激活：自动（卡默认「${slotLabel(slots, defaultSlot)}」，有标注用标注）` }),
    ]));

    for (const slot of slots) {
        const cfg = view.slots?.[slot.id] ?? {};
        const row = h('div', { class: 'g5-slot' });

        const radio = h('input', { type: 'radio', name: 'g5-active', value: slot.id });
        radio.checked = view.activeSlot === slot.id;
        radio.addEventListener('change', () => {
            const b = ensureBinding(key); b.activeSlot = slot.id; save(); renderCharRows();
        });

        const profileSelect = h('select', { class: 'g5-select' }, profileOptions(cfg.profileId ?? ''));
        profileSelect.addEventListener('change', () => {
            const b = ensureBinding(key);
            ensureSlot(b, slot.id).profileId = profileSelect.value;
            save(); renderCharRows();
        });

        const speed = h('input', {
            type: 'number', min: '0.5', max: '2', step: '0.05',
            class: 'g5-input g5-input-num', value: String(clampSpeed(cfg.speed ?? 1)),
            title: '语速（speed_factor，>1 更快）',
        });
        speed.addEventListener('change', () => {
            const b = ensureBinding(key);
            const v = clampSpeed(speed.value);
            ensureSlot(b, slot.id).speed = v;
            speed.value = v.toFixed(2);
            save();
        });

        const lang = h('select', { class: 'g5-select g5-select-narrow' }, langOptions(cfg.textLang || 'auto', true));
        lang.addEventListener('change', () => {
            const b = ensureBinding(key);
            ensureSlot(b, slot.id).textLang = lang.value;
            save();
        });

        row.append(
            radio,
            h('span', { class: 'g5-slot-label', text: slot.label, title: slot.id }),
            profileSelect, speed, lang,
            h('i', {
                class: 'g5-icon fa-solid fa-play', title: '试听这条声线',
                onclick: () => {
                    const profile = findProfile(settings.profiles, cfg.profileId);
                    if (!profile) {
                        toast('info', '这条声线还没选音色档案');
                        return;
                    }
                    previewProfile(profile);
                },
            }),
        );
        box.append(row);
    }

    box.append(h('div', {
        class: 'g5-hint',
        text: '声线与权重由 Demon 管理，切换约 0.3~0.5 秒。消息上的 🔊：点=朗读，Shift+点=换声线，Alt+点=标注。',
    }));
}

async function writeSlotsToCard(specText) {
    const c = ctx();
    const id = c?.characterId;
    if (id === undefined || id === null) { toast('info', '先选中一个角色'); return; }
    const slots = parseSlotSpec(specText);
    if (!slots.length) { toast('error', '声线接口不能为空'); return; }

    const character = c.characters?.[Number(id)];
    const key = keyForCharacter(character);
    const binding = rawBinding(key);
    const defaultSlot = binding?.activeSlot && slots.some(s => s.id === binding.activeSlot)
        ? binding.activeSlot : slots[0].id;
    const payload = { version: 1, character: character?.name || '', defaultSlot, slots };

    try {
        if (typeof c.writeExtensionField === 'function') {
            await c.writeExtensionField(Number(id), CARD_KEY, payload);
        }
        if (character) {
            character.data = character.data || {};
            character.data.extensions = character.data.extensions || {};
            character.data.extensions[CARD_KEY] = payload;
        }
        toast('success', `已写入「${character?.name ?? '角色'}」的声线接口（${slots.length} 条）`);
        refreshCurrentCard(); renderCharRows();
    } catch (err) {
        toast('error', `写入角色卡失败：${err.message}`);
    }
}

/* ---- 一键启动（辅助） ---- */

/* ---- 面板 ---- */

function buildPanel() {
    const panel = h('div', { id: 'g5-panel', class: 'g5-panel' });

    const serverInput = h('input', {
        type: 'text', class: 'g5-input', id: 'g5-server', value: settings.serverUrl, placeholder: 'http://127.0.0.1:8790',
    });
    serverInput.addEventListener('change', () => {
        settings.serverUrl = serverInput.value.trim();
        loadedWeights = { gpt: '', sovits: '' };
        audioCache.clear();
        save();
        doProbe();
    });

    const top = h('div', { class: 'g5-block' }, [
        h('div', { class: 'g5-block-title' }, [
            h('span', { text: 'Demon 引擎' }),
            h('i', { id: 'g5-busy', class: 'g5-icon fa-solid fa-spinner' }),
        ]),
        h('div', { class: 'g5-statusbar' }, [h('span', { id: 'g5-status', class: 'g5-status', text: '未连接' })]),
        serverInput,
        h('div', { class: 'g5-row-inline' }, [
            h('button', { class: 'g5-btn', text: '测试连接', onclick: () => doProbe() }),
            h('button', { class: 'g5-btn', text: 'Demon 8790', onclick: () => applyServerUrl('http://127.0.0.1:8790') }),
        ]),
        h('div', { class: 'g5-row-inline' }, [
            h('span', { class: 'g5-muted', id: 'g5-route', text: '' }),
        ]),
        h('div', {
            class: 'g5-hint',
            text: 'Demon 引擎必须先启动（桌面快捷方式）。语音合成由 Demon 调 GPT-SoVITS，插件这边只负责选句和播放。',
        }),
    ]);

    const profilesBlock = h('div', { class: 'g5-block' }, [
        h('div', { class: 'g5-block-title' }, [h('span', { text: '音色档案' })]),
        h('div', { id: 'g5-profiles', class: 'g5-profiles' }),
        h('div', { id: 'g5-profile-form', class: 'g5-form' }),
    ]);

    const currentBlock = h('div', { class: 'g5-block' }, [
        h('div', { class: 'g5-block-title' }, [
            h('span', { text: '当前角色 · 声线' }),
            h('span', { class: 'g5-muted', text: ' 圆点=激活' }),
        ]),
        h('div', { id: 'g5-current', class: 'g5-current' }),
    ]);

    const listBlock = h('div', { class: 'g5-block' }, [
        h('div', { class: 'g5-block-title' }, [h('span', { text: '全部角色' })]),
        h('div', { id: 'g5-charlist', class: 'g5-charlist' }),
    ]);

    const autoPlay = h('input', { type: 'checkbox' });
    autoPlay.checked = Boolean(settings.autoPlay);
    autoPlay.addEventListener('change', () => { settings.autoPlay = autoPlay.checked; save(); });

    const stripActions = h('input', { type: 'checkbox' });
    stripActions.checked = Boolean(settings.stripActions);
    stripActions.addEventListener('change', () => { settings.stripActions = stripActions.checked; save(); });

    const quotedOnly = h('input', { type: 'checkbox' });
    quotedOnly.checked = Boolean(settings.readQuotedOnly);
    quotedOnly.addEventListener('change', () => { settings.readQuotedOnly = quotedOnly.checked; save(); });

    const maxChars = h('input', { type: 'number', min: '40', max: '600', step: '10', class: 'g5-input g5-input-num', value: String(settings.maxChars) });
    maxChars.addEventListener('change', () => {
        settings.maxChars = Math.min(600, Math.max(40, Number(maxChars.value) || 200));
        maxChars.value = String(settings.maxChars);
        save();
    });

    const textLang = h('select', { class: 'g5-select g5-select-narrow' }, langOptions(settings.outputLang || 'auto', true));
    textLang.addEventListener('change', () => {
        settings.outputLang = textLang.value;
        save();
        refreshCurrentCard();
    });

    const translateBox = h('input', { type: 'checkbox' });
    translateBox.checked = Boolean(settings.translate);
    translateBox.addEventListener('change', () => {
        settings.translate = translateBox.checked;
        save();
    });

    const splitMethod = h('select', { class: 'g5-select g5-select-narrow' }, ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'].map(v =>
        h('option', { value: v, text: v, selected: (settings.splitMethod || 'cut5') === v })));
    splitMethod.addEventListener('change', () => { settings.splitMethod = splitMethod.value; save(); });

    const fallback = h('select', { class: 'g5-select' }, profileOptions(settings.fallbackProfileId));
    fallback.addEventListener('change', () => { settings.fallbackProfileId = fallback.value; save(); });

    const advField = (label, key, min, max, step) => {
        const input = h('input', {
            type: 'number', class: 'g5-input g5-input-num',
            min: String(min), max: String(max), step: String(step),
            value: String(settings.adv?.[key] ?? ''),
        });
        input.addEventListener('change', () => {
            settings.adv = settings.adv || {};
            settings.adv[key] = input.value === '' ? '' : Number(input.value);
            save();
        });
        return h('label', { class: 'g5-field' }, [h('span', { text: label }), input]);
    };

    const optionsBlock = h('div', { class: 'g5-block' }, [
        h('div', { class: 'g5-block-title' }, [h('span', { text: '朗读设置' })]),
        h('label', { class: 'g5-check' }, [autoPlay, h('span', { text: '新回复自动朗读（按声线解析）' })]),
        h('label', { class: 'g5-check' }, [stripActions, h('span', { text: '去掉（动作描写）与 *星号动作*' })]),
        h('label', { class: 'g5-check' }, [quotedOnly, h('span', { text: '只朗读引号内的台词' })]),
        h('label', { class: 'g5-field' }, [h('span', { text: '单段最大字数' }), maxChars]),
        h('label', { class: 'g5-field' }, [h('span', { text: '输出语言' }), textLang]),
        h('label', { class: 'g5-check' }, [translateBox, h('span', { text: '语言不一致时先翻译再合成（用当前对话模型）' })]),
        h('label', { class: 'g5-field' }, [h('span', { text: '切分方法' }), splitMethod]),
        h('label', { class: 'g5-field' }, [h('span', { text: '未绑定时的默认档案' }), fallback]),
        h('details', { class: 'g5-details' }, [
            h('summary', { text: '高级参数（采样）' }),
            advField('top_k', 'topK', 1, 100, 1),
            advField('top_p', 'topP', 0.05, 1, 0.05),
            advField('temperature', 'temperature', 0.05, 2, 0.05),
            advField('重复惩罚', 'repetitionPenalty', 1, 2, 0.01),
            advField('sample_steps', 'sampleSteps', 0, 64, 1),
            h('div', { class: 'g5-hint', text: 'sample_steps 只对 v3/v5 系列有效，留空表示用服务端默认。' }),
        ]),
        h('div', { class: 'g5-hint', text: '参考音频是日文、朗读文本是中文：文本语言选「自动」即可（会判成 zh），参考语言保持 ja。' }),
    ]);

    const actions = h('div', { class: 'g5-actions' }, [
        h('button', { class: 'g5-btn g5-btn-primary', text: '朗读最后一条', onclick: () => speakLast() }),
        h('button', { class: 'g5-btn', text: '停止', onclick: () => stopSession() }),
        h('span', { id: 'g5-progress', class: 'g5-muted' }),
    ]);

    panel.append(
                    h('div', { class: 'g5-header' }, [h('b', { text: 'SmartDemon · 配音台' })]),
        top, profilesBlock, currentBlock, listBlock, optionsBlock, actions,
    );
    return panel;
}

async function doProbe() {
    setStatus('检测中…');
    const route = document.getElementById('g5-route');
    if (route) route.textContent = '';
    try {
        const status = await probeServer();
        setStatus(`已连接（/control → HTTP ${status}）`, 'ok');
        if (route) {
            route.textContent = 'Demon 引擎';
        }
    } catch (err) {
        setStatus(`未连接：${err.message}`, 'bad');
        if (route) route.textContent = 'Demon 未连接';
    }
}

function decorateMessages() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const chat = ctx()?.chat ?? [];
    for (const node of chatEl.querySelectorAll('.mes')) {
        if (node.querySelector('.g5-narrate')) continue;
        const mesId = Number(node.getAttribute('mesid'));
        if (!Number.isFinite(mesId)) continue;
        // 只给 AI 消息加按钮：跳过用户消息、系统提示
        if (node.classList.contains('is_user') || node.classList.contains('smallSysMes')) continue;
        const msg = ctx()?.chat?.[mesId];
        if (msg && (msg.is_user || msg.is_system)) continue;
        const host = node.querySelector('.mes_buttons') ?? node.querySelector('.mes_block');
        if (!host) continue;

        const annotated = annotatedSlot(chat[mesId]);
        const btn = h('div', {
            class: `mes_button g5-narrate fa-solid fa-headphones${annotated ? ' g5-annotated' : ''}`,
            title: annotated ? `SmartDemon：本条标注为「${annotated}」` : 'SmartDemon：点=朗读，Shift+点=换声线，Alt+点=标注',
        });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.altKey) { cycleAnnotation(mesId); return; }
            speakMessage(mesId, e.shiftKey ? { slotOverride: nextSlotForMessage(mesId) } : {});
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation(); cycleAnnotation(mesId);
        });
        host.prepend(btn);

        // 选句按钮：弹出句子列表，点哪句播哪句
        const listBtn = h('div', {
            class: 'mes_button g5-narrate-list fa-solid fa-list',
            title: 'SmartDemon：选句播放（列出这条消息的每一句）',
        });
        listBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openSentenceMenu(mesId, listBtn);
        });
        host.prepend(listBtn);
    }
}

function toggleDrawer(force) {
    const drawer = document.getElementById(DRAWER_ID);
    if (!drawer) return;
    const wrap = drawer.querySelector('.g5-panel-wrap');
    const icon = drawer.querySelector('.g5-icon-toggle');
    const open = typeof force === 'boolean' ? force : !drawerOpen;
    drawerOpen = open;
    wrap.classList.toggle('g5-open', open);
    icon.classList.toggle('fa-headphones', !open);
    icon.classList.toggle('fa-xmark', open);
    if (open) { renderProfiles(); renderProfileForm(); renderCharRows(); refreshCurrentCard(); }
}

function injectDrawer() {
    if (document.getElementById(DRAWER_ID)) return true;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return false;

    const drawer = h('div', { id: DRAWER_ID, class: 'g5-drawer' });
    const toggle = h('div', {
        class: 'g5-toggle', title: 'SmartDemon 配音台',
        onclick: (e) => { e.stopPropagation(); toggleDrawer(); },
    }, [h('i', { class: 'g5-icon-toggle fa-solid fa-headphones' })]);
    drawer.append(toggle, h('div', { class: 'g5-panel-wrap' }, [buildPanel()]));
    holder.append(drawer);

    document.addEventListener('click', (e) => {
        if (!drawerOpen) return;
        if (drawer.contains(e.target)) return;
        toggleDrawer(false);
    });
    return true;
}

/* ---------------------------------------------------------------- 启动 */

async function init() {
    const c = ctx();
    if (!c) return;
    settings = getSettings();
    if (!injectDrawer()) return;

    renderProfiles();
    renderProfileForm();
    renderCharRows();
    refreshCurrentCard();
    decorateMessages();
    // 历史消息在 init 时可能还没渲染完，延迟补几次
    setTimeout(() => decorateMessages(), 800);
    setTimeout(() => decorateMessages(), 1800);
    syncProfilesFromDemon().catch((err) => console.warn('[SmartDemon] 同步声线失败', err));

    const { eventSource, event_types } = c;
    if (eventSource?.on && event_types) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            stopSession();
            renderCharRows(); refreshCurrentCard();
            decorateMessages();
            setTimeout(() => decorateMessages(), 1000);
        });
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            decorateMessages();
            if (!settings.enabled || !settings.autoPlay) return;
            const message = c.chat?.[mesId];
            if (!message) return;
            const resolved = resolveForMessage(message);
            if (!resolved.cfg.profile) return;
            speak(message.mes, resolved.cfg, `${message.name}（${slotLabel(resolved.slots, resolved.slotId)}）`);
        });
        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => decorateMessages());
        eventSource.on(event_types.MESSAGE_SWIPED, () => stopSession());
        eventSource.on(event_types.CHARACTER_EDITED, () => { renderCharRows(); refreshCurrentCard(); });
    }

    doProbe();
    console.info('[GPTSoVITS5] v1.0 已加载');
}

function boot() {
    if (booted) return;
    booted = true;
    settings = getSettings();

    let tries = 0;
    const tick = () => {
        tries += 1;
        if (injectDrawer()) { init(); return; }
        if (tries < 100) setTimeout(tick, 200);
        else console.warn('[GPTSoVITS5] 找不到 #top-settings-holder，放弃挂载');
    };
    tick();
}

if (typeof globalThis.SillyTavern?.getContext === 'function') {
    boot();
} else {
    let n = 0;
    const wait = setInterval(() => {
        n += 1;
        if (typeof globalThis.SillyTavern?.getContext === 'function') { clearInterval(wait); boot(); }
        else if (n > 100) clearInterval(wait);
    }, 100);
}

export async function onActivate() { boot(); }

// 控制台调试
globalThis.gptsovits5 = {
    speak,
    speakMessage,
    speakLast,
    stopSession,
    previewProfile,
    get settings() { return settings; },
    get loadedWeights() { return loadedWeights; },
    get cacheSize() { return audioCache.size; },
    clearCache: () => audioCache.clear(),
};
