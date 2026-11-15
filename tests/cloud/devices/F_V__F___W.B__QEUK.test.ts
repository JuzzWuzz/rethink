import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V__F___W.B__QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const ID = 'test-id'
const meta: Metadata = { modelId: 'F_V__F___W.B__QEUK', modelName: 'LG Washer', swVersion: '0.0.0' }

// Actual monitor frames: TurboWash start, countdown, final spin, and after opening the door.
const start = buf(
    'aaff200a006000b834000100ec004e00000100270027310003090201000000010000000100002a00430000010000000000000000000000000600270027310003090201000000010220000101002a00430000010000000000000000000030a9bb',
)
const countdown = buf(
    'aaff200a006000b851000100ec004e00000600270027310003090201000000014220000101002a00430000010000000000000000000000000600260027310003090201000000014220000101002a004300000100000000000000000000c6e5bb',
)
const spin = buf(
    'aaff200a006000bbc1000100ec004e00000800040027310000090000000000004200000107002a004300000100003d0000000000400000000800040027310000090000000000004200000107002a004300000100003d000000000000008a74bb',
)
const off = buf(
    'aaff200a006000bc36000100ec004e0000000000002731000000000000000000000000010a002a004300000100004b000000000040000000000000002731000000000000000000000000010a002a004300000100004b00000000000000815bbb',
)

function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    const update = (frame: Buffer) => {
        thinq.emit('data', frame)
        return { ...ha.devices[ID].properties }
    }
    return { ha, thinq, dev, update }
}

test('reads the current record rather than the previous record and hides idle preset timers', () => {
    const { update, dev, ha } = setup()
    // The previous record in the Start frame is the real idle 39-minute preset.
    dev.processStatus(start.subarray(15, 54))
    assert.equal(ha.devices[ID].properties.status, 'Standby')
    assert.equal(ha.devices[ID].properties.remaining_time, 'None')
    const running = update(start)
    assert.equal(running.course, 'TurboWash 39')
    assert.equal(running.temp, '20 °C')
    assert.equal(running.status, 'Washing')
    assert.equal(running.initial_time, 39)
    assert.equal(running.remaining_time, 39)
    const next = update(countdown)
    assert.equal(next.remaining_time, 38)
    assert.equal(next.initial_time, 39)
    assert.equal(next.door_lock, 'OFF')
})

test('keeps completion and unlocking separate, and drops stale course and times when off', () => {
    const { update, dev, ha } = setup()
    const spinning = update(spin)
    assert.equal(spinning.status, 'Spinning')
    assert.equal(spinning.remaining_time, 4)
    // Synthetic isolated transitions from the observed End and unlock byte changes.
    const record = Buffer.from(spin.subarray(54, 93))
    record[2] = 0x0a
    record[4] = 0
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.status, 'End')
    assert.equal(ha.devices[ID].properties.remaining_time, 0)
    assert.equal(ha.devices[ID].properties.door_lock, 'OFF')
    record[17] = 0
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.door_lock, 'ON')
    const poweredOff = update(off)
    assert.equal(poweredOff.status, 'Off')
    assert.equal(poweredOff.course, 'None')
    assert.equal(poweredOff.remaining_time, 'None')
})

test('acknowledges a real status envelope without exposing or issuing appliance commands', () => {
    const { ha, thinq, update } = setup()
    update(start)
    assert.equal(thinq.sent.filter(({ cmd }) => cmd === 'ack').length, 1)
    assert.equal(thinq.outbox.length, 0)
    assert.equal(
        Object.values(ha.devices[ID].config!.components).some((c) => 'command_topic' in c),
        false,
    )
})

test('Cotton+ uses its model-specific name and ignores an unverified Download code', () => {
    const { dev, ha } = setup()
    const record = Buffer.from(start.subarray(15, 54))
    record[7] = 1
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    record[7] = 4
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton+')
    record[7] = 0xff
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'None')
})
