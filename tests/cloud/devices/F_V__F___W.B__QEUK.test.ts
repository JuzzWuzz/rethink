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
// Next load at 10:49:46 SAST, with SmartThinQ reporting 1200 rpm and 43 cycles.
const nextLoad = buf(
    'aaff200a006000c02d000100ec004e00000600230027310003090201000000014220000101002b00430000010000030000000000000000000600230027310003090201000000014220000101002b0043000001000004000000000000006606bb',
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
    assert.equal(spinning.run_completed, 'OFF')
    // Synthetic isolated transitions from the observed End and unlock byte changes.
    const record = Buffer.from(spin.subarray(54, 93))
    record[2] = 0x0a
    record[4] = 0
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.status, 'End')
    assert.equal(ha.devices[ID].properties.run_completed, 'ON')
    assert.equal(ha.devices[ID].properties.remaining_time, 0)
    assert.equal(ha.devices[ID].properties.door_lock, 'OFF')
    record[17] = 0
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.door_lock, 'ON')
    assert.equal(ha.devices[ID].properties.run_completed, 'ON')
    const poweredOff = update(off)
    assert.equal(poweredOff.status, 'Off')
    assert.equal(poweredOff.course, 'None')
    assert.equal(poweredOff.remaining_time, 'None')
    assert.equal(poweredOff.run_completed, 'ON')
    dev.processStatus(start.subarray(15, 54))
    assert.equal(ha.devices[ID].properties.status, 'Standby')
    assert.equal(ha.devices[ID].properties.run_completed, 'OFF')
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

test('recognized programmes use their model-specific names and leave an unverified Download code unknown', () => {
    const { dev, ha } = setup()
    const record = Buffer.from(start.subarray(15, 54))
    record[7] = 1
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    record[7] = 4
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton+')
    record[7] = 0x12
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Tub Clean')
    record[7] = 0xff
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'None')
})

test('exposes selected water temperature and spin speed, and the tub clean counter', () => {
    const { ha, update } = setup()
    const running = update(nextLoad)
    assert.equal(running.temp, '20 °C')
    assert.equal(running.spin, '1200 rpm')
    assert.equal(running.tub_clean_count, 43)
    const previousLoad = update(off)
    assert.equal(previousLoad.spin, 'None')
    assert.equal(previousLoad.tub_clean_count, 42)
    const components = ha.devices[ID].config!.components
    assert.ok('name' in components.temp && 'unique_id' in components.temp)
    assert.ok('name' in components.spin)
    assert.ok('name' in components.tub_clean_count)
    assert.equal(components.temp.name, 'Water Temperature')
    assert.equal(components.temp.unique_id, '$deviceid-temp')
    assert.equal(components.spin.name, 'Spin Speed')
    assert.equal(components.tub_clean_count.name, 'Tub Clean Counter')
    assert.equal('state_class' in components.tub_clean_count, false)
})

test('distinguishes no spin, unselected and unknown, and accepts a reset counter', () => {
    const { dev, ha } = setup()
    const record = Buffer.from(start.subarray(15, 54))
    record[23] = 0 // A reset is a zero reading, not missing telemetry.
    for (const [value, expected] of [
        [0, 'Not selected'],
        [1, 'No spin'],
        [0xfe, 'None'],
    ] as const) {
        record[10] = value
        dev.processStatus(record)
        assert.equal(ha.devices[ID].properties.spin, expected)
        assert.equal(ha.devices[ID].properties.tub_clean_count, 0)
    }
})

test('completion requires a live active cycle and resets on a new run even if standby is missed', () => {
    const { ha, dev, update } = setup()
    const record = Buffer.from(spin.subarray(54, 93))
    record[2] = 0x0a
    record[4] = 0
    // Initial or repeated End snapshots after restart are not new completions.
    dev.processStatus(record)
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.run_completed, 'OFF')
    update(spin)
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.run_completed, 'ON')
    assert.equal(update(off).run_completed, 'ON')
    assert.equal(update(start).run_completed, 'OFF')
})

test('does not treat power-off during an active cycle as completion', () => {
    const { dev, ha, update } = setup()
    update(spin)
    assert.equal(update(off).run_completed, 'OFF')
    const record = Buffer.from(spin.subarray(54, 93))
    record[2] = 0x0a
    record[4] = 0
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.run_completed, 'OFF')
})

test('child lock is independent of the door lock', () => {
    const { dev, ha } = setup()
    const record = Buffer.from(start.subarray(15, 54))
    record[7] = 0x01 // Cotton
    // Isolate the 0x80 change seen on the washer and in the cloud while in Standby.
    for (const [flags, child, door] of [
        [0x00, 'OFF', 'ON'],
        [0x80, 'ON', 'ON'],
        [0x00, 'OFF', 'ON'],
        [0xc0, 'ON', 'OFF'],
        [0x40, 'OFF', 'OFF'],
    ] as const) {
        record[17] = flags
        dev.processStatus(record)
        assert.equal(ha.devices[ID].properties.child_lock, child)
        assert.equal(ha.devices[ID].properties.door_lock, door)
    }
})
