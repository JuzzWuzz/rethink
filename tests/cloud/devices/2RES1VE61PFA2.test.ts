import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import AABBDevice from '@/cloud/devices/aabb_device'
import DUT from '@/cloud/devices/2RES1VE61PFA2'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const ID = 'test-id'
const MODEL = '2RES1VE61PFA2'

function makeDevice() {
    const ha = new MockHAConnection()
    const meta = { modelId: MODEL, modelName: MODEL, swVersion: 'test' }
    const thinq = new MockThinq2Device(ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    dev.start()
    thinq.resetRecorder()
    return { thinq, dev, props: ha.devices[ID].properties }
}

const FRIDGE_3 =
    'aa3c10ec0206030102000600010001ffffff00ff0000ffffffffffffff02780205030102000600010001ffffff00ff0000ffffffffffffff0278bebb'
const FRIDGE_2 =
    'aa3c10ec0205030102000600010001ffffff00ff0000ffffffffffffff02780206030102000600010001ffffff00ff0000ffffffffffffff0278bebb'
const COOL_ON =
    'aa3c10ec0206030102000600010001ffffff00ff0000ffffffffffffff02780206030102000600010001ffffff00ff0100ffffffffffffff0278b8bb'
const COOL_OFF =
    'aa3c10ec0206030102000600010001ffffff00ff0100ffffffffffffff02780206030102000600010001ffffff00ff0000ffffffffffffff0278b8bb'
const FREEZE_ON =
    'aa3c10ec0206030102000600010001ffffff00ff0000ffffffffffffff02780206030202000600010001ffffff00ff0000ffffffffffffff0278b8bb'
const FREEZE_OFF =
    'aa3c10ec0206030202000600010001ffffff00ff0000ffffffffffffff02780206030102000600010001ffffff00ff0000ffffffffffffff0278b8bb'
const FREEZER_18 =
    'aa3c10ec0206030102000600010001ffffff00ff0000ffffffffffffff02780206040102000600010001ffffff00ff0000ffffffffffffff0278b8bb'

describe(MODEL, () => {
    test('captured status frames report current, not previous, settings', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', buf(FRIDGE_3))
        assert.equal(props.fridge_setpoint, 3)
        assert.equal(props.freezer_setpoint, -17)
        assert.equal(props.water_filter_age, 6)
        assert.equal(props.water_filter_replacement, 'ON')
        thinq.emit('data', buf(FRIDGE_2))
        assert.equal(props.fridge_setpoint, 2)
        thinq.emit('data', buf(COOL_ON))
        assert.equal(props.express_cool, 'ON')
        thinq.emit('data', buf(COOL_OFF))
        assert.equal(props.express_cool, 'OFF')
        thinq.emit('data', buf(FREEZE_ON))
        assert.equal(props.express_freeze, 'ON')
        thinq.emit('data', buf(FREEZE_OFF))
        assert.equal(props.express_freeze, 'OFF')
        thinq.emit('data', buf(FREEZER_18))
        assert.equal(props.freezer_setpoint, -18)
    })

    test('a fresh all-closed status initializes the two channels', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', buf('aa0810a800003fbb'))
        assert.equal(props.fridge_door, 'None')
        assert.equal(props.freezer_door, 'None')

        thinq.emit('data', buf(FRIDGE_2))
        assert.equal(props.fridge_door, 'OFF')
        assert.equal(props.freezer_door, 'OFF')

        thinq.emit('data', buf('aa0810a8010139bb'))
        thinq.emit('data', buf(FRIDGE_2))
        assert.equal(props.fridge_door, 'ON')
        assert.equal(props.freezer_door, 'OFF')
    })

    test('aggregate open and unverified values cannot initialize or overwrite channels', () => {
        const { thinq, props } = makeDevice()
        const sample = buf(FRIDGE_2).subarray(31, 58)
        for (const aggregate of [0x01, 0x02, 0xff]) {
            sample[7] = aggregate
            thinq.emit('data', AABBDevice.frame(Buffer.concat([buf('10eb'), sample])))
            assert.equal(props.fridge_door, 'None')
            assert.equal(props.freezer_door, 'None')
        }

        thinq.emit('data', buf('aa0810a8020138bb'))
        thinq.emit('data', AABBDevice.frame(Buffer.concat([buf('10eb'), sample])))
        assert.equal(props.fridge_door, 'None')
        assert.equal(props.freezer_door, 'ON')

        thinq.emit('data', buf(FRIDGE_2))
        assert.equal(props.fridge_door, 'OFF')
        assert.equal(props.freezer_door, 'ON')
    })

    test('split doors are independent and unsolicited baseline cannot clear an open door', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', buf('aa0810a8010139bb'))
        thinq.emit('data', buf('aa0810a8020138bb'))
        thinq.emit('data', buf('aa0810a800003fbb'))
        thinq.emit('data', buf(FRIDGE_2))
        assert.equal(props.fridge_door, 'ON')
        assert.equal(props.freezer_door, 'ON')
        thinq.emit('data', buf('aa0810a801003ebb'))
        assert.equal(props.fridge_door, 'OFF')
        assert.equal(props.freezer_door, 'ON')
        thinq.emit('data', buf('aa0810a8020039bb'))
        assert.equal(props.freezer_door, 'OFF')
    })

    test('commands match exact captured frames, without optimistic updates or treating an ACK as status', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', buf(FRIDGE_2))
        const cases = [
            [
                'fridge_setpoint',
                '3',
                'aa2ff017ff05ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff91bb',
            ],
            [
                'fridge_setpoint',
                '2',
                'aa2ff017ff06ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff90bb',
            ],
            [
                'freezer_setpoint',
                '-18',
                'aa2ff017ffff04ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff96bb',
            ],
            [
                'freezer_setpoint',
                '-17',
                'aa2ff017ffff03ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff97bb',
            ],
            [
                'express_cool',
                'ON',
                'aa2ff017ffffffffffffffffffffffffffffffff01ffffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
            ],
            [
                'express_cool',
                'OFF',
                'aa2ff017ffffffffffffffffffffffffffffffff00ffffffff000000ffff00ffffffff00ffffffffffffffffffe8bb',
            ],
            [
                'express_freeze',
                'ON',
                'aa2ff017ffffff02ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb',
            ],
            [
                'express_freeze',
                'OFF',
                'aa2ff017ffffff01ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
            ],
        ]
        const initial = { ...props }
        for (const [property, value, expected] of cases) {
            dev.setProperty(property, value)
            assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), expected.toUpperCase())
            thinq.emit('data', buf('aa08100017008cbb'))
            assert.deepEqual(props, initial)
        }
    })

    test('unknown filter readings remain unknown and unsupported commands send nothing', () => {
        const { thinq, dev, props } = makeDevice()
        dev.setProperty('fridge_setpoint', '3')
        const sample = buf(FRIDGE_2).subarray(31, 58)
        for (const age of [5, 12, 255, 13]) {
            sample[6] = age
            thinq.emit('data', AABBDevice.frame(Buffer.concat([buf('10eb'), sample])))
            assert.equal(props.water_filter_age, age <= 12 ? age : 'None')
            assert.equal(props.water_filter_replacement, age <= 12 ? (age >= 6 ? 'ON' : 'OFF') : 'None')
        }
        for (const [property, value] of [
            ['freezer_setpoint', '-14'],
            ['fridge_setpoint', '7.5'],
            ['fridge_setpoint', ''],
            ['express_cool', 'garbage'],
            ['water_filter_age', '0'],
        ])
            dev.setProperty(property, value)
        assert.equal(thinq.outbox.length, 0)
    })
})
