import HADevice from './base'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import { SPINS, TEMPERATURES } from './washer_common'
import { Enum } from '@/util/enum'
import { allowExtendedType } from '@/util/casting'

const OFF = 0
const STANDBY = 1
const DELAY_SET = 3
const DETECTING = 4
const SPINNING = 8
const END = 10
const ACTIVE_CYCLE_STATES = new Set([DETECTING, 6, 7, SPINNING])

const STATUS = Enum.of({
    Off: OFF,
    Standby: STANDBY,
    'Delay Set': DELAY_SET,
    'Detecting Load Level': DETECTING,
    Washing: 6,
    Rinsing: 7,
    Spinning: SPINNING,
    End: END,
    Error: 0x12,
})

// Model-specific: the shared table labels 0x04 Eco 40–60 instead of Cotton+.
const COURSES = Enum.of({
    Cotton: 0x01,
    'Cotton+': 0x04,
    'TurboWash 39': 0x31,
    'Mixed Fabric': 0x07,
    'Easy Care': 0x02,
    'Allergy Care': 0x2d,
    'Steam Refresh': 0x0d,
    'Download Cycle': [],
    'Tub Clean': 0x12,
    'Wash+Dry': 0x13,
    'Dry Only': [],
    'Speed 14': 0x0c,
    'Hand/Wool': 0x1b,
    Delicates: 0x20,
    'Spin Only': [],
})

const DRY_MODES = Enum.of({
    Off: 0x00,
    Normal: 0x02,
    '30 min': 0x03,
    '60 min': 0x04,
    '120 min': 0x06,
    'Iron Dry': 0x0a,
    'Low Temperature': 0x0b,
    'Normal Eco': 0x0c,
})

const RINSE_MODES = Enum.of({ 'Not selected': 0x00, Normal: 0x01, 'Rinse+': 0x02 })

const ERRORS = Enum.of({ OK: 0x00, 'Door open error (dE1)': 0x02 })

function courseName(record: Buffer) {
    const course = record[7]
    const dryMode = record[13]
    const activeDownload = record[22]
    // Only the observed active signatures identify the slot. Byte 25 can retain a saved
    // download on other dial positions, and the course code itself can match a native programme.
    if (
        (course === 0x17 && activeDownload === 0x79) ||
        (course === 0x18 &&
            ((activeDownload === 0x43 && dryMode === 0x03) || (activeDownload === 0x44 && dryMode === 0x04)))
    ) {
        return 'Download Cycle'
    }
    // Spin Only shares 0x01 with Cotton. A normal wash can clear rinse/temperature in its
    // final spin, so require a direct Standby -> Spinning transition for active reports.
    const state = record[2]
    if (
        course === 0x01 &&
        (state === STANDBY || (state === SPINNING && record[21] === STANDBY)) &&
        activeDownload === 0x00 &&
        record[10] > 0 &&
        SPINS.map(record[10]) !== undefined &&
        record[11] === 0x00 &&
        record[12] === 0x00 &&
        dryMode === 0x00
    ) {
        return 'Spin Only'
    }
    if (course !== 0x18) return COURSES.map(course)
    if (activeDownload === 0x00 && dryMode !== 0x00 && DRY_MODES.map(dryMode)) return 'Dry Only'
    return undefined
}

