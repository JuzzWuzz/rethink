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

test('reads the panel-verified native courses', () => {
    const { dev, ha } = setup()
    const record = Buffer.alloc(39)
    record[2] = 1 // Standby
    const properties = ha.devices[ID].properties
    for (const [value, label] of [
        [0x01, 'Cotton'],
        [0x04, 'Cotton+'],
        [0x31, 'TurboWash 39'],
        [0x07, 'Mixed Fabric'],
        [0x02, 'Easy Care'],
        [0x2d, 'Allergy Care'],
        [0x0d, 'Steam Refresh'],
        [0x12, 'Tub Clean'],
        [0x13, 'Wash+Dry'],
        [0x0c, 'Speed 14'],
        [0x1b, 'Hand/Wool'],
        [0x20, 'Delicates'],
    ] as const) {
        record[7] = value
        dev.processStatus(record)
        assert.equal(properties.course, label)
    }
})

test('uses one Download Cycle label for observed selections and ignores the saved marker alone', () => {
    const { dev, ha } = setup()
    const record = Buffer.alloc(39)
    record[2] = 1 // Standby
    const properties = ha.devices[ID].properties
    for (const [course, dryMode, activeDownload, savedDownload, expected] of [
        [0x18, 0x03, 0x43, 0x43, 'Download Cycle'], // Download Dry 30
        [0x18, 0x04, 0x44, 0x44, 'Download Cycle'], // Download Dry 60
        [0x17, 0x00, 0x79, 0x79, 'Download Cycle'], // Download Drain
        [0x18, 0x04, 0x00, 0x44, 'Dry Only'], // Same 60-minute selection in native Dry Only
        [0x18, 0x03, 0x00, 0x43, 'Dry Only'],
        [0x18, 0x02, 0x00, 0x00, 'Dry Only'],
        [0x12, 0x00, 0x00, 0x79, 'Tub Clean'],
        [0x12, 0x00, 0x00, 0x44, 'Tub Clean'],
        [0x17, 0x00, 0x00, 0x79, 'None'], // Unverified native 0x17
        [0x18, 0x04, 0x43, 0x43, 'None'], // Mismatched active marker and dry selection
        [0x18, 0x04, 0xfe, 0x44, 'None'], // Unverified active marker
    ] as const) {
        record[7] = course
        record[13] = dryMode
        record[20] = dryMode === 0x03 || dryMode === 0x04 ? 0x01 : 0x00
        record[22] = activeDownload
        record[25] = savedDownload
        dev.processStatus(record)
        assert.equal(properties.course, expected)
    }
    const discovery = ha.devices[ID].config!.components.course
    const options = 'options' in discovery ? discovery.options : undefined
    assert.ok(Array.isArray(options))
    assert.deepEqual(
        options.filter((option: unknown) => typeof option === 'string' && option.startsWith('Download')),
        ['Download Cycle'],
    )
})

test('publishes the verified dry selections and only the Standby Delay End setting, not a countdown', () => {
    const { dev, ha } = setup()
    const record = Buffer.alloc(39)
    record[2] = 1
    record[7] = 0x18
    const properties = ha.devices[ID].properties
    for (const [mode, expected] of [
        [0x02, 'Normal'],
        [0x03, '30 min'],
        [0x04, '60 min'],
        [0x06, '120 min'],
        [0x0a, 'Iron Dry'],
        [0x0b, 'Low Temperature'],
        [0x0c, 'Normal Eco'],
        [0xfe, 'None'],
    ] as const) {
        record[13] = mode
        dev.processStatus(record)
        assert.equal(properties.drying_mode, expected)
    }
    record[7] = 1 // Cotton
    for (const selection of [0, ...Array.from({ length: 17 }, (_, i) => i + 3), 1, 2, 20, 0xff]) {
        record[14] = selection
        dev.processStatus(record)
        assert.equal(
            properties.delay_end_setting,
            selection === 0 || (selection >= 3 && selection <= 19) ? selection : 'None',
        )
        assert.equal(properties.remaining_time, 'None')
    }
    record[14] = 3
    record[2] = 0x12 // Error, not a Standby selection
    dev.processStatus(record)
    assert.equal(properties.delay_end_setting, 'None')
    assert.equal(properties.remaining_time, 'None')
    record[2] = 0
    record[13] = 2
    dev.processStatus(record)
    assert.equal(properties.drying_mode, 'None')
})

