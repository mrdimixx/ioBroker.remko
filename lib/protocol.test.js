'use strict';

const { expect } = require('chai');
const P = require('./protocol');

// Minimal synthetic excerpt of the web UI's smt18.json / smtmain.json
const smt18 = {
    typedef: {
        1082: 'temperature_t',
        1079: 'DHWopmode_t',
        1137: 'status_t',
        1952: 'status_t',
        5019: 'temperature_t',
        5032: 'temperature_t',
        5039: 'temperature_t',
        5693: 'action_t',
        5911: 'powerfactorHP_t',
        5359: 'power_t',
    },
    rangemin: { 1082: 400, 1079: 0, 1137: 0, 1952: 0, 5019: -500, 5032: -500, 5039: -500, 5693: 0, 5911: 0, 5359: 0 },
    rangemax: {
        1082: 600,
        1079: 3,
        1137: 1,
        1952: 1,
        5019: 3000,
        5032: 1000,
        5039: 1000,
        5693: 1,
        5911: 200,
        5359: 9990,
    },
    step: { 1082: 5, 1079: 1, 1137: 1, 1952: 1, 5019: 1, 5032: 1, 5039: 1, 5693: 1, 5911: 1, 5359: 1 },
    decimals: { 1082: 1, 1079: 0, 1137: 0, 1952: 0, 5019: 1, 5032: 1, 5039: 1, 5693: 0, 5911: 1, 5359: 1 },
    issigned: { 1082: 1, 1079: 0, 1137: 1, 1952: 1, 5019: 1, 5032: 1, 5039: 1, 5693: 1, 5911: 0, 5359: 0 },
    bytecount: { 1082: 2, 1079: 1, 1137: 1, 1952: 1, 5019: 2, 5032: 2, 5039: 2, 5693: 1, 5911: 1, 5359: 2 },
    elemcount: { 1082: 1, 1079: 1, 1137: 1, 1952: 1, 5019: 1, 5032: 1, 5039: 1, 5693: 1, 5911: 1, 5359: 1 },
    text: {
        1082: { de: 'WW Soll-Temp.', en: 'Storage tank setpoint' },
        1079: { de: 'Modus', en: 'Mode' },
        5039: { de: 'Warmwasser Ist-Temp.', en: 'DHW temp.' },
        5019: { de: 'Kollektor Temp.', en: 'Collector temp.' },
        9: { de: 'Benutzer' },
        28: { de: 'Einstellungen' },
        29: { de: 'Information' },
        171: { de: 'Warmwasser' },
        317: { de: 'Warmwasser' },
        304: { de: 'Solar' },
    },
    display_list: { 1: [9], 9: [29, 28], 29: [317, 304], 28: [171], 317: [5039], 304: [5019], 171: [1082, 1079] },
    display_condition: {
        1: '0',
        9: '1',
        28: '1',
        29: '1',
        317: 'ID(1137)==1',
        304: 'ID(1952)==1',
        171: 'ID(1137)==1||ID(1144)>0',
        5693: '0',
    },
};
const smtmain = {
    unit: { temperature_t: ['°C', '°F'], power_t: ['kW'], powerfactorHP_t: ['W / W'] },
    typedef_list: {
        DHWopmode_t: { de: { 0: 'Automatik Komfort', 1: 'Automatik Eco', 2: 'nur Solar / PV', 3: 'Aus' } },
        action_t: { de: { 0: 'ausführen', 1: 'ausführen' } },
    },
};

describe('protocol', () => {
    const db = P.buildRegisterDb(smt18, smtmain);
    const R = db.regs;

    it('parses smt.min.js', () => {
        const js =
            'global.SMT_VERSION=\'4.28\';global.MQTT_USERNAME="0000000000000000",global.MQTT_PASSWORD="TESTPASSWORD1234"';
        expect(P.parseSmtJs(js)).to.deep.equal({
            username: '0000000000000000',
            password: 'TESTPASSWORD1234',
            version: '4.28',
            topicPrefix: 'V04P28/SMTID',
        });
    });

    it('decodes values', () => {
        expect(P.decode(R[1082], '01C2')).to.equal(45);
        expect(P.decode(R[5032], 'FF9C')).to.equal(-10);
        expect(P.decode(R[1079], '01')).to.equal(1);
        expect(P.decode(R[5693], '00')).to.equal(false);
        expect(R[1079].states['2']).to.equal('nur Solar / PV');
    });

    it('encodes values with range check', () => {
        expect(P.encode(R[1082], 50)).to.equal('01F4');
        expect(P.encode(R[1082], 47.5)).to.equal('01DB');
        expect(P.encode(R[1079], 3)).to.equal('03');
        expect(P.encode(R[5693], true)).to.equal('01');
        expect(() => P.encode(R[1082], 70)).to.throw(/out of range/);
    });

    it('builds ioBroker common objects', () => {
        const c = P.commonFor(R[1082], true);
        expect([c.type, c.role, c.unit, c.min, c.max, c.step]).to.deep.equal([
            'number',
            'level.temperature',
            '°C',
            40,
            60,
            0.5,
        ]);
        expect(P.commonFor(R[5693], true).role).to.equal('button');
        const ro = P.commonFor(R[5039], false); // read-only values get no min/max
        expect([ro.min, ro.max]).to.deep.equal([undefined, undefined]);
        expect(P.commonFor(R[5911], false).role).to.equal('value');
        expect(P.commonFor(R[5359], false).role).to.equal('value.power');
    });

    it('evaluates display conditions', () => {
        expect(P.evalCond('ID(1137)==1', { 1137: 1 })).to.equal(true);
        expect(P.evalCond('ID(1137)==1', {})).to.equal(false);
        expect(P.evalCond('ID(1137)==1||ID(1144)>0', { 1137: 0, 1144: 2 })).to.equal(true);
        expect(P.evalCond('0', {})).to.equal(false);
        expect(P.evalCond('alert(1)', {})).to.equal(true); // unknown syntax is never executed
    });

    it('lays out visible registers like the web UI', () => {
        const L = P.layout(db, { 1137: 1, 1952: 0 }, { tops: [9], always: [5693] });
        expect(
            L.get(5039)
                .path.map(p => p.id)
                .join('.'),
        ).to.equal('information.warmwasser');
        expect(
            L.get(1082)
                .path.map(p => p.id)
                .join('.'),
        ).to.equal('einstellungen.warmwasser');
        expect(L.has(5019)).to.equal(false); // solar disabled
        expect(L.get(5693).path[0].id).to.equal('uebersicht');
    });

    it('puts fixed groups into their own folder, ahead of menu placement', () => {
        const L = P.layout(
            db,
            { 1137: 1, 1952: 0 },
            { tops: [9], groups: [{ id: 'kaeltekreis', name: 'Kältekreis', codes: [5039, 999999] }] },
        );
        expect(
            L.get(5039)
                .path.map(p => p.id)
                .join('.'),
        ).to.equal('kaeltekreis');
        expect(L.has(999999)).to.equal(false); // unknown registers are ignored
        expect(
            L.get(1082)
                .path.map(p => p.id)
                .join('.'),
        ).to.equal('einstellungen.warmwasser');
    });
});
