/**
 * 纯逻辑层（GPT-SoVITS v5 版）
 *
 * 这里不碰浏览器、不碰 SillyTavern，可用 node 直接跑测试。
 * 与 IndexTTS 版的区别：
 *  - 一个"音色"不是单个参考音频，而是「GPT 权重 + SoVITS 权重 + 参考音频 + 参考文本 + 参考语言」
 *  - 没有情绪向量，情绪/语气来自参考音频本身
 *  - 所以核心对象从 "voice" 变成 "profile（音色档案）"
 */

/** 角色卡里存声线接口的 extensions 键（新插件用第一个，兼容旧卡的 indextts25） */
export const SLOT_EXT_KEYS = ['gptsovits5', 'indextts25'];
export const DEFAULT_SLOT_ID = 'default';

/** GPT-SoVITS 支持的文本语言（按官方 tts_infer.yaml，多余的会被服务端拒绝） */
export const LANGUAGES = [
    { id: 'zh', label: '中文' },
    { id: 'ja', label: '日本語' },
    { id: 'en', label: 'English' },
    { id: 'ko', label: '한국어' },
    { id: 'yue', label: '粤语' },
];

/** 参考文本语言默认值 */
export const DEFAULT_PROMPT_LANG = 'ja';

/* ------------------------------------------------------------------ 文本 */

const TERMINALS = '。！？!?；;…';
const CLOSERS = '"”』」》)]）】';
const RE_EMOJI = /[\p{Extended_Pictographic}]/gu;
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const RE_CJK_SPACE = /(?<=[\u3400-\u9fff\uf900-\ufaff]) +(?=[\u3400-\u9fff\uf900-\ufaff])/g;
const RE_QUOTED = /["“”「」『』]([^"“”「」『』]{1,})["“”「」『』]/g;

/**
 * 扫描器：剥掉成对包裹的内容（能处理嵌套 / 未闭合 / 多余收尾括号）。
 * @param {string} input
 * @param {string} open
 * @param {string} close
 */
function stripPaired(input, open, close) {
    let depth = 0;
    let out = '';
    for (const ch of input) {
        if (ch === open) { depth++; continue; }
        if (ch === close) { if (depth > 0) depth--; continue; }
        if (depth === 0) out += ch;
    }
    return out;
}

/**
 * 剥掉 *星号动作*（先保住 **粗体** 里的内容）。
 * @param {string} input
 */
function stripAsteriskActions(input) {
    const kept = input.replace(/\*\*([^*]{1,200})\*\*/g, '$1');
    let inside = false;
    let out = '';
    for (const ch of kept) {
        if (ch === '*') { inside = !inside; continue; }
        if (!inside) out += ch;
    }
    return out;
}

/**
 * 抽出该念的文本。
 * @param {string} mes
 * @param {{stripActions?:boolean, readQuotedOnly?:boolean, stripTags?:boolean, stripEmoji?:boolean}} [options]
 */
export function extractSpeakableText(mes, options = {}) {
    const {
        stripActions = true,
        readQuotedOnly = false,
        stripTags = true,
        stripEmoji = true,
    } = options;

    let s = String(mes ?? '');
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/<[^>]{1,200}>/g, ' ');

    if (readQuotedOnly) {
        const picked = [];
        RE_QUOTED.lastIndex = 0;
        let m;
        while ((m = RE_QUOTED.exec(s)) !== null) picked.push(m[1]);
        s = picked.join(' ');
    }

    if (stripActions) {
        s = stripPaired(s, '（', '）');
        s = stripPaired(s, '(', ')');
        s = stripAsteriskActions(s);
    }

    if (stripTags) s = s.replace(/\[[^\]]{0,40}\]/g, ' ');
    if (stripEmoji) s = s.replace(RE_EMOJI, ' ');

    s = s
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')
        .replace(/^\s*[-+*]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/[>*_~|]{1,}/g, ' ');

    s = s.replace(RE_CONTROL, ' ').replace(/\u00a0/g, ' ');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/ *([，。！？；：、…]) */g, '$1');
    s = s.replace(RE_CJK_SPACE, '');
    return s.trim();
}

/**
 * 按句末标点切分，连续终止符（「…！」）算一个整体。
 * @param {string} text
 */
function splitByTerminal(text) {
    const out = [];
    let buf = '';
    const isTerm = ch => TERMINALS.includes(ch);
    const isCloser = ch => CLOSERS.includes(ch);
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
        if (!isTerm(ch)) continue;
        let j = i + 1;
        while (j < text.length && isTerm(text[j])) { buf += text[j]; j++; }
        while (j < text.length && isCloser(text[j])) { buf += text[j]; j++; }
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        i = j - 1;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
}

