'use strict';
/**
 * REMKO Smart-Web protocol helpers.
 *
 * The Smart-Control (firmware 4.26+) runs an MQTT broker (TCP 1883 / WebSocket 9001).
 *   <prefix>/HOST2CLIENT   heat pump -> clients  {"values":{"1082":"01C2",...},"CLIENT_ID":...}
 *   <prefix>/CLIENT2HOST   clients -> heat pump  {"FORCE_RESPONSE":true,"query_list":[...],"values":{...}}
 * Values are big-endian hex strings. The register database (types, ranges, decimals, texts)
 * is served by the web UI itself: /json/smt18.json + /json/smtmain.json.
 */

const LANGS = ['de', 'en'];

/**
 * Extract MQTT credentials + firmware version from the web UI's smt.min.js
 *
 * @param js content of smt.min.js
 */
function parseSmtJs(js) {
    const pw = js.match(/MQTT_USERNAME\s*=\s*["'](0{16})["']\s*,\s*global\.MQTT_PASSWORD\s*=\s*["']([^"']+)["']/);
    const ver = js.match(/SMT_VERSION\s*=\s*["'](\d+)\.(\d+)["']/);
    return {
        username: pw ? pw[1] : null,
        password: pw ? pw[2] : null,
        version: ver ? `${ver[1]}.${ver[2]}` : null,
        topicPrefix: ver ? `V${ver[1].padStart(2, '0')}P${ver[2].padStart(2, '0')}/SMTID` : null,
    };
}

/**
 * Build a compact register database from the two JSON files of the web UI.
 *
 * @param smt18 parsed /json/smt18.json
 * @param smtmain parsed /json/smtmain.json
 * @returns {{regs: Record<string, object>, menus: Record<string, object>}} register database
 */
function buildRegisterDb(smt18, smtmain) {
    const regs = {};
    const unitOf = td => {
        const u = smtmain.unit && smtmain.unit[td];
        return Array.isArray(u) ? u[0] || '' : '';
    };
    for (const code of Object.keys(smt18.typedef || {})) {
        if (Number(code) < 1000) {
            continue;
        } // < 1000 are menu ids
        const td = smt18.typedef[code];
        const text = (smt18.text && smt18.text[code]) || {};
        const enumDef = smtmain.typedef_list && smtmain.typedef_list[td];
        let states = null;
        const src = enumDef && (enumDef.de || enumDef.en);
        if (src && typeof src === 'object') {
            states = {};
            for (const [k, v] of Object.entries(src)) {
                states[k] = v;
            }
        }
        regs[code] = {
            code: Number(code),
            typedef: td,
            min: num(smt18.rangemin[code]),
            max: num(smt18.rangemax[code]),
            step: num(smt18.step[code]) || 1,
            decimals: num(smt18.decimals[code]) || 0,
            signed: !!num(smt18.issigned[code]),
            bytes: num(smt18.bytecount[code]) || 1,
            elements: num(smt18.elemcount[code]) || 1,
            name: {
                de: (text.de || '').trim() || `Register ${code}`,
                en: (text.en || '').trim() || `Register ${code}`,
            },
            unit: unitOf(td),
            states,
            cond: condOf(smt18, code),
        };
    }
    const menus = {};
    for (const id of Object.keys(smt18.display_list || {})) {
        const t = (smt18.text && smt18.text[id]) || {};
        menus[id] = { name: t.de || t.en || null, children: smt18.display_list[id] || [], cond: condOf(smt18, id) };
    }
    return { regs, menus };
}

function condOf(smt18, id) {
    const dc = smt18.display_condition;
    const c = dc && dc[id];
    return c === undefined || c === null ? '1' : String(c).trim() || '1';
}

/**
 * raw integer as used by the web UI's display conditions (signed, not scaled)
 *
 * @param reg register definition
 * @param hex value as big-endian hex string
 */
function rawInt(reg, hex) {
    if (typeof hex !== 'string' || !reg || !isScalar(reg)) {
        return NaN;
    }
    let n = parseInt(hex, 16);
    const bits = hex.length * 4;
    if (reg.signed && bits <= 32 && n >= 2 ** (bits - 1)) {
        n -= 2 ** bits;
    }
    return n;
}

/**
 * Evaluate a display condition like "ID(1952)==1&&ID(5998)!=5" against raw values
 *
 * @param cond display condition expression
 * @param raw raw register values by code
 */
function evalCond(cond, raw) {
    if (cond === '1' || cond === undefined) {
        return true;
    }
    if (cond === '0') {
        return false;
    }
    const expr = String(cond).replace(/ID\((\d+)\)/g, (m, c) => {
        const v = raw[c];
        return Number.isFinite(v) ? `(${v})` : 'NaN';
    });
    if (!/^[\sNaN\d().<>=!&|+-]*$/.test(expr)) {
        return true;
    } // unknown syntax: rather show than hide
    try {
        return !!Function(`"use strict";return (${expr});`)();
    } catch {
        return true;
    }
}

/**
 * All register codes referenced by any display condition
 *
 * @param db register database
 */
function conditionCodes(db) {
    const out = new Set();
    const add = c => {
        for (const m of String(c || '').matchAll(/ID\((\d+)\)/g)) {
            out.add(Number(m[1]));
        }
    };
    Object.values(db.regs).forEach(r => add(r.cond));
    Object.values(db.menus).forEach(m => add(m.cond));
    return [...out].filter(c => db.regs[c]);
}

// top level menus in priority order; the first visible path wins
const TOP_MENUS = [
    { id: 9, skip: true }, // Benutzer -> information.*, einstellungen.*, meldungen
    { id: 405, id2: 'status' },
    { id: 3, skip: true }, // Grundanzeige -> uebersicht.*, homescreen.*
    { id: 10, id2: 'service' },
    { id: 11, id2: 'experte' },
    { id: 4, id2: 'inbetriebnahme' },
];

/**
 * Convert a menu name into an ioBroker id segment
 *
 * @param s text to convert
 */
function slug(s) {
    return (
        String(s || '')
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/₂/g, '2')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'x'
    );
}

/**
 * Work out which registers the web UI would show and where (menu path).
 *
 * @param db register database
 * @param raw raw register values by code
 * @param opts options (tops, all, always)
 * @returns {Map<number, {path: {id: string, name: string}[]}>}  code -> folder path (max 2 levels)
 */
function layout(db, raw, opts = {}) {
    const { regs, menus } = db;
    const result = new Map();
    const visibleMenu = id => menus[id] && evalCond(menus[id].cond, raw);
    for (const top of TOP_MENUS.filter(t => !opts.tops || opts.tops.includes(t.id))) {
        const root = menus[top.id];
        if (!root) {
            continue;
        }
        // BFS over visible menus, remembering the path (names of max. 2 levels)
        const queue = [{ id: String(top.id), path: top.skip ? [] : [{ id: top.id2, name: root.name }] }];
        const seen = new Set([String(top.id)]);
        while (queue.length) {
            const { id, path } = queue.shift();
            for (const c of menus[id].children) {
                const k = String(c);
                if (menus[k]) {
                    if (seen.has(k) || !visibleMenu(k)) {
                        continue;
                    }
                    seen.add(k);
                    const next = path.length < 2 ? [...path, { id: slug(menus[k].name), name: menus[k].name }] : path;
                    queue.push({ id: k, path: next });
                } else if (regs[k] && !result.has(Number(k))) {
                    if (!opts.all && !evalCond(regs[k].cond, raw)) {
                        continue;
                    }
                    result.set(Number(k), { path: path.length ? path : [{ id: 'allgemein', name: 'Allgemein' }] });
                }
            }
        }
    }
    // always keep explicitly wanted registers (e.g. actions without own menu entry)
    for (const c of opts.always || []) {
        if (regs[c] && !result.has(c)) {
            result.set(c, { path: [{ id: 'uebersicht', name: 'Übersicht' }] });
        }
    }
    if (opts.all) {
        for (const c of Object.keys(regs).map(Number)) {
            if (!result.has(c)) {
                result.set(c, { path: [{ id: 'weitere', name: 'Weitere' }] });
            }
        }
    }
    return result;
}

function num(v) {
    if (v === null || v === undefined || v === '') {
        return 0;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * All register codes reachable below the given menu ids
 *
 * @param menus menu definitions
 * @param regs register definitions
 * @param rootIds menu ids to start from
 */
function registersBelow(menus, regs, rootIds) {
    const out = new Set();
    const seen = new Set();
    const walk = id => {
        const m = menus[String(id)];
        if (!m) {
            return;
        }
        for (const c of m.children) {
            const k = String(c);
            if (menus[k] && !seen.has(k)) {
                seen.add(k);
                walk(k);
            } else if (regs[k]) {
                out.add(Number(k));
            }
        }
    };
    rootIds.forEach(walk);
    return out;
}

/**
 * Is this a plain numeric register (vs. array / time program / hash)?
 *
 * @param reg register definition
 */
function isScalar(reg) {
    return reg.elements === 1 && reg.bytes <= 4;
}

/**
 * hex string -> JS value (number, or raw hex for arrays / 8-byte types)
 *
 * @param reg register definition
 * @param hex value as big-endian hex string
 */
function decode(reg, hex) {
    if (typeof hex !== 'string') {
        return null;
    }
    if (reg && reg.typedef === 'action_t') {
        return parseInt(hex, 16) > 0;
    }
    if (!reg || !isScalar(reg)) {
        return hex;
    }
    let n = parseInt(hex, 16);
    if (!Number.isFinite(n)) {
        return null;
    }
    const bits = hex.length * 4;
    if (reg.signed && bits <= 32 && n >= 2 ** (bits - 1)) {
        n -= 2 ** bits;
    }
    if (reg.states) {
        return n;
    } // enum: keep raw index, text in common.states
    return reg.decimals ? Math.round(n) / 10 ** reg.decimals : n;
}

/**
 * JS value -> hex string for writing, with range check (throws on invalid value)
 *
 * @param reg register definition
 * @param value value to write
 */
function encode(reg, value) {
    if (!isScalar(reg)) {
        if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value)) {
            throw new Error('raw hex string expected');
        }
        return value.toUpperCase();
    }
    if (typeof value === 'boolean') {
        value = value ? 1 : 0;
    }
    const v = Number(value);
    if (!Number.isFinite(v)) {
        throw new Error(`not a number: ${value}`);
    }
    const raw = reg.states ? Math.round(v) : Math.round(v * 10 ** reg.decimals);
    if (reg.max > reg.min && (raw < reg.min || raw > reg.max)) {
        throw new Error(`value ${value} out of range ${scaled(reg, reg.min)}..${scaled(reg, reg.max)}`);
    }
    const bits = reg.bytes * 8;
    const u = raw < 0 ? 2 ** bits + raw : raw;
    return u
        .toString(16)
        .toUpperCase()
        .padStart(reg.bytes * 2, '0');
}

function scaled(reg, raw) {
    return reg.states ? raw : raw / 10 ** reg.decimals;
}

/**
 * ioBroker common object for a register
 *
 * @param reg register definition
 * @param writable whether the state may be written
 */
function commonFor(reg, writable) {
    if (reg.typedef === 'action_t') {
        return { name: reg.name, type: 'boolean', role: 'button', read: true, write: !!writable, def: false };
    }
    const scalar = isScalar(reg);
    const common = {
        name: reg.name,
        type: scalar ? 'number' : 'string',
        role: scalar ? roleFor(reg, writable) : 'text',
        read: true,
        write: !!writable,
    };
    if (scalar) {
        if (reg.unit && !reg.states) {
            common.unit = reg.unit;
        }
        if (reg.states) {
            common.states = reg.states;
        }
        if (reg.max > reg.min && reg.max < 2 ** 31) {
            common.min = scaled(reg, reg.min);
            common.max = scaled(reg, reg.max);
        }
        if (writable && !reg.states) {
            common.step = scaled(reg, reg.step || 1) || 1;
        }
    }
    return common;
}

function roleFor(reg, writable) {
    const td = reg.typedef || '';
    if (reg.states) {
        return writable ? 'level.mode' : 'value.mode';
    }
    if (/^temperature/.test(td)) {
        return writable ? 'level.temperature' : 'value.temperature';
    }
    if (/^k?W$/.test(reg.unit || '')) {
        return 'value.power';
    }
    if (/^energy/i.test(td)) {
        return 'value.energy';
    }
    return writable ? 'level' : 'value';
}

module.exports = {
    LANGS,
    parseSmtJs,
    buildRegisterDb,
    registersBelow,
    isScalar,
    decode,
    encode,
    commonFor,
    rawInt,
    evalCond,
    conditionCodes,
    layout,
    slug,
};