export default class Device extends AABBDevice {
    private spinOnlyRun = false
    private sawActiveCycle = false
    private runCompleted = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        const enumeration = (name: string, key: string, options: string[]) => ({
            platform: 'sensor' as const,
            device_class: 'enum' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            options,
        })
        const duration = (name: string, key: string) => ({
            platform: 'sensor' as const,
            device_class: 'duration' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            unit_of_measurement: 'min',
            name,
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    status: enumeration('Status', 'status', STATUS.options),
                    previous_status: enumeration('Previous status', 'previous_status', STATUS.options),
                    course: enumeration('Course', 'course', COURSES.options),
                    temp: enumeration('Water Temperature', 'temp', TEMPERATURES.options),
                    spin: enumeration('Spin Speed', 'spin', SPINS.options),
                    rinse_mode: enumeration('Rinse mode', 'rinse_mode', RINSE_MODES.options),
                    drying_mode: enumeration('Dry mode', 'drying_mode', DRY_MODES.options),
                    delay_end_setting: {
                        ...duration('Delay End setting', 'delay_end_setting'),
                        unit_of_measurement: 'h',
                    },
                    delay_end_countdown: duration('Delay End countdown', 'delay_end_countdown'),
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start armed',
                    },
                    error: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                    },
                    error_message: {
                        ...enumeration('Error message', 'error_message', ERRORS.options),
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Tub Clean Counter',
                    },
                    remaining_time: duration('Remaining time', 'remaining_time'),
                    initial_time: duration('Initial time', 'initial_time'),
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child Lock',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        device_class: 'lock',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, 0x20, 39, this.processStatus)
    }

    processStatus(record: Buffer) {
        const state = record[2]
        // Before starting, idle timer fields can show raw presets not displayed on the panel.
        const cycleActive = ACTIVE_CYCLE_STATES.has(state)
        const isDelaySet = state === DELAY_SET
        const hasCycleTime = cycleActive || isDelaySet || state === END
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('previous_status', hasCycleTime ? STATUS.map(record[21]) : undefined)
        this.publishCourse(record)
        // Both are selected programme settings, not measurements.
        this.publishProperty('temp', state === OFF ? undefined : TEMPERATURES.map(record[11]))
        this.publishProperty('spin', state === OFF ? undefined : SPINS.map(record[10]))
        // The number of cycles since Tub Clean remains valid while the washer is off and can reset to zero.
        this.publishProperty('tub_clean_count', record[23])
        this.publishProperty('remaining_time', hasCycleTime ? record[3] * 60 + record[4] : undefined)
        this.publishProperty('initial_time', hasCycleTime ? record[5] * 60 + record[6] : undefined)
        this.publishProperty('child_lock', record[17] & 0x80 ? 'ON' : 'OFF')
        // HA's lock binary sensor is OFF when locked. End does not itself imply unlocked.
        this.publishProperty('door_lock', record[17] & 0x40 ? 'OFF' : 'ON')
        this.publishProperty('rinse_mode', state === OFF ? undefined : RINSE_MODES.map(record[12]))
        this.publishProperty('drying_mode', state === OFF ? undefined : DRY_MODES.map(record[13]))
        // The same bytes store the whole-hour preset in Standby but count down in Delay Set.
        const delayHours = record[14]
        const delayMinutes = record[15]
        const countdown = delayHours * 60 + delayMinutes
        this.publishProperty(
            'delay_end_setting',
            state === STANDBY &&
                record[7] !== 0 &&
                delayMinutes === 0 &&
                (delayHours === 0 || (delayHours >= 3 && delayHours <= 19))
                ? delayHours
                : undefined,
        )
        this.publishProperty(
            'delay_end_countdown',
            isDelaySet && delayMinutes < 60 && countdown <= 19 * 60 ? countdown : undefined,
        )
        this.publishProperty('remote_start', state !== OFF && record[17] & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('error', state === 0x12 || record[8] !== 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(record[8]))
        this.publishCompletion(state, cycleActive)
    }

    private publishCourse(record: Buffer) {
        const state = record[2]
        const name = state === OFF ? undefined : courseName(record)
        const continuingSpinOnly =
            this.spinOnlyRun && record[7] === 0x01 && record[21] === SPINNING && (state === SPINNING || state === END)
        this.spinOnlyRun = (state === SPINNING && name === 'Spin Only') || continuingSpinOnly
        // An End-only snapshot can lack every distinguishing setting; don't guess Cotton.
        const ambiguousEnd =
            state === END && record[7] === 0x01 && record[21] === SPINNING && !this.sawActiveCycle && !this.runCompleted
        this.publishProperty('course', this.spinOnlyRun ? 'Spin Only' : ambiguousEnd ? undefined : name)
    }

    private publishCompletion(state: number, cycleActive: boolean) {
        // Memory-only: a first snapshot already at End must not trigger a new completion after restart.
        if (cycleActive) {
            this.sawActiveCycle = true
            this.runCompleted = false
        } else if (state === END && this.sawActiveCycle) {
            this.runCompleted = true
            this.sawActiveCycle = false
        } else if (state === STANDBY) {
            this.sawActiveCycle = false
            this.runCompleted = false
        } else if (state === OFF) {
            this.sawActiveCycle = false
            // Off (including opening the door) does not clear an observed completion.
        }
        this.publishProperty('run_completed', this.runCompleted ? 'ON' : 'OFF')
    }
}