/**
 * 断句（过长按逗号/空格硬切，过短合并）。
 * @param {string} text
 * @param {{maxLen?:number, minLen?:number}} [options]
 * @returns {string[]}
 */
export function splitSentences(text, options = {}) {
    const { maxLen = 200, minLen = 4 } = options;
    const raw = String(text ?? '').trim();
    if (!raw) return [];

    const expanded = [];
    for (const p of splitByTerminal(raw)) {
        if (p.length <= maxLen) { expanded.push(p); continue; }
        let rest = p;
        while (rest.length > maxLen) {
            let cut = -1;
            for (const sep of ['，', '、', ',', ' ']) {
                const idx = rest.lastIndexOf(sep, maxLen);
                if (idx > cut) cut = idx;
            }
            if (cut <= 0) cut = maxLen - 1;
            const head = rest.slice(0, cut + 1).trim();
            if (head) expanded.push(head);
            rest = rest.slice(cut + 1).trim();
        }
        if (rest) expanded.push(rest);
    }

    const merged = [];
    for (const p of expanded) {
        const last = merged[merged.length - 1];
        if (last !== undefined && last.length < minLen && (last + p).length <= maxLen) {
            merged[merged.length - 1] = last + p;
        } else {
            merged.push(p);
        }
    }
    return merged.filter(Boolean);
}

/**
 * 粗判语种：假名→ja，汉字→zh，谚文→ko，否则 en。
 * @param {string} text
 * @returns {'zh'|'ja'|'en'|'ko'}
 */
export function detectLang(text) {
    const s = String(text ?? '');
    if (/[\u3040-\u30ff]/.test(s)) return 'ja';
    if (/[\uac00-\ud7af]/.test(s)) return 'ko';
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
    return 'en';
}

/* ------------------------------------------------------------ 声线槽位 */

/**
 * 取角色卡里的声线块（新键优先，兼容旧卡的 indextts25）。
 * @param {any} character
 * @returns {any|null}
 */
export function slotBlock(character) {
    for (const key of SLOT_EXT_KEYS) {
        const fromData = character?.data?.extensions?.[key];
        if (fromData && typeof fromData === 'object') return fromData;
        const fromTop = character?.extensions?.[key];
        if (fromTop && typeof fromTop === 'object') return fromTop;
    }
    return null;
}

/**
 * 读角色卡声明的声线槽位。
 * @param {any} character
 * @returns {{id:string,label:string}[]} 至少一项
 */
export function readCardSlots(character) {
    const list = Array.isArray(slotBlock(character)?.slots) ? slotBlock(character).slots : [];
    const cleaned = [];
    const seen = new Set();
    for (const item of list) {
        const id = String(item?.id ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        cleaned.push({ id, label: String(item?.label ?? id).trim() || id });
    }
    return cleaned.length ? cleaned : [{ id: DEFAULT_SLOT_ID, label: '默认' }];
}

/**
 * 卡上声明的默认槽位（不在表里就退回第一个）。
 * @param {any} character
 * @returns {string}
 */
export function cardDefaultSlot(character) {
    const slots = readCardSlots(character);
    const declared = slotBlock(character)?.defaultSlot;
    return slots.some(s => s.id === declared) ? declared : slots[0].id;
}

/**
 * 消息上标的声线（新键优先）。
 * @param {any} message
 * @returns {string}
 */
export function annotatedSlot(message) {
    for (const key of SLOT_EXT_KEYS) {
        const slot = message?.extra?.[key]?.slot;
        if (typeof slot === 'string' && slot) return slot;
    }
    return '';
}

/**
 * 决定一条消息用哪条声线：
 * 消息标注 > 面板激活 > 卡默认 > 第一个已绑档案的槽 > 第一个槽
 * @param {{message?:any, binding?:{slots?:Record<string,any>, activeSlot?:string}|null, slots:{id:string}[], defaultSlot?:string}} input
 * @returns {string}
 */
export function resolveSlotId({ message, binding, slots, defaultSlot }) {
    const ids = slots.map(s => s.id);
    if (!ids.length) return DEFAULT_SLOT_ID;

    const annotated = annotatedSlot(message);
    if (annotated && ids.includes(annotated)) return annotated;

    if (binding?.activeSlot && ids.includes(binding.activeSlot)) return binding.activeSlot;
    if (defaultSlot && ids.includes(defaultSlot)) return defaultSlot;

    const bound = ids.find(id => binding?.slots?.[id]?.profileId);
    return bound ?? ids[0];
}

/**
 * 轮转到下一条声线。
 * @param {{id:string}[]} slots
 * @param {string} current
 */
export function nextSlotId(slots, current) {
    if (!slots.length) return DEFAULT_SLOT_ID;
    const index = slots.findIndex(s => s.id === current);
    return slots[(index + 1) % slots.length].id;
}

/**
 * 把旧的单声线绑定迁移成多槽位形状。
 * @param {any} raw
 */
export function normalizeBinding(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.slots && typeof raw.slots === 'object') {
        return { slots: raw.slots, activeSlot: String(raw.activeSlot ?? '') };
    }
    if (raw.profileId || raw.voice || raw.speed !== undefined) {
        return {
            slots: {
                [DEFAULT_SLOT_ID]: {
                    profileId: String(raw.profileId ?? raw.voice ?? ''),
                    speed: raw.speed,
                    textLang: raw.textLang,
                },
            },
            activeSlot: '',
        };
    }
    return null;
}