test('reports panel Remote Start separately from the lock and decodes the observed dE1 error', () => {
    const { dev, ha } = setup()
    const record = Buffer.alloc(39)
    record[2] = 1
    const properties = ha.devices[ID].properties
    for (const [flags, armed, lock] of [
        [0x00, 'OFF', 'ON'],
        [0x02, 'ON', 'ON'],
        [0x42, 'ON', 'OFF'],
        [0x40, 'OFF', 'OFF'],
        [0x00, 'OFF', 'ON'],
    ] as const) {
        record[17] = flags
        dev.processStatus(record)
        assert.equal(properties.remote_start, armed)
        assert.equal(properties.door_lock, lock)
    }
    record[2] = 0x12
    record[8] = 0x02
    dev.processStatus(record)
    assert.equal(properties.status, 'Error')
    assert.equal(properties.error, 'ON')
    assert.equal(properties.error_message, 'Door open error (dE1)')
    record[8] = 0xfe
    dev.processStatus(record)
    assert.equal(properties.error, 'ON')
    assert.equal(properties.error_message, 'None')
    record[2] = 1
    record[8] = 0
    dev.processStatus(record)
    assert.equal(properties.status, 'Standby')
    assert.equal(properties.error, 'OFF')
    assert.equal(properties.error_message, 'OK')
})

// Wrapped EC captures from the exact model's physical panel tests.
const spinOnlySelected = buf(
    'aaff200a0060009502000100ec004e000001000b000b0100000700000000000000000001000002004300000000001400000000000000000001000c000c0100000900000000000000000001000002004300000000001400000000000000e6a6bb',
)
const spinOnlyStarted = buf(
    'aaff200a006000950c000100ec004e000001000c000c0100000900000000000000000001000002004300000000001400000000000000000008000c000c01000009000000000000022000010100020043000000000001000000000000009675bb',
)
const spinOnlyEnd = buf(
    'aaff200a0060009610000100ec004e0000080001000c010000090000000000004200000101000200430000000000170000000000000000000a0000000c0100000000000000000040000001080002004300000000001700000000008000a491bb',
)
const spinOnlyOff = buf(
    'aaff200a006000961d000100ec004e00000a0000000c01000000000000000000000000010800020043000000000017000000000000000000000000000c01000000000000000000000000010a0002004300000000001700000000000000b236bb',
)
const mixedDelayPreset = buf(
    'aaff200a006000968f000100ec004e00000101210121070003070402000300000001000200000200430000040000000000000000000000000101210121070003070402000300000001000200000200430000040000000000000000c0007c51bb',
)
const mixedDelayDetecting = buf(
    'aaff200a0060009697000100ec004e0000010121012107000307040200030000000100020000020043000004000000000000000040000000040121012107000307040200030000022100010100020043000004000000000000000000006e1fbb',
)
const mixedDelayWaiting = buf(
    'aaff200a00600096ab000100ec004e000004012101210700030704020003000042210001010002004300000400000000000000004000000003011d011d0700030704020003000042210001040002004300000400000000000000000000c2efbb',
)
const mixedDelayTick = buf(
    'aaff200a00600096c0000100ec004e000003011d011d0700030704020003000042210001040002004300000400000000000000000000000003011d011d07000307040200023b0042210001040002004300000400000000000000004000149fbb',
)
const mixedDelayToWash = buf(
    'aaff200a0060009cc6000100ec004e000003011d011d0700030704020001360042210001040002004300000400000b00000000000000000006011d011d0700030704020000000042210001030002004300000400000b000000000000007b04bb',
)
const handWoolEnd = buf(
    'aaff200a00600094f2000100ec004e00000a000000241b0000000000000000000000000108000100430000030000140000000000000000000a000000241b00000000000000000000000001080001004300000300001400000000004000fda8bb',
)

test('distinguishes manual Spin Only from Cotton and never infers it from the power-on placeholder', () => {
    const { update, dev, ha } = setup()
    const spinning = update(spinOnlyStarted)
    assert.equal(update(spinOnlySelected).course, 'Spin Only')
    assert.equal(update(spinOnlySelected).remaining_time, 'None')
    assert.equal(spinning.status, 'Spinning')
    assert.equal(spinning.course, 'Spin Only')
    assert.equal(spinning.spin, '1200 rpm')
    assert.equal(spinning.remaining_time, 12)
    assert.equal(spinning.previous_status, 'Standby')
    const record = Buffer.from(spinOnlyStarted.subarray(54, 93))
    record[21] = 7 // Ordinary mid-cycle Cotton spin followed rinsing, not standby.
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    record[2] = 1
    record[11] = 0x01 // Cotton Cold is a selected temperature, distinct from unset.
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    record[11] = 0
    record[10] = 0
    dev.processStatus(record)
    assert.notEqual(ha.devices[ID].properties.course, 'Spin Only')
    record[7] = 0 // Power-on before a programme or spin selection.
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.course, 'None')
})

