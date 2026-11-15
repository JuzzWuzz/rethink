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
const END = 10
const ACTIVE_CYCLE_STATES = new Set([4, 6, 7, 8])

const STATUS = Enum.of({
    Off: OFF,
    Standby: STANDBY,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    End: END,
})

// Model-specific: the shared table labels 0x04 Eco 40–60 instead of Cotton+.
// The Download dial position and its stored/active course are not mapped until observed on this model.
const COURSES = Enum.of({ Cotton: 0x01, 'Cotton+': 0x04, 'Tub Clean': 0x12, 'TurboWash 39': 0x31 })

export default class Device extends AABBDevice {
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
                    course: enumeration('Course', 'course', COURSES.options),
                    temp: enumeration('Water Temperature', 'temp', TEMPERATURES.options),
                    spin: enumeration('Spin Speed', 'spin', SPINS.options),
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
        const hasCycleTime = cycleActive || state === END
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('course', state === OFF ? undefined : COURSES.map(record[7]))
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
        this.publishCompletion(state, cycleActive)
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