/**
 * 解析 "xiaod:小d · 柔软, demon:demon · 小恶魔"。
 * @param {string} text
 * @returns {{id:string,label:string}[]}
 */
export function parseSlotSpec(text) {
    const out = [];
    const seen = new Set();
    for (const chunk of String(text ?? '').split(/[,，;；\n]/)) {
        const piece = chunk.trim();
        if (!piece) continue;
        const [rawId, ...rest] = piece.split(/[:：]/);
        const id = rawId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: rest.join(':').trim() || id });
    }
    return out;
}

/* ------------------------------------------------------------ 音色档案 */

/**
 * 音色档案（GPT-SoVITS 的一次"声音"= 两套权重 + 一段参考音频 + 它的文本）
 * @typedef {object} VoiceProfile
 * @property {string} id
 * @property {string} name
 * @property {string} gptWeights   GPT 权重路径（服务器上的路径）
 * @property {string} sovitsWeights SoVITS 权重路径
 * @property {string} refAudio     参考音频路径
 * @property {string} promptText  参考音频的文本
 * @property {string} promptLang   参考音频语言
 */

export const PROFILE_DEFAULTS = Object.freeze({
    id: '',
    name: '',
    gptWeights: '',
    sovitsWeights: '',
    refAudio: '',
    promptText: '',
    promptLang: DEFAULT_PROMPT_LANG,
});

/**
 * 归一化一个档案并给出缺什么。
 * @param {any} raw
 * @returns {{profile: VoiceProfile, missing: string[]}}
 */
export function normalizeProfile(raw) {
    const p = { ...PROFILE_DEFAULTS };
    for (const key of Object.keys(PROFILE_DEFAULTS)) {
        if (raw && raw[key] !== undefined && raw[key] !== null) p[key] = String(raw[key]).trim();
    }
    if (!p.promptLang) p.promptLang = DEFAULT_PROMPT_LANG;

    const missing = [];
    // Demon 模式下权重/参考音频由 Demon 管理，插件只要求有名字
    if (!p.name && !p.id) missing.push('名称');
    // promptText 允许为空（GPT-SoVITS 可只用参考音频），但为空会明显掉质量
    return { profile: p, missing };
}

/**
 * 判断两次合成是不是同一套权重（决定要不要发 /set_*_weights）。
 * @param {VoiceProfile|null} a
 * @param {VoiceProfile|null} b
 */
export function sameWeights(a, b) {
    if (!a || !b) return false;
    return a.gptWeights === b.gptWeights && a.sovitsWeights === b.sovitsWeights;
}

/**
 * 缓存键：同一档案 + 同一语言 + 同一语速 + 同一文本才算命中。
 * @param {VoiceProfile} profile
 * @param {{text:string, textLang:string, speed:number}} req
 */
export function cacheKey(profile, req) {
    // Demon 模式下权重/参考音频不在插件里，用 profile.id 区分声线
    return [profile.id, profile.name, req.textLang, req.speed, req.text].join('\u0001');
}

/**
 * 找一个档案：先按 id，再按名字。
 * @param {VoiceProfile[]} profiles
 * @param {string} idOrName
 */
export function findProfile(profiles, idOrName) {
    if (!idOrName) return null;
    const key = String(idOrName).trim();
    return profiles.find(p => p.id === key) || profiles.find(p => p.name === key) || null;
}

/**
 * 生成一个稳定的档案 id（名字 + 时间戳后缀由调用方决定）。
 * @param {string} seed
 */
export function slugId(seed) {
    const base = String(seed ?? '').trim().toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    return base || 'profile';
}

/**
 * 0.5~2.0 的语速（GPT-SoVITS 的 speed_factor，1 = 原速）
 * @param {any} value
 * @param {number} [fallback=1]
 */
export function clampSpeed(value, fallback = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(2, Math.max(0.5, n));
}

/**
 * 采样参数兜底。
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
export function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