test('retains Spin Only only after verifying the run, then resumes normal Cotton classification', () => {
    const { update, dev, ha } = setup()
    assert.equal(update(spinOnlyEnd).course, 'None') // Reconnected at End; cannot name the run.
    assert.equal(update(spinOnlyStarted).course, 'Spin Only')
    const end = update(spinOnlyEnd)
    assert.equal(end.course, 'Spin Only')
    assert.equal(end.status, 'End')
    assert.equal(end.remaining_time, 0)
    assert.equal(end.initial_time, 12)
    assert.equal(end.run_completed, 'ON')
    assert.equal(update(spinOnlyEnd).course, 'Spin Only')
    assert.equal(update(spinOnlyOff).course, 'None')
    const cotton = Buffer.from(spinOnlyStarted.subarray(54, 93))
    cotton[2] = 6
    cotton[11] = 4
    cotton[12] = 1
    dev.processStatus(cotton)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    cotton[2] = 8
    cotton[21] = 7
    cotton[11] = 0
    cotton[12] = 0
    dev.processStatus(cotton)
    assert.equal(ha.devices[ID].properties.course, 'Cotton')
    assert.equal(update(spinOnlyEnd).course, 'Cotton') // Same ambiguous bytes, now with known run history.
    assert.equal(update(spinOnlyEnd).course, 'Cotton')
})

test('replays the wrapped Delay End sequence and keeps all three timers separate', () => {
    const { update, dev, ha } = setup()
    const preset = update(mixedDelayPreset)
    assert.equal(preset.delay_end_setting, 3)
    assert.equal(preset.delay_end_countdown, 'None')
    assert.equal(preset.remaining_time, 'None')
    assert.equal(preset.rinse_mode, 'Rinse+')

    const detecting = update(mixedDelayDetecting)
    assert.equal(detecting.status, 'Detecting Load Level')
    assert.equal(detecting.delay_end_countdown, 'None')
    assert.equal(detecting.delay_end_setting, 'None')

    const waiting = update(mixedDelayWaiting)
    assert.equal(waiting.course, 'Mixed Fabric')
    assert.equal(waiting.status, 'Delay Set')
    assert.equal(waiting.previous_status, 'Detecting Load Level')
    assert.equal(waiting.delay_end_countdown, 180)
    assert.equal(waiting.delay_end_setting, 'None')
    assert.equal(waiting.initial_time, 89)
    assert.equal(waiting.remaining_time, 89)
    assert.equal(waiting.rinse_mode, 'Rinse+')
    assert.equal(waiting.run_completed, 'OFF')

    const tick = update(mixedDelayTick)
    assert.equal(tick.delay_end_countdown, 179)
    assert.equal(tick.initial_time, 89)
    assert.equal(tick.remaining_time, 89)

    const transition = update(mixedDelayToWash)
    assert.equal(transition.status, 'Washing')
    assert.equal(transition.previous_status, 'Delay Set')
    assert.equal(transition.delay_end_countdown, 'None')
    assert.equal(transition.initial_time, 89)
    assert.equal(transition.remaining_time, 89)
    assert.equal(transition.rinse_mode, 'Rinse+')

    const record = Buffer.from(mixedDelayTick.subarray(54, 93))
    record[15] = 60 // Invalid minutes must not leak through as a normalized value.
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.delay_end_countdown, 'None')
    record[15] = 59
    record[2] = 6 // Even if a wash frame still carries the old countdown, it is inactive.
    dev.processStatus(record)
    assert.equal(ha.devices[ID].properties.delay_end_countdown, 'None')
    assert.equal(ha.devices[ID].properties.remaining_time, 89)

    const ended = update(handWoolEnd)
    assert.equal(ended.remaining_time, 0)
    assert.equal(ended.initial_time, 36)
    assert.equal(ended.delay_end_countdown, 'None')
    assert.equal(update(off).delay_end_countdown, 'None')
    assert.equal(update(off).rinse_mode, 'None')
})

test('explicitly clears a retained delay countdown when a fresh driver first receives Washing', () => {
    const { update, dev, ha } = setup()
    // Simulate the previous driver's retained value surviving this driver's restart.
    ha.devices[ID].properties.delay_end_countdown = 114
    assert.equal(dev.publishCache.has('delay_end_countdown'), false)
    const state = update(mixedDelayToWash)
    assert.equal(state.status, 'Washing')
    assert.equal(state.delay_end_countdown, 'None')
    assert.equal(dev.publishCache.has('delay_end_countdown'), true)
    assert.equal(dev.publishCache.get('delay_end_countdown'), undefined)
})
